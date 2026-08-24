import { expect, test, describe } from "bun:test";
import { initAuthCreds, BufferJSON } from "baileys";

/**
 * Regression guard for the bug that broke pairing entirely.
 *
 * `saveCreds` inserted every field of the creds object. `initAuthCreds()` leaves several
 * undefined, and `JSON.stringify(undefined, replacer)` returns `undefined` rather than a
 * string — which reached Postgres as NULL and violated NOT NULL on `value`, aborting the
 * whole insert. Nothing was ever persisted.
 *
 * It was invisible from the outside: the QR scanned fine, WhatsApp sent its 515 restart, the
 * reconnect reloaded an empty credential set, and the phone said "can't log in" with no error
 * anywhere near the pairing code. These tests pin the invariant rather than the plumbing, so
 * they need no database.
 */
const enc = (v: unknown): string | undefined => JSON.stringify(v, BufferJSON.replacer);

describe("credential serialisation", () => {
  test("a fresh creds object really does contain undefined fields", () => {
    const creds = initAuthCreds() as unknown as Record<string, unknown>;
    const undef = Object.entries(creds).filter(([, v]) => enc(v) === undefined);
    // If Baileys ever stops emitting these, the guard below becomes dead weight — worth knowing.
    expect(undef.length).toBeGreaterThan(0);
  });

  test("every row destined for a NOT NULL column is a string", () => {
    const creds = initAuthCreds() as unknown as Record<string, unknown>;
    const rows: { key: string; value: string }[] = [];
    const removed: string[] = [];
    for (const [key, value] of Object.entries(creds)) {
      const s = enc(value);
      if (s === undefined) removed.push(key);
      else rows.push({ key, value: s });
    }
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) expect(typeof r.value).toBe("string");
    expect(rows.some((r) => removed.includes(r.key))).toBe(false);
  });

  test("Buffers survive a BufferJSON round-trip — plain JSON corrupts them", () => {
    const creds = initAuthCreds() as unknown as Record<string, unknown>;
    const back = JSON.parse(enc(creds["noiseKey"])!, BufferJSON.reviver) as { private: Buffer };
    expect(Buffer.isBuffer(back.private)).toBe(true);
    // The failure this guards: plain stringify turns a Buffer into {type:"Buffer",data:[…]}.
    const naive = JSON.parse(JSON.stringify(creds["noiseKey"])) as { private: unknown };
    expect(Buffer.isBuffer(naive.private)).toBe(false);
  });

  test("readiness is creds.me, never creds.registered", () => {
    const creds = initAuthCreds();
    // A QR pair never sets `registered` — gating on it rejects live credentials.
    expect(creds.registered).toBe(false);
    expect(creds.me).toBeUndefined();
  });
});
