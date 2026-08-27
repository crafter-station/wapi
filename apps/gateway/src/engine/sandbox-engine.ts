/**
 * A fake WhatsApp, implementing the same `WhatsAppEngine` port as Baileys.
 *
 * Linking a real number is the highest-friction step in this product and the one that carries
 * the ban risk. This exists so a developer can build and test an integration end to end without
 * one — a fake number, a fake WhatsApp, the same request path.
 *
 * It implements the *port*, not a subset of it, and that is the design. Everything above the
 * gateway — the API, the webhook worker, the dashboard, all three SDKs — talks to this through
 * the same interface it uses for Baileys, so a sandbox session is a genuine rehearsal of
 * production rather than a separate code path that could diverge.
 *
 * **Derived, then mutable.** Identity and contacts are pure functions of the session id, so a
 * gateway restart returns a session to a known state and a test can assert `contacts[0].jid`
 * rather than "some contact". Groups start derived the same way but accept mutation, and the
 * conversation is recorded, because a fake where creating a group does not create a group is a
 * fake that teaches the wrong lesson. Both live in memory only: there is nothing here worth a
 * table, and a restart resetting a sandbox to its fixtures is a feature.
 *
 * Two deliberate divergences from production, both documented for callers:
 *
 *   - `account_protection` pacing is ignored. It protects a phone number from being banned, and
 *     a fake number cannot be. A test suite that waits five seconds per send is one people stop
 *     running.
 *   - `downloadMedia` returns a fixed PNG rather than failing, so the decrypt-then-fetch path
 *     stays whole. The alternative leaves a hole exactly where a real integration has code.
 */
import type { Logger } from "pino";
import type {
  ContactRecord,
  EngineEvent,
  EngineIdentity,
  GroupRecord,
  SendContent,
  SendOptions,
  SendResult,
  SessionStatus,
  WhatsAppEngine,
} from "@wapi/core";

/**
 * Country code 999 is unassigned by the ITU, so these numbers cannot route anywhere.
 *
 * A plausible-looking number would eventually be generated in a live range and belong to a real
 * person — someone will paste one of these into WhatsApp and try to message it. This is still
 * valid-shaped E.164, so it exercises the same parsing and JID-building code a real number does.
 */
const SANDBOX_CC = "999";

const pad = (n: number, width = 8) => String(n).padStart(width, "0");

/** The session's own number. Derived, never stored. */
export const sandboxNumber = (sessionId: number) => `+${SANDBOX_CC}${pad(sessionId)}`;

const jidFor = (sessionId: number) => `${SANDBOX_CC}${pad(sessionId)}@s.whatsapp.net`;
const lidFor = (sessionId: number) => `${900000000000 + sessionId}@lid`;

/**
 * A small fixed directory, deterministic per session.
 *
 * Five contacts and two groups: enough to exercise pagination, group metadata and participant
 * lists without pretending to be someone's real address book.
 */
const CONTACT_NAMES = ["Ada", "Grace", "Alan", "Edsger", "Barbara"] as const;

function contactsFor(sessionId: number): ContactRecord[] {
  return CONTACT_NAMES.map((name, i) => {
    const number = `${SANDBOX_CC}${pad(sessionId)}${pad(i + 1, 3)}`;
    return {
      jid: `${number}@s.whatsapp.net`,
      lid: `${910000000000 + sessionId * 100 + i}@lid`,
      name,
      notify: name,
      phoneNumber: `+${number}`,
    };
  });
}

function groupsFor(sessionId: number): GroupRecord[] {
  const own = jidFor(sessionId);
  const members = contactsFor(sessionId);
  return [
    {
      creation: 1700000000,
      desc: "A sandbox group. Nothing here reaches WhatsApp.",
      id: `${100000000000 + sessionId}-1@g.us`,
      owner: own,
      participants: [
        { admin: "superadmin", id: own },
        ...members.slice(0, 3).map((c) => ({ admin: null, id: c.jid })),
      ],
      subject: "Sandbox Team",
    },
    {
      creation: 1700000001,
      desc: null,
      id: `${100000000000 + sessionId}-2@g.us`,
      owner: members[0]!.jid,
      participants: [
        { admin: "superadmin", id: members[0]!.jid },
        { admin: null, id: own },
      ],
      subject: "Sandbox Announcements",
    },
  ];
}

/** A 1×1 transparent PNG. Small, valid, and obviously not real media. */
const FAKE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

/** How long the fake QR is shown before the session "pairs" itself. */
const AUTO_PAIR_MS = 4_000;

type Live = { status: SessionStatus; qr: string | null; timer?: NodeJS.Timeout };

/**
 * One line of the fake conversation.
 *
 * Recorded so the dashboard can show a sandbox as a chat rather than as a status field. wapi does
 * not store a real session's messages and this does not change that — a real phone keeps its own
 * history, and here the fake phone keeps its own too.
 */
export type ThreadEntry = {
  /** ISO 8601. */
  at: string;
  fromMe: boolean;
  id: string;
  /** The other party, always — the contact or group, never this session. */
  jid: string;
  kind: SendContent["kind"];
  /** A short human preview. Null for a kind that carries no text. */
  text: string | null;
};

/**
 * Bounded so a long-running gateway cannot accumulate without limit. Generous enough that a
 * developer scrolling their sandbox sees the whole session they are debugging.
 */
const THREAD_LIMIT = 200;

/** Everything a sandbox session accumulates while it is alive. */
type World = { groups: GroupRecord[]; thread: ThreadEntry[] };

export class SandboxEngine implements WhatsAppEngine {
  private readonly sessions = new Map<number, Live>();
  private readonly worlds = new Map<number, World>();
  private handler: ((e: EngineEvent) => void) | null = null;
  private counter = 0;

  /**
   * `assertSandbox` is supplied by the caller rather than queried here, so this class stays a
   * pure fake with no database of its own. The dispatcher passes a check against the `sandbox`
   * column.
   *
   * This is the dangerous direction. A real session routed here would receive a `msgId`, show as
   * sent in the dashboard and the audit log, and never leave the building. Failing loudly is the
   * entire reason this argument exists.
   */
  constructor(
    private readonly logger: Logger,
    private readonly assertSandbox: (sessionId: number) => Promise<void>,
  ) {}

  on(handler: (e: EngineEvent) => void) {
    this.handler = handler;
  }

  private emit(event: EngineEvent) {
    this.handler?.(event);
  }

  /** Lazily seeded from the derived fixtures, so an untouched session costs nothing. */
  private world(sessionId: number): World {
    let world = this.worlds.get(sessionId);
    if (!world) {
      world = { groups: groupsFor(sessionId), thread: [] };
      this.worlds.set(sessionId, world);
    }
    return world;
  }

  private record(sessionId: number, entry: ThreadEntry) {
    const { thread } = this.world(sessionId);
    thread.push(entry);
    if (thread.length > THREAD_LIMIT) thread.splice(0, thread.length - THREAD_LIMIT);
  }

  /**
   * The fake conversation, oldest first. Not part of `WhatsAppEngine` — a real engine has no
   * equivalent, because a real phone's history is not ours to read.
   */
  thread(sessionId: number): ThreadEntry[] {
    return [...this.world(sessionId).thread];
  }

  private setStatus(sessionId: number, status: SessionStatus) {
    const live = this.sessions.get(sessionId);
    if (live) live.status = status;
    this.emit({ sessionId, status, type: "status" });
  }

  /**
   * Pair, eventually.
   *
   * Deliberately not instant. The `need_scan → connected` transition drives the SSE stream, the
   * live QR in the dashboard and the `session.status` webhook — the parts most likely to break
   * and hardest to test. Skipping straight to connected would make the sandbox a worse rehearsal
   * than it can be for free.
   *
   * Idempotent per session, like the Baileys engine: connecting twice must not start two timers.
   */
  async connect(sessionId: number, _opts?: { accountProtection?: boolean }) {
    await this.assertSandbox(sessionId);
    const existing = this.sessions.get(sessionId);
    if (existing) return { qr: existing.qr ?? undefined, status: existing.status };

    const qr = `sandbox-qr-${sessionId}-${pad(Date.now() % 100000000)}`;
    const live: Live = { qr, status: "need_scan" };
    this.sessions.set(sessionId, live);

    this.emit({ qr, sessionId, type: "qr" });
    this.setStatus(sessionId, "need_scan");

    live.timer = setTimeout(() => this.scan(sessionId), AUTO_PAIR_MS);
    this.logger.info({ sessionId }, "sandbox session awaiting scan");
    return { qr, status: "need_scan" as SessionStatus };
  }

  /**
   * Complete pairing. Called by the auto-pair timer, or explicitly to test the waiting state.
   */
  scan(sessionId: number) {
    const live = this.sessions.get(sessionId);
    if (!live || live.status === "connected") return;
    if (live.timer) clearTimeout(live.timer);
    live.qr = null;
    this.emit({
      jid: jidFor(sessionId),
      lid: lidFor(sessionId),
      name: "Sandbox",
      sessionId,
      type: "identity",
    });
    this.setStatus(sessionId, "connected");
    this.logger.info({ sessionId }, "sandbox session connected");
  }

  async disconnect(sessionId: number) {
    const live = this.sessions.get(sessionId);
    if (live?.timer) clearTimeout(live.timer);
    this.sessions.delete(sessionId);
    this.setStatus(sessionId, "disconnected");
  }

  async restart(sessionId: number) {
    await this.disconnect(sessionId);
    return { status: (await this.connect(sessionId)).status };
  }

  /**
   * Unlink, and forget.
   *
   * `disconnect` and `restart` keep the world, because a phone whose socket dropped still has its
   * chats. Logout is the deliberate reset — the only way back to the fixtures without restarting
   * the gateway, and the thing to reach for when a sandbox has accumulated a confusing history.
   */
  async logout(sessionId: number) {
    await this.disconnect(sessionId);
    this.worlds.delete(sessionId);
    this.setStatus(sessionId, "logged_out");
  }

  status(sessionId: number): SessionStatus {
    return this.sessions.get(sessionId)?.status ?? "disconnected";
  }

  currentQr(sessionId: number): string | null {
    return this.sessions.get(sessionId)?.qr ?? null;
  }

  identity(sessionId: number): EngineIdentity | null {
    if (this.status(sessionId) !== "connected") return null;
    return { id: jidFor(sessionId), lid: lidFor(sessionId), name: "Sandbox" };
  }

  /** Everything below refuses on a session that has not "connected", as the real engine does. */
  private require(sessionId: number) {
    if (this.status(sessionId) !== "connected") {
      throw new Error(`sandbox session ${sessionId} is not connected`);
    }
  }

  private nextKeyId() {
    this.counter += 1;
    return `SANDBOX${pad(this.counter, 10)}`;
  }

  async sendText(sessionId: number, to: string, text: string, opts?: SendOptions) {
    return this.send(sessionId, to, { kind: "text", text }, opts);
  }

  /**
   * Accept a send and echo it as an outbound event.
   *
   * `account_protection` is not honoured here — see the class comment.
   */
  async send(
    sessionId: number,
    to: string,
    content: SendContent,
    _opts?: SendOptions,
  ): Promise<SendResult> {
    this.require(sessionId);
    const remoteJid = to.includes("@") ? to : `${to.replace(/[^\d]/g, "")}@s.whatsapp.net`;
    const key = { fromMe: true, id: this.nextKeyId(), remoteJid };

    this.record(sessionId, {
      at: new Date().toISOString(),
      fromMe: true,
      id: key.id,
      jid: remoteJid,
      kind: content.kind,
      text: previewOf(content),
    });

    // The same event a real send produces, so the webhook pipeline behaves identically.
    this.emit({
      event: "messages.upsert",
      payload: { messages: [{ key, message: contentToNode(content) }], type: "notify" },
      sessionId,
      type: "wa",
    });

    return { key, remoteJid, waKeyId: key.id };
  }

  async reactToMessage(sessionId: number, key: Record<string, unknown>, emoji: string) {
    this.require(sessionId);
    const id = this.nextKeyId();
    this.emit({
      event: "messages.reaction",
      payload: { key, reaction: { key, text: emoji } },
      sessionId,
      type: "wa",
    });
    return { id };
  }

  async readMessages(sessionId: number, _keys: Record<string, unknown>[]) {
    this.require(sessionId);
  }

  /** A fixed PNG rather than a failure, so decrypt-then-fetch works end to end. */
  async downloadMedia(sessionId: number, _message: Record<string, unknown>) {
    this.require(sessionId);
    return { data: FAKE_PNG, fileName: "sandbox.png", mimetype: "image/png" };
  }

  async onWhatsApp(sessionId: number, identifier: string) {
    this.require(sessionId);
    const digits = identifier.replace(/[^\d]/g, "");
    // Anything in the sandbox range exists; nothing else does.
    const exists = digits.startsWith(SANDBOX_CC);
    return { exists, jid: exists ? `${digits}@s.whatsapp.net` : null };
  }

  async contacts(sessionId: number) {
    this.require(sessionId);
    return contactsFor(sessionId);
  }

  async syncContacts(sessionId: number) {
    this.require(sessionId);
    // Nothing to resync — the directory is derived, not accumulated. Emitting the upsert keeps
    // the contact-caching path in the worker exercised.
    this.emit({
      event: "contacts.upsert",
      payload: contactsFor(sessionId).map((c) => ({ id: c.jid, notify: c.notify })),
      sessionId,
      type: "wa",
    });
  }

  async contact(sessionId: number, jid: string) {
    this.require(sessionId);
    return contactsFor(sessionId).find((c) => c.jid === jid) ?? null;
  }

  async lidFromPn(sessionId: number, pn: string) {
    this.require(sessionId);
    const digits = pn.replace(/[^\d]/g, "");
    if (digits === `${SANDBOX_CC}${pad(sessionId)}`) return lidFor(sessionId);
    return contactsFor(sessionId).find((c) => c.phoneNumber?.replace(/[^\d]/g, "") === digits)?.lid ?? null;
  }

  async pnFromLid(sessionId: number, lid: string) {
    this.require(sessionId);
    if (lid === lidFor(sessionId)) return sandboxNumber(sessionId);
    return contactsFor(sessionId).find((c) => c.lid === lid)?.phoneNumber ?? null;
  }

  async groups(sessionId: number) {
    this.require(sessionId);
    return this.world(sessionId).groups;
  }

  async groupMetadata(sessionId: number, jid: string) {
    this.require(sessionId);
    return this.world(sessionId).groups.find((g) => g.id === jid) ?? null;
  }

  async createGroup(sessionId: number, subject: string, participants: string[]): Promise<GroupRecord> {
    this.require(sessionId);
    /**
     * Kept, so `POST /api/groups` then `GET /api/groups` behaves the way anyone would expect.
     *
     * This used to return a correctly-shaped group that `groups()` never listed. The shape was
     * right and the behaviour was wrong, and "create a group, then list groups" is the first
     * thing a person writes when trying the endpoint — so the fake taught them something untrue
     * about the real one. Lives for the life of the gateway process; a restart returns the
     * session to its fixtures.
     */
    const group: GroupRecord = {
      creation: Math.floor(Date.now() / 1000),
      desc: null,
      id: `${100000000000 + sessionId}-${this.nextKeyId()}@g.us`,
      owner: jidFor(sessionId),
      participants: [
        { admin: "superadmin", id: jidFor(sessionId) },
        ...participants.map((p) => ({ admin: null, id: p })),
      ],
      subject,
    };
    this.world(sessionId).groups.push(group);
    return group;
  }

  /**
   * Apply a participant change to the stored group.
   *
   * Per-participant `status` mirrors WhatsApp's own reporting rather than a blanket 200: adding
   * somebody already in the group, or removing somebody who is not, is a no-op there and reports
   * 409 — and a caller that only ever sees 200 will never write the branch that handles it.
   */
  async updateParticipants(
    sessionId: number,
    jid: string,
    participants: string[],
    action: "add" | "remove" | "promote" | "demote",
  ) {
    this.require(sessionId);
    const group = this.world(sessionId).groups.find((g) => g.id === jid);
    if (!group) throw new Error(`sandbox group ${jid} not found`);

    return participants.map((participant) => {
      const existing = group.participants.find((p) => p.id === participant);
      switch (action) {
        case "add":
          if (existing) return { jid: participant, status: "409" };
          group.participants.push({ admin: null, id: participant });
          return { jid: participant, status: "200" };
        case "remove":
          if (!existing) return { jid: participant, status: "404" };
          group.participants = group.participants.filter((p) => p.id !== participant);
          return { jid: participant, status: "200" };
        default: {
          if (!existing) return { jid: participant, status: "404" };
          existing.admin = action === "promote" ? "admin" : null;
          return { jid: participant, status: "200" };
        }
      }
    });
  }

  /**
   * Fabricate an inbound message, as if somebody had written to this number.
   *
   * The sandbox's real payload: what a developer cannot test today is whether their webhook
   * handler works. This produces the same `messages.upsert` a real inbound message does, so it
   * travels the ordinary pipeline and arrives signed.
   *
   * Not part of `WhatsAppEngine` — it is a sandbox control, reached through the dispatcher.
   */
  inbound(sessionId: number, from: string | undefined, text: string) {
    this.require(sessionId);
    const sender = from ?? contactsFor(sessionId)[0]!.jid;
    const key = { fromMe: false, id: this.nextKeyId(), remoteJid: sender };

    this.record(sessionId, {
      at: new Date().toISOString(),
      fromMe: false,
      id: key.id,
      jid: sender,
      kind: "text",
      text,
    });
    this.emit({
      event: "messages.upsert",
      payload: {
        messages: [{ key, message: { conversation: text }, pushName: "Sandbox Contact" }],
        type: "notify",
      },
      sessionId,
      type: "wa",
    });
    return { key };
  }
}

/** A one-line human preview for the dashboard. Null where the kind carries no text of its own. */
function previewOf(content: SendContent): string | null {
  switch (content.kind) {
    case "text":
      return content.text;
    case "image":
    case "video":
    case "document":
      return content.caption ?? null;
    case "location":
      return content.name ?? `${content.latitude}, ${content.longitude}`;
    case "contact":
      return content.displayName;
    case "poll":
      return content.question;
    default:
      return null;
  }
}

/** Shape a send back into the Baileys message node the webhook pipeline expects. */
function contentToNode(content: SendContent): Record<string, unknown> {
  switch (content.kind) {
    case "text":
      return { conversation: content.text };
    case "image":
      return { imageMessage: { caption: content.caption, url: content.url } };
    case "video":
      return { videoMessage: { caption: content.caption, url: content.url } };
    case "audio":
      return { audioMessage: { url: content.url } };
    case "document":
      return { documentMessage: { fileName: content.fileName, url: content.url } };
    case "sticker":
      return { stickerMessage: { url: content.url } };
    case "location":
      return {
        locationMessage: {
          degreesLatitude: content.latitude,
          degreesLongitude: content.longitude,
          name: content.name,
        },
      };
    case "contact":
      return { contactMessage: { displayName: content.displayName, vcard: content.vcard } };
    case "poll":
      return {
        pollCreationMessage: {
          name: content.question,
          options: content.options.map((o) => ({ optionName: o })),
        },
      };
  }
}
