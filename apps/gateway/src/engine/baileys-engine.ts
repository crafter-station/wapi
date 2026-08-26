/**
 * Baileys implementation of `WhatsAppEngine`.
 *
 * Everything hard about this file comes from one fact (PLAN.md §2): a WhatsApp session is a
 * WebSocket owned by exactly one process, and two live sockets on one session escalates to a
 * WhatsApp restriction. So the registry below is authoritative and every entry point is
 * guarded against opening a second socket for the same id.
 */
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  downloadContentFromMessage,
} from "baileys";
import type { ConnectionState, WASocket } from "baileys";
import type { Boom } from "@hapi/boom";
import type { Logger } from "pino";
import { usePostgresAuthState } from "@wapi/baileys-auth";
import { contacts, type Db } from "@wapi/db";
import { and, eq } from "drizzle-orm";
import type {
  WhatsAppEngine,
  EngineEvent,
  SessionStatus,
  SendResult,
  EngineIdentity,
  ContactRecord,
  GroupRecord,
  SendContent,
  SendOptions,
} from "@wapi/core";

/** Baileys events forwarded verbatim; their names are already our public webhook names. */
const FORWARDED = [
  "messages.upsert",
  "messages.update",
  "messages.delete",
  "messages.reaction",
  "message-receipt.update",
  "chats.upsert",
  "chats.update",
  "chats.delete",
  "contacts.upsert",
  "contacts.update",
  "groups.upsert",
  "groups.update",
  "group-participants.update",
  "call",
] as const;

type Entry = {
  sock: WASocket;
  status: SessionStatus;
  qr: string | null;
  identity: EngineIdentity | null;
  /** Guards `account_protection` pacing. */
  lastSendAt: number;
  accountProtection: boolean;
  /** Set while we are closing on purpose, so the close handler does not auto-reconnect. */
  closing: boolean;
};

export class BaileysEngine implements WhatsAppEngine {
  private readonly sessions = new Map<number, Entry>();
  private readonly starting = new Set<number>();
  private handlers: ((e: EngineEvent) => void)[] = [];

  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  on(handler: (e: EngineEvent) => void) {
    this.handlers.push(handler);
  }

  private emit(e: EngineEvent) {
    for (const h of this.handlers) {
      try {
        h(e);
      } catch (err) {
        this.logger.error({ err }, "engine event handler threw");
      }
    }
  }

  private setStatus(sessionId: number, status: SessionStatus) {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.status = status;
    this.emit({ type: "status", sessionId, status });
  }

  status(sessionId: number): SessionStatus {
    return this.sessions.get(sessionId)?.status ?? "disconnected";
  }

  currentQr(sessionId: number): string | null {
    return this.sessions.get(sessionId)?.qr ?? null;
  }

  identity(sessionId: number): EngineIdentity | null {
    return this.sessions.get(sessionId)?.identity ?? null;
  }

  /**
   * Idempotent by design.
   *
   * If ANY entry exists for this session — connected, connecting, or waiting on a scan — this
   * returns its current state instead of opening another socket. Previously only `connected`
   * short-circuited, so pressing Connect while a QR was on screen opened a *second* socket:
   * both rotated their own QR codes, the browser displayed whichever arrived last, and
   * scanning it produced "can't log in" on the phone because that code belonged to a socket
   * the other one had superseded.
   *
   * That is also precisely the hazard PLAN.md §2 says escalates to a WhatsApp restriction, so
   * this guard is a safety property, not a nicety. Use `restart` to force a fresh socket.
   */
  async connect(sessionId: number, opts: { accountProtection?: boolean } = {}) {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return { status: existing.status, qr: existing.qr ?? undefined };
    }
    if (this.starting.has(sessionId)) {
      return { status: this.status(sessionId), qr: this.currentQr(sessionId) ?? undefined };
    }
    this.starting.add(sessionId);
    try {
      await this.open(sessionId, opts.accountProtection ?? false);
      // Give WhatsApp a moment to emit the first QR so `connect` can return it inline,
      // which is what their documented response does.
      await new Promise((r) => setTimeout(r, 1500));
      return { status: this.status(sessionId), qr: this.currentQr(sessionId) ?? undefined };
    } finally {
      this.starting.delete(sessionId);
    }
  }

  private async open(sessionId: number, accountProtection: boolean) {
    /**
     * Defence in depth: never leave an old socket running for this session. Callers are
     * guarded, but a stray socket here is a restriction risk rather than a leak, so the
     * teardown is unconditional.
     */
    const stale = this.sessions.get(sessionId);
    if (stale) {
      stale.closing = true;
      this.sessions.delete(sessionId);
      await stale.sock.end(undefined).catch(() => {});
    }

    const auth = await usePostgresAuthState(this.db, String(sessionId));
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: auth.state.creds,
        // Auth reads sit inside Baileys' per-socket ordering mutexes, so a slow round-trip
        // stalls the whole inbound pipeline for this session (PLAN.md §4).
        keys: makeCacheableSignalKeyStore(auth.state.keys, this.logger),
      },
      logger: this.logger,
      // v7 silently flipped this to true and it is not in the migration guide (PLAN.md §5).
      syncFullHistory: false,
      // WIN32/DARWIN draw a 428 before any QR appears (Baileys #2677).
      browser: Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
    });

    const entry: Entry = {
      sock,
      status: auth.isPaired() ? "connecting" : "need_scan",
      qr: null,
      identity: null,
      lastSendAt: 0,
      accountProtection,
      closing: false,
    };
    this.sessions.set(sessionId, entry);

    sock.ev.on("creds.update", auth.saveCreds);

    sock.ev.on("connection.update", (u: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = u;

      if (qr) {
        entry.qr = qr;
        this.setStatus(sessionId, "need_scan");
        this.emit({ type: "qr", sessionId, qr });
      }

      if (connection === "connecting") this.setStatus(sessionId, "connecting");

      if (connection === "open") {
        entry.qr = null;
        entry.identity = {
          id: jidNormalizedUser(sock.user!.id),
          name: sock.user?.name ?? null,
          lid: sock.user?.lid ?? null,
        };
        this.setStatus(sessionId, "connected");
        this.emit({ type: "identity", sessionId, ...entry.identity, jid: entry.identity.id });
      }

      if (connection === "close") {
        const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;

        if (entry.closing) {
          this.sessions.delete(sessionId);
          this.setStatus(sessionId, "disconnected");
          return;
        }

        /**
         * 515 is a SUCCESSFUL pair, not a failure: WhatsApp accepts the scan, errors the
         * stream, and requires a reconnect with the credentials it just issued. Reading it
         * as a refusal is the single easiest way to conclude pairing is broken when it is not.
         */
        if (code === DisconnectReason.restartRequired) {
          this.logger.info({ sessionId }, "515 restart required — reconnecting");
          this.sessions.delete(sessionId);
          void this.open(sessionId, accountProtection);
          return;
        }

        if (code === DisconnectReason.loggedOut) {
          this.sessions.delete(sessionId);
          this.setStatus(sessionId, "logged_out");
          return;
        }

        this.sessions.delete(sessionId);
        this.setStatus(sessionId, "disconnected");
      }
    });

    for (const name of FORWARDED) {
      sock.ev.on(name as never, (payload: unknown) => {
        this.emit({ type: "wa", sessionId, event: name, payload });
      });
    }
  }

  async disconnect(sessionId: number) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.closing = true;
    await entry.sock.end(undefined);
    this.sessions.delete(sessionId);
    this.setStatus(sessionId, "disconnected");
  }

  async restart(sessionId: number) {
    await this.disconnect(sessionId);
    return this.connect(sessionId);
  }

  async logout(sessionId: number) {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.closing = true;
      await entry.sock.logout().catch(() => {});
      this.sessions.delete(sessionId);
    }
    const auth = await usePostgresAuthState(this.db, String(sessionId));
    await auth.clearAll();
    this.setStatus(sessionId, "logged_out");
  }


  /** Every operation below needs a live socket; there is no offline fallback. */
  private live(sessionId: number) {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.status !== "connected") throw new SessionNotConnectedError();
    return entry;
  }

  /**
   * The media kinds their `decrypt-media` documentation names, mapped to the download type
   * Baileys expects. Order matters only for determinism.
   */
  private static readonly MEDIA_KINDS = [
    ["imageMessage", "image"],
    ["videoMessage", "video"],
    ["audioMessage", "audio"],
    ["documentMessage", "document"],
    ["stickerMessage", "sticker"],
  ] as const;

  async downloadMedia(sessionId: number, message: Record<string, unknown>) {
    this.live(sessionId);
    for (const [field, kind] of BaileysEngine.MEDIA_KINDS) {
      const node = message[field] as Record<string, unknown> | undefined;
      if (!node) continue;

      const stream = await downloadContentFromMessage(node as never, kind as never);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);

      const mimetype = String(node["mimetype"] ?? "application/octet-stream");
      const fileName =
        (node["fileName"] as string) ?? `${field.replace("Message", "")}.${extFor(mimetype)}`;
      return { data: Buffer.concat(chunks), mimetype, fileName };
    }
    return null;
  }

  async readMessages(sessionId: number, keys: Record<string, unknown>[]) {
    await this.live(sessionId).sock.readMessages(keys as never);
  }

  /**
   * Reactions are ordinary messages carrying a `react` node, not a separate protocol verb.
   *
   * They are addressed to the *chat* the target lives in, so `key.remoteJid` is the recipient
   * — reacting in a group means sending to the group, with the key identifying whose message
   * inside it is being reacted to.
   *
   * An empty string is WhatsApp's own convention for removing a reaction rather than a
   * separate call, so it is passed through untouched instead of being rejected as blank.
   */
  async reactToMessage(sessionId: number, key: Record<string, unknown>, emoji: string) {
    const chat = String(key["remoteJid"] ?? "");
    if (!chat) throw new Error("key.remoteJid is required to react");
    const sent = await this.live(sessionId).sock.sendMessage(chat, {
      react: { key: key as never, text: emoji },
    });
    return { id: sent?.key?.id ?? null };
  }

  /**
   * v7 removed LIDs from `onWhatsApp()` results, which is part of why the LID routes were
   * promoted into Tier 1 — the mapping has to come from `lidFromPn` instead (PLAN.md §1).
   */
  async onWhatsApp(sessionId: number, identifier: string) {
    const res = await this.live(sessionId).sock.onWhatsApp(identifier);
    const hit = res?.[0];
    return { exists: Boolean(hit?.exists), jid: hit?.jid ?? null };
  }

  /**
   * Contacts come from the database, not the socket.
   *
   * Baileys v7 removed the in-memory store, so there is no `sock.store` to ask. The only
   * source is the `contacts.upsert` / `contacts.update` event stream, which the webhook
   * worker persists into the `contacts` table. Returning an empty array from a socket that
   * simply cannot answer would be a silent lie.
   */
  async contacts(sessionId: number): Promise<ContactRecord[]> {
    this.live(sessionId);
    const rows = await this.db
      .select()
      .from(contacts)
      .where(eq(contacts.sessionId, sessionId))
      .orderBy(contacts.jid);
    return rows.map((r) => ({
      jid: r.jid,
      name: r.name,
      notify: r.notify,
      phoneNumber: r.phoneNumber,
      lid: r.lid,
    }));
  }

  /**
   * Force an app-state resync so `contacts.upsert` is re-emitted.
   *
   * Needed because Baileys skips app-state sync on a reconnect that already has sync data —
   * the log line is "Reconnection with existing sync data, skipping history sync wait". A
   * session paired before the contacts cache existed therefore never populates it.
   *
   * MEASURED LIMITATION: on a session paired before this cache existed, resyncAppState
   * returns cleanly and emits nothing — verified with an event tap, with isInitialSync both
   * false and true. Contacts reach Baileys through the history-sync notification on a *fresh
   * pair*, and reconnects skip that entirely. There is no backfill path for an old session,
   * which is why `contacts.upsert` is only half the story and the worker also derives
   * contacts from observed traffic.
   *
   * Kept because it is correct for sessions that do have pending app-state patches, and
   * explicit rather than automatic because unnecessary chatter is what unofficial clients
   * get penalised for (PLAN.md §5).
   */
  async syncContacts(sessionId: number): Promise<void> {
    const entry = this.live(sessionId);
    const sock = entry.sock as unknown as {
      resyncAppState?: (c: readonly string[], initial: boolean) => Promise<void>;
    };
    await sock.resyncAppState?.(["critical_unblock_low", "regular_high", "regular_low"], false);
  }

  async contact(sessionId: number, jid: string): Promise<ContactRecord | null> {
    this.live(sessionId);
    const [r] = await this.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.sessionId, sessionId), eq(contacts.jid, jid)))
      .limit(1);
    return r
      ? { jid: r.jid, name: r.name, notify: r.notify, phoneNumber: r.phoneNumber, lid: r.lid }
      : null;
  }

  async lidFromPn(sessionId: number, pn: string): Promise<string | null> {
    const repo = (this.live(sessionId).sock as unknown as {
      signalRepository?: { lidMapping?: { getLIDForPN?: (pn: string) => Promise<string | undefined> } };
    }).signalRepository;
    return (await repo?.lidMapping?.getLIDForPN?.(pn)) ?? null;
  }

  /**
   * One-way in practice: `getPNForLID` only succeeds for pairs already cached from inbound
   * traffic, so a miss here is legitimate rather than an error (PLAN.md §1).
   */
  async pnFromLid(sessionId: number, lid: string): Promise<string | null> {
    const repo = (this.live(sessionId).sock as unknown as {
      signalRepository?: { lidMapping?: { getPNForLID?: (lid: string) => Promise<string | undefined> } };
    }).signalRepository;
    return (await repo?.lidMapping?.getPNForLID?.(lid)) ?? null;
  }

  async groups(sessionId: number): Promise<GroupRecord[]> {
    const all = await this.live(sessionId).sock.groupFetchAllParticipating();
    return Object.values(all).map((g) => toGroup(g as unknown as Record<string, unknown>));
  }

  async groupMetadata(sessionId: number, jid: string): Promise<GroupRecord | null> {
    const md = await this.live(sessionId).sock.groupMetadata(jid).catch(() => null);
    return md ? toGroup(md as unknown as Record<string, unknown>) : null;
  }

  async createGroup(sessionId: number, subject: string, participants: string[]): Promise<GroupRecord> {
    const md = await this.live(sessionId).sock.groupCreate(subject, participants);
    return toGroup(md as unknown as Record<string, unknown>);
  }

  /**
   * Group participant changes are the highest behavioural ban risk in the research — above
   * send volume, and the only trigger with quasi-experimental support (PLAN.md §5).
   */
  async updateParticipants(
    sessionId: number,
    jid: string,
    participants: string[],
    action: "add" | "remove" | "promote" | "demote",
  ) {
    const res = await this.live(sessionId).sock.groupParticipantsUpdate(jid, participants, action);
    return (res ?? []).map((r) => ({ jid: String(r.jid ?? ""), status: String(r.status ?? "") }));
  }

  /** Text is the common case; it delegates to the same path as everything else. */
  async sendText(sessionId: number, to: string, text: string, opts: SendOptions = {}) {
    return this.send(sessionId, to, { kind: "text", text }, opts);
  }

  /**
   * The polymorphic send.
   *
   * Their API documents fourteen variants of one route, so this is one method rather than
   * fourteen. `mentions` and `viewOnce` are modifiers that ride along with any content kind,
   * which is exactly how the documented field union behaves.
   */
  async send(
    sessionId: number,
    to: string,
    content: SendContent,
    opts: SendOptions = {},
  ): Promise<SendResult> {
    const entry = this.live(sessionId);

    /**
     * `account_protection` pacing — the one rate limit implemented for real (PLAN.md §1).
     *
     * It is not protecting the server from users; it protects the phone number from
     * WhatsApp's ban heuristics, and a banned number is the one resource here that cannot
     * just be redeployed.
     */
    if (entry.accountProtection) {
      const wait = 5000 - (Date.now() - entry.lastSendAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    entry.lastSendAt = Date.now();

    const body = toBaileysContent(content, opts);
    const sent = await entry.sock.sendMessage(
      to,
      body as never,
      // Baileys wants a whole WAMessage to quote, not just a key.
      opts.quoted ? ({ quoted: opts.quoted } as never) : undefined,
    );
    if (!sent?.key.id) throw new Error("send produced no message key");

    return {
      waKeyId: sent.key.id,
      remoteJid: String(sent.key.remoteJid ?? to),
      key: sent.key as unknown as Record<string, unknown>,
    };
  }
}

/**
 * Map our content union onto Baileys' message shapes.
 *
 * Media is passed by URL: Baileys fetches and encrypts it itself, which avoids buffering the
 * whole file through this process.
 */
function toBaileysContent(c: SendContent, opts: SendOptions): Record<string, unknown> {
  // Modifiers that apply regardless of kind.
  const extra: Record<string, unknown> = {};
  if (opts.mentions?.length) extra["mentions"] = opts.mentions;
  if (opts.viewOnce) extra["viewOnce"] = true;

  switch (c.kind) {
    case "text":
      return { text: c.text, ...extra };
    case "image":
      return { image: { url: c.url }, caption: c.caption, ...extra };
    case "video":
      return { video: { url: c.url }, caption: c.caption, ...extra };
    case "audio":
      // ptt renders it as a voice note, which is what their docs describe for audioUrl.
      return { audio: { url: c.url }, ptt: true, mimetype: "audio/ogg; codecs=opus", ...extra };
    case "document":
      return {
        document: { url: c.url },
        fileName: c.fileName ?? "document",
        caption: c.caption,
        ...extra,
      };
    case "sticker":
      return { sticker: { url: c.url }, ...extra };
    case "location":
      return {
        location: {
          degreesLatitude: c.latitude,
          degreesLongitude: c.longitude,
          name: c.name,
          address: c.address,
        },
        ...extra,
      };
    case "contact":
      return { contacts: { displayName: c.displayName, contacts: [{ vcard: c.vcard }] }, ...extra };
    case "poll":
      return {
        poll: {
          name: c.question,
          values: c.options,
          selectableCount: c.multiSelect ? c.options.length : 1,
        },
        ...extra,
      };
  }
}

export class SessionNotConnectedError extends Error {
  constructor() {
    super("Your Whatsapp Session is not connected please connect your session first.");
    this.name = "SessionNotConnectedError";
  }
}

function toGroup(g: Record<string, unknown>): GroupRecord {
  const parts = (g["participants"] as { id?: string; admin?: string | null }[] | undefined) ?? [];
  return {
    id: String(g["id"] ?? ""),
    subject: String(g["subject"] ?? ""),
    owner: (g["owner"] as string) ?? null,
    creation: (g["creation"] as number) ?? null,
    desc: (g["desc"] as string) ?? null,
    participants: parts.map((p) => ({ id: String(p.id ?? ""), admin: p.admin ?? null })),
  };
}

/** Best-effort extension from a mimetype, for the fallback filename. */
function extFor(mimetype: string): string {
  const sub = mimetype.split("/")[1] ?? "bin";
  return sub.split(";")[0]!.replace("jpeg", "jpg").replace("mpeg", "mp3");
}
