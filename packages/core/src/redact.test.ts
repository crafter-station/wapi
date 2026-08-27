import { describe, expect, test } from "bun:test";
import { clientIp, redactBody, redactHeaders, redactPayload, REDACTED } from "./redact.js";

/**
 * These are the specification, not a smoke test.
 *
 * An audit log that records requests verbatim is a table containing every API key the system has
 * issued, so the cases below are written as "this must never appear", and each one names the
 * concrete leak it prevents.
 */
describe("redactHeaders", () => {
  const h = (o: Record<string, string>) => Object.entries(o);

  test("never stores Authorization — it is a full WhatsApp credential", () => {
    const out = redactHeaders(h({ authorization: "Bearer sk_live_deadbeef", accept: "*/*" }));
    expect(out["authorization"]).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("deadbeef");
    expect(out["accept"]).toBe("*/*");
  });

  test("case does not matter — a header is not safe because it shouted", () => {
    const out = redactHeaders(h({ AUTHORIZATION: "Bearer x", Cookie: "session=y" }));
    expect(Object.keys(out)).toEqual([]);
  });

  test("drops the webhook signature, which is the shared secret itself by default", () => {
    const out = redactHeaders(h({ "x-webhook-signature": "the-actual-secret" }));
    expect(JSON.stringify(out)).not.toContain("the-actual-secret");
  });

  test("an unknown header is excluded by default rather than kept", () => {
    // The allow-list is what makes a future `x-internal-key` safe without anyone remembering.
    const out = redactHeaders(h({ "x-something-new": "value" }));
    expect(out["x-something-new"]).toBeUndefined();
  });

  test("keeps what actually describes the request", () => {
    const out = redactHeaders(
      h({ "content-type": "application/json", "user-agent": "curl/8", "cf-ipcountry": "PE" }),
    );
    expect(out).toEqual({
      "cf-ipcountry": "PE",
      "content-type": "application/json",
      "user-agent": "curl/8",
    });
  });

  test("bounds a long allowed header", () => {
    const out = redactHeaders(h({ "user-agent": "u".repeat(400) }));
    expect(out["user-agent"]!.length).toBeLessThan(300);
  });
});

describe("redactBody", () => {
  test("removes credentials at any depth", () => {
    const out = redactBody({
      data: { api_key: "sk_live_x", nested: { webhook_secret: "whsec_y" }, name: "Prod" },
    }) as Record<string, Record<string, unknown>>;
    expect(JSON.stringify(out)).not.toContain("sk_live_x");
    expect(JSON.stringify(out)).not.toContain("whsec_y");
    // The surrounding shape survives, or the log stops being useful.
    expect(out["data"]!["name"]).toBe("Prod");
  });

  test("describes bulk fields instead of storing them", () => {
    // A 16 MB upload must not become a 16 MB audit row.
    const out = redactBody({ base64: "A".repeat(20_000), mimetype: "image/png" }) as Record<
      string,
      string
    >;
    expect(out["base64"]).toContain(REDACTED);
    expect(out["base64"]).toContain("20000");
    expect(out["mimetype"]).toBe("image/png");
  });

  test("keeps a sample of a long array, not the whole address book", () => {
    const out = redactBody(Array.from({ length: 500 }, (_, i) => ({ jid: `${i}@lid` }))) as unknown[];
    expect(out).toHaveLength(6);
    expect(String(out[5])).toContain("495 more");
  });

  test("truncates long strings and says how long they were", () => {
    const out = redactBody({ text: "x".repeat(900) }) as Record<string, string>;
    expect(out["text"]!.length).toBeLessThan(600);
    expect(out["text"]).toContain("900 chars");
  });

  test("a self-referential payload terminates instead of hanging the request", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic["self"] = cyclic;
    expect(() => JSON.stringify(redactBody(cyclic))).not.toThrow();
  });
});

describe("redactPayload", () => {
  test("non-JSON is described, never stored", () => {
    const out = redactPayload("\\x89PNG....binary....", "image/png", 4096);
    expect(out).toContain(REDACTED);
    expect(out).toContain("image/png");
  });

  test("unparseable JSON does not throw and does not leak the body", () => {
    const out = redactPayload("{not json", "application/json");
    expect(out).toContain("unparseable");
    expect(out).not.toContain("not json");
  });

  test("a session response never carries its key through", () => {
    // This is the exact response shape of GET /api/whatsapp-sessions/{id}, which returns the
    // credential in plaintext because fidelity requires it.
    const body = JSON.stringify({
      success: true,
      data: { id: 3, name: "Prod", api_key: "abc123secret", webhook_secret: "whsec_secret" },
    });
    const out = redactPayload(body, "application/json")!;
    expect(out).not.toContain("abc123secret");
    expect(out).not.toContain("whsec_secret");
    expect(out).toContain("Prod");
  });

  test("an empty body is null rather than an empty string", () => {
    expect(redactPayload("", "application/json")).toBeNull();
    expect(redactPayload(null, null)).toBeNull();
  });

  test("the total is bounded even when every field is individually short", () => {
    const wide = JSON.stringify(
      Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, "v"])),
    );
    expect(redactPayload(wide, "application/json", 1024)!.length).toBeLessThanOrEqual(1025);
  });
});

describe("clientIp", () => {
  const headers = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });

  test("prefers x-real-ip, which our own proxy sets", () => {
    expect(clientIp(headers({ "x-real-ip": "203.0.113.5", "x-forwarded-for": "1.1.1.1" }))).toBe(
      "203.0.113.5",
    );
  });

  test("falls back to the first forwarded entry", () => {
    expect(clientIp(headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
  });

  test("absent rather than guessed when nothing is forwarded", () => {
    expect(clientIp(headers({}))).toBeNull();
  });
});
