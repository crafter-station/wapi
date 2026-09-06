import { describe, expect, test } from "bun:test";
import pino from "pino";
import { SandboxEngine, sandboxNumber } from "./sandbox-engine.js";
import type { EngineEvent } from "@wapi/core";

/**
 * The fake, tested as an implementation of the port rather than as a class.
 *
 * What matters is that it is indistinguishable from Baileys through `WhatsAppEngine` — same
 * lifecycle, same events, same refusals — because everything above the gateway assumes exactly
 * that. A fake that behaves differently is a sandbox that rehearses the wrong thing.
 */
const silent = pino({ level: "silent" });

/** A permissive assert, so most tests exercise behaviour rather than the guard. */
const engineFor = (allow = true) => {
  const events: EngineEvent[] = [];
  const engine = new SandboxEngine(silent, async (sessionId) => {
    if (!allow) throw new Error(`session ${sessionId} is not a sandbox session`);
  });
  engine.on((e) => events.push(e));
  return { engine, events };
};

const connected = async (sessionId = 3) => {
  const { engine, events } = engineFor();
  await engine.connect(sessionId);
  engine.scan(sessionId); // skip the timer rather than waiting on it
  return { engine, events };
};

describe("the guard", () => {
  /**
   * The dangerous direction, and the reason the constructor takes a check at all.
   *
   * A real session routed here would receive a msgId, show as sent in the dashboard and the
   * audit log, and never leave the building. Nothing downstream could detect it.
   */
  test("refuses a session that is not marked sandbox", async () => {
    const { engine } = engineFor(false);
    await expect(engine.connect(7)).rejects.toThrow("not a sandbox session");
  });

  test("and refuses before creating any state for it", async () => {
    const { engine, events } = engineFor(false);
    await engine.connect(7).catch(() => {});
    expect(events).toEqual([]);
    expect(engine.status(7)).toBe("disconnected");
  });
});

describe("pairing", () => {
  test("shows a QR and waits, rather than connecting instantly", async () => {
    const { engine, events } = engineFor();
    const result = await engine.connect(3);
    expect(result.status).toBe("need_scan");
    expect(result.qr).toBeTruthy();
    // The dashboard's live view and the session.status webhook both hang off these.
    expect(events.map((e) => e.type)).toEqual(["qr", "status"]);
  });

  test("scanning connects and announces an identity", async () => {
    const { engine, events } = await connected(3);
    expect(engine.status(3)).toBe("connected");
    const identity = events.find((e) => e.type === "identity");
    expect(identity).toMatchObject({ jid: "99900000003@s.whatsapp.net", type: "identity" });
    // The QR must clear, or the dashboard keeps rendering a stale one.
    expect(engine.currentQr(3)).toBeNull();
  });

  test("connect is idempotent, as the Baileys engine is", async () => {
    const { engine } = engineFor();
    const first = await engine.connect(3);
    const second = await engine.connect(3);
    // A second connect must not start a second pairing timer or rotate the QR.
    expect(second.qr).toBe(first.qr!);
  });

  test("the number is in an unassigned range so it cannot route anywhere", () => {
    expect(sandboxNumber(3)).toBe("+99900000003");
    // ITU country code 999 is unassigned: a plausible number would eventually belong to someone.
    expect(sandboxNumber(3).startsWith("+999")).toBe(true);
  });
});

describe("before connecting", () => {
  test("every operation refuses, exactly as a real unconnected session does", async () => {
    const { engine } = engineFor();
    await expect(engine.contacts(3)).rejects.toThrow("not connected");
    await expect(engine.groups(3)).rejects.toThrow("not connected");
    await expect(engine.send(3, "+99900000003001", { kind: "text", text: "x" })).rejects.toThrow();
  });
});

describe("the derived directory", () => {
  test("is deterministic, so a test can assert an exact jid", async () => {
    const { engine } = await connected(3);
    const contacts = await engine.contacts(3);
    expect(contacts).toHaveLength(5);
    expect(contacts[0]).toMatchObject({ jid: "99900000003001@s.whatsapp.net", name: "Ada" });
  });

  test("does not depend on instance state, so a restart is invisible", async () => {
    const a = await connected(3);
    const b = await connected(3);
    expect(await a.engine.contacts(3)).toEqual(await b.engine.contacts(3));
  });

  test("differs per session, so two sandboxes do not collide", async () => {
    const three = await connected(3);
    const four = await connected(4);
    const [c3] = await three.engine.contacts(3);
    const [c4] = await four.engine.contacts(4);
    expect(c3!.jid).not.toBe(c4!.jid);
  });

  test("groups carry participants and the session itself owns the first", async () => {
    const { engine } = await connected(3);
    const groups = await engine.groups(3);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.owner).toBe("99900000003@s.whatsapp.net");
    expect(groups[0]!.participants.length).toBeGreaterThan(1);
    // Metadata must agree with the listing, or paging into a group breaks.
    expect(await engine.groupMetadata(3, groups[0]!.id)).toEqual(groups[0]!);
  });

  test("LID and phone number resolve both ways, and only for known identities", async () => {
    const { engine } = await connected(3);
    const [first] = await engine.contacts(3);
    expect(await engine.lidFromPn(3, first!.phoneNumber!)).toBe(first!.lid);
    expect(await engine.pnFromLid(3, first!.lid!)).toBe(first!.phoneNumber);
    // Unknown LIDs return null rather than a guess — the same rule as production.
    expect(await engine.pnFromLid(3, "1@lid")).toBeNull();
  });
});

describe("sending", () => {
  test("returns a key and emits the same event a real send does", async () => {
    const { engine, events } = await connected(3);
    const before = events.length;
    const result = await engine.send(3, "+99900000003001", { kind: "text", text: "hello" });

    expect(result.waKeyId).toMatch(/^SANDBOX/);
    expect(result.remoteJid).toBe("99900000003001@s.whatsapp.net");

    const emitted = events.slice(before).find((e) => e.type === "wa");
    // messages.upsert is what the webhook worker converts into public events.
    expect(emitted).toMatchObject({ event: "messages.upsert", type: "wa" });
  });

  test("does not pace sends, unlike account_protection in production", async () => {
    const { engine } = await connected(3);
    const started = Date.now();
    for (let i = 0; i < 3; i++) {
      await engine.send(3, "+99900000003001", { kind: "text", text: `${i}` });
    }
    // Real pacing is one send per five seconds. A fake number cannot be banned, and a suite
    // that waits fifteen seconds for this is one people stop running.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("keys are unique, so replyTo and reactions address distinct messages", async () => {
    const { engine } = await connected(3);
    const a = await engine.send(3, "+99900000003001", { kind: "text", text: "a" });
    const b = await engine.send(3, "+99900000003001", { kind: "text", text: "b" });
    expect(a.waKeyId).not.toBe(b.waKeyId);
  });
});

describe("inbound", () => {
  /** The sandbox's actual payload: what nobody can test today is their webhook handler. */
  test("fabricates a message that travels the ordinary pipeline", async () => {
    const { engine, events } = await connected(3);
    const before = events.length;
    engine.inbound(3, undefined, "hello from a fake human");

    const emitted = events.slice(before).find((e) => e.type === "wa");
    expect(emitted).toMatchObject({ event: "messages.upsert", type: "wa" });
    const payload = (emitted as { payload: { messages: { key: { fromMe: boolean } }[] } }).payload;
    // fromMe: false is what makes the worker classify this as messages.received.
    expect(payload.messages[0]!.key.fromMe).toBe(false);
  });

  test("defaults the sender to a known contact so the message is attributable", async () => {
    const { engine, events } = await connected(3);
    const before = events.length;
    engine.inbound(3, undefined, "hi");
    const payload = (events.slice(before).find((e) => e.type === "wa") as {
      payload: { messages: { key: { remoteJid: string } }[] };
    }).payload;
    const contacts = await engine.contacts(3);
    expect(payload.messages[0]!.key.remoteJid).toBe(contacts[0]!.jid);
  });
});

describe("group mutations", () => {
  /**
   * The behaviour that used to be missing. A fake where creating a group does not create a group
   * teaches the wrong thing about the real endpoint, and "create then list" is the first thing
   * anybody writes.
   */
  test("a created group is listed afterwards", async () => {
    const { engine } = await connected(3);
    const [contact] = await engine.contacts(3);
    const created = await engine.createGroup(3, "Launch", [contact!.jid]);

    expect(created.subject).toBe("Launch");
    const groups = await engine.groups(3);
    expect(groups.map((g) => g.id)).toContain(created.id);
    // And metadata must agree with the listing, as it does for the derived pair.
    expect(await engine.groupMetadata(3, created.id)).toEqual(created);
  });

  test("the session owns what it creates, and the invitee is a plain member", async () => {
    const { engine } = await connected(3);
    const [contact] = await engine.contacts(3);
    const group = await engine.createGroup(3, "Launch", [contact!.jid]);
    expect(group.owner).toBe("99900000003@s.whatsapp.net");
    expect(group.participants.find((p) => p.id === contact!.jid)).toMatchObject({ admin: null });
  });

  test("adding and removing a participant changes the stored group", async () => {
    const { engine } = await connected(3);
    const contacts = await engine.contacts(3);
    const [group] = await engine.groups(3);
    const outsider = contacts[4]!.jid;

    await engine.updateParticipants(3, group!.id, [outsider], "add");
    expect((await engine.groupMetadata(3, group!.id))!.participants.map((p) => p.id)).toContain(outsider);

    await engine.updateParticipants(3, group!.id, [outsider], "remove");
    expect((await engine.groupMetadata(3, group!.id))!.participants.map((p) => p.id)).not.toContain(outsider);
  });

  test("a no-op reports its own status rather than a blanket 200", async () => {
    const { engine } = await connected(3);
    const [group] = await engine.groups(3);
    const alreadyIn = group!.participants[1]!.id;

    // WhatsApp reports per participant, and a caller that only ever sees 200 never writes the
    // branch that handles the rest.
    expect(await engine.updateParticipants(3, group!.id, [alreadyIn], "add")).toEqual([
      { jid: alreadyIn, status: "409" },
    ]);
    expect(await engine.updateParticipants(3, group!.id, ["99900000003999@s.whatsapp.net"], "remove")).toEqual([
      { jid: "99900000003999@s.whatsapp.net", status: "404" },
    ]);
  });

  test("promote and demote move a participant in and out of admin", async () => {
    const { engine } = await connected(3);
    const [group] = await engine.groups(3);
    const member = group!.participants[1]!.id;

    await engine.updateParticipants(3, group!.id, [member], "promote");
    const promoted = await engine.groupMetadata(3, group!.id);
    expect(promoted!.participants.find((p) => p.id === member)!.admin).toBe("admin");

    await engine.updateParticipants(3, group!.id, [member], "demote");
    const demoted = await engine.groupMetadata(3, group!.id);
    expect(demoted!.participants.find((p) => p.id === member)!.admin).toBeNull();
  });

  test("an unknown group is an error, not a silent success", async () => {
    const { engine } = await connected(3);
    await expect(engine.updateParticipants(3, "1@g.us", ["x@s.whatsapp.net"], "add")).rejects.toThrow();
  });

  test("mutations do not leak between sessions", async () => {
    // One engine, two sessions — separate instances would prove nothing, since the state is
    // per-instance anyway. The gateway runs a single engine for every sandbox on the box.
    const { engine } = engineFor();
    for (const id of [3, 4]) {
      await engine.connect(id);
      engine.scan(id);
    }
    await engine.createGroup(3, "Only mine", []);
    expect(await engine.groups(3)).toHaveLength(3);
    expect(await engine.groups(4)).toHaveLength(2);
    await engine.send(3, "+99900000003001", { kind: "text", text: "mine" });
    expect(engine.thread(4)).toEqual([]);
  });
});

describe("contacts", () => {
  test("a saved name shows up in the directory", async () => {
    const { engine } = await connected(3);
    const [first] = await engine.contacts(3);

    await engine.saveContact(3, first!.jid, "Renamed");
    const after = await engine.contacts(3);
    expect(after.find((c) => c.jid === first!.jid)!.name).toBe("Renamed");
    // Still five: renaming a known contact must not duplicate it.
    expect(after).toHaveLength(5);
  });

  test("saving somebody outside the fixtures adds them", async () => {
    const { engine } = await connected(3);
    await engine.saveContact(3, "99988877766@s.whatsapp.net", "Stranger");
    const after = await engine.contacts(3);
    expect(after).toHaveLength(6);
    expect(after.find((c) => c.name === "Stranger")).toBeTruthy();
  });

  test("blocking is remembered, and unblocking undoes it", async () => {
    const { engine } = await connected(3);
    const [first] = await engine.contacts(3);
    // No observable effect beyond being remembered — there is no delivery to prevent here.
    await engine.blockContact(3, first!.jid, "block");
    await engine.blockContact(3, first!.jid, "unblock");
    await expect(engine.blockContact(3, first!.jid, "block")).resolves.toBeUndefined();
  });

  test("a picture is a stable URL for anyone known, and null otherwise", async () => {
    const { engine } = await connected(3);
    const [first] = await engine.contacts(3);

    const url = await engine.profilePicture(3, first!.jid);
    expect(url).toBe(await engine.profilePicture(3, first!.jid));
    // The jid is URL-encoded into the path, so match on the number rather than the raw jid.
    expect(url).toContain(encodeURIComponent(first!.jid));
    // Null is the honest answer for a stranger, and the branch a caller must handle in production.
    expect(await engine.profilePicture(3, "1@s.whatsapp.net")).toBeNull();
  });

  test("groups have pictures too, since the route shape is the same", async () => {
    const { engine } = await connected(3);
    const [group] = await engine.groups(3);
    expect(await engine.profilePicture(3, group!.id)).toBeTruthy();
  });

  test("saved names do not leak between sessions", async () => {
    const { engine } = engineFor();
    for (const id of [3, 4]) {
      await engine.connect(id);
      engine.scan(id);
    }
    await engine.saveContact(3, "99988877766@s.whatsapp.net", "Only mine");
    expect(await engine.contacts(3)).toHaveLength(6);
    expect(await engine.contacts(4)).toHaveLength(5);
  });
});

describe("group membership", () => {
  test("leaving removes the group from the listing", async () => {
    const { engine } = await connected(3);
    const [first] = await engine.groups(3);

    await engine.leaveGroup(3, first!.id);
    const after = await engine.groups(3);
    expect(after).toHaveLength(1);
    expect(after.map((g) => g.id)).not.toContain(first!.id);
    // And metadata must agree, or a stale link into the group still resolves.
    expect(await engine.groupMetadata(3, first!.id)).toBeNull();
  });

  test("an invite code round-trips back to its group", async () => {
    const { engine } = await connected(3);
    const [first] = await engine.groups(3);

    const code = await engine.groupInviteCode(3, first!.id);
    expect(code).toBeTruthy();
    // Accept-what-you-were-given has to work, or the pair is useless together.
    expect((await engine.groupByInvite(3, code!))!.id).toBe(first!.id);
    expect(await engine.acceptGroupInvite(3, code!)).toBe(first!.id);
  });

  test("a code for a group that is gone is null, not an error", async () => {
    const { engine } = await connected(3);
    expect(await engine.groupInviteCode(3, "1@g.us")).toBeNull();
    // A wrong or expired invite is an ordinary thing to paste, not an exception.
    expect(await engine.groupByInvite(3, "nonsense")).toBeNull();
    expect(await engine.acceptGroupInvite(3, "nonsense")).toBeNull();
  });

  test("accepting an unfamiliar sandbox code joins a new group", async () => {
    const { engine } = await connected(3);
    const before = (await engine.groups(3)).length;

    const jid = await engine.acceptGroupInvite(3, "SANDBOX000003ffffffff");
    expect(jid).toBeTruthy();
    expect(await engine.groups(3)).toHaveLength(before + 1);
    // The session is a member, not the owner — it was invited.
    const joined = await engine.groupMetadata(3, jid!);
    expect(joined!.owner).not.toBe("99900000003@s.whatsapp.net");
    expect(joined!.participants.map((p) => p.id)).toContain("99900000003@s.whatsapp.net");
  });

  test("settings change only what was passed", async () => {
    const { engine } = await connected(3);
    const [first] = await engine.groups(3);
    const originalDesc = first!.desc;

    await engine.updateGroupSettings(3, first!.id, { subject: "Renamed" });
    const after = await engine.groupMetadata(3, first!.id);
    expect(after!.subject).toBe("Renamed");
    // `undefined` means leave alone — a subject edit must not clear the description.
    expect(after!.desc).toBe(originalDesc);
  });

  test("settings on an unknown group are an error, not a silent success", async () => {
    const { engine } = await connected(3);
    await expect(engine.updateGroupSettings(3, "1@g.us", { subject: "x" })).rejects.toThrow();
  });
});

describe("the conversation", () => {
  /** What makes the dashboard able to show a sandbox as a chat rather than a status field. */
  test("records both directions, oldest first", async () => {
    const { engine } = await connected(3);
    const [contact] = await engine.contacts(3);

    await engine.send(3, contact!.jid, { kind: "text", text: "out" });
    engine.inbound(3, contact!.jid, "in");

    const thread = engine.thread(3);
    expect(thread).toHaveLength(2);
    expect(thread.map((t) => [t.fromMe, t.text])).toEqual([
      [true, "out"],
      [false, "in"],
    ]);
    // Always the other party, never this session — the dashboard groups by it.
    expect(thread.every((t) => t.jid === contact!.jid)).toBe(true);
  });

  test("carries the kind, and a preview for kinds that have one", async () => {
    const { engine } = await connected(3);
    const to = "+99900000003001";
    await engine.send(3, to, { caption: "a cat", kind: "image", url: "https://x/y.png" });
    await engine.send(3, to, { kind: "sticker", url: "https://x/y.webp" });
    await engine.send(3, to, { kind: "poll", options: ["a", "b"], question: "which?" });

    expect(engine.thread(3).map((t) => [t.kind, t.text])).toEqual([
      ["image", "a cat"],
      // A sticker has no text of its own; null is honest where an empty string would render blank.
      ["sticker", null],
      ["poll", "which?"],
    ]);
  });

  test("carries the file a media send pointed at, not just its kind", async () => {
    const { engine } = await connected(3);
    const to = "+99900000003001";
    await engine.send(3, to, { caption: "a cat", kind: "image", url: "https://x/cat.png" });
    await engine.send(3, to, { fileName: "invoice.pdf", kind: "document", url: "https://x/i.pdf" });
    await engine.send(3, to, { kind: "poll", options: ["a", "b"], question: "which?" });

    /**
     * Without the URL the dashboard could only print `[image]`, which tells somebody debugging an
     * image webhook that *an* image arrived but not which one. A poll has no file, and saying so
     * with null rather than an empty string is what lets the bubble branch on it.
     */
    expect(engine.thread(3).map((t) => [t.kind, t.mediaUrl, t.fileName])).toEqual([
      ["image", "https://x/cat.png", null],
      ["document", "https://x/i.pdf", "invoice.pdf"],
      ["poll", null, null],
    ]);
  });

  test("an inbound message carries no file, because inbound is text only", async () => {
    const { engine } = await connected(3);
    engine.inbound(3, undefined, "hello");
    const [entry] = engine.thread(3);
    expect([entry!.mediaUrl, entry!.fileName]).toEqual([null, null]);
  });

  test("survives a restart, because a phone whose socket dropped keeps its chats", async () => {
    const { engine } = await connected(3);
    await engine.send(3, "+99900000003001", { kind: "text", text: "before" });
    await engine.restart(3);
    engine.scan(3);
    expect(engine.thread(3)).toHaveLength(1);
  });

  test("logout is the deliberate reset", async () => {
    const { engine } = await connected(3);
    await engine.send(3, "+99900000003001", { kind: "text", text: "before" });
    await engine.createGroup(3, "gone", []);
    await engine.logout(3);

    await engine.connect(3);
    engine.scan(3);
    expect(engine.thread(3)).toEqual([]);
    expect(await engine.groups(3)).toHaveLength(2);
  });

  test("is bounded, so a long-lived gateway cannot grow without limit", async () => {
    const { engine } = await connected(3);
    for (let i = 0; i < 205; i++) {
      await engine.send(3, "+99900000003001", { kind: "text", text: `${i}` });
    }
    const thread = engine.thread(3);
    expect(thread).toHaveLength(200);
    // The oldest are dropped, not the newest — a developer is looking at what just happened.
    expect(thread[thread.length - 1]!.text).toBe("204");
  });

  test("reading it does not hand out the live array", async () => {
    const { engine } = await connected(3);
    await engine.send(3, "+99900000003001", { kind: "text", text: "x" });
    engine.thread(3).push({
      at: "",
      fileName: null,
      fromMe: true,
      id: "forged",
      jid: "x",
      kind: "text",
      mediaUrl: null,
      text: "forged",
    });
    expect(engine.thread(3)).toHaveLength(1);
  });
});

describe("media", () => {
  test("decrypt returns real bytes so the round-trip path stays whole", async () => {
    const { engine } = await connected(3);
    const media = await engine.downloadMedia(3, { imageMessage: {} });
    expect(media).not.toBeNull();
    expect(media!.mimetype).toBe("image/png");
    // A valid PNG header — the API stores these bytes and hands back a URL.
    expect(media!.data.subarray(1, 4).toString()).toBe("PNG");
  });
});
