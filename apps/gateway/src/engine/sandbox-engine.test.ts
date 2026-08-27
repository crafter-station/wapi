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
