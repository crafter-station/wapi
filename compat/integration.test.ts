import { expect, test, describe, beforeAll } from "bun:test";
import { createDb, whatsappSessions, webhookDeliveries } from "@wapi/db";
import { decryptSecret, generatePat, hashToken } from "@wapi/core";
import { accounts, personalAccessTokens } from "@wapi/db";
import { eq, desc, gt } from "drizzle-orm";

/**
 * Integration tests against the live deployment.
 *
 * These exercise the real HTTP surface rather than mocking it, because everything expensive
 * learned tonight was invisible to unit tests: a NOT NULL violation inside the auth store,
 * middleware registered after its routes, a bind mount that never resolved. Unit tests cover
 * pure logic; this file covers the wiring.
 *
 * They skip without DATABASE_URL so CI stays green, and every write targets the session's own
 * number — never a group. An earlier probe of mine posted to a real 13-person group by
 * accident, which is a mistake worth encoding as a rule rather than a memory.
 */
const BASE = process.env["WAPI_BASE_URL"] ?? "https://api.wapi.crafter.run";
const WEB = process.env["WAPI_WEB_URL"] ?? "https://wapi.crafter.run";
const SESSION_ID = Number(process.env["COMPAT_SESSION_ID"] ?? 3);
const CAN_RUN = Boolean(process.env["DATABASE_URL"]);
const d = CAN_RUN ? describe : describe.skip;

let sessionKey = "";
let pat = "";
let phone = "";
let accountId = 0;

const api = (path: string, init: RequestInit = {}, key = sessionKey) =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> });

beforeAll(async () => {
  if (!CAN_RUN) return;
  const { db, close } = createDb(process.env["DATABASE_URL"]!);
  const [s] = await db.select().from(whatsappSessions).where(eq(whatsappSessions.id, SESSION_ID));
  if (!s?.apiKeyEncrypted) throw new Error(`session ${SESSION_ID} has no key`);
  sessionKey = decryptSecret(s.apiKeyEncrypted);
  phone = s.phoneNumber;
  accountId = s.accountId;

  // A throwaway PAT for the account-scoped half of the surface.
  pat = generatePat();
  await db
    .insert(personalAccessTokens)
    .values({ accountId, name: "integration-suite", tokenHash: hashToken(pat) });
  await close();
});

// ---------------------------------------------------------------------------------------
d("auth", () => {
  test("missing credential returns their exact string", async () => {
    const r = await json(await fetch(`${BASE}/api/whatsapp-sessions`));
    expect(r.status).toBe(401);
    expect(r.body["message"]).toBe("API key is required");
  });

  test("invalid credential returns their exact string", async () => {
    const r = await json(await api("/api/whatsapp-sessions", {}, "nope"));
    expect(r.status).toBe(401);
    expect(r.body["message"]).toBe("Invalid API key");
  });

  test("a session key is refused on account-scoped routes", async () => {
    const r = await json(await api("/api/whatsapp-sessions"));
    expect(r.status).toBe(403);
  });

  test("a PAT is refused on session-scoped routes", async () => {
    const r = await json(await api("/api/status", {}, pat));
    expect(r.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------
d("envelopes", () => {
  test("GET /api/status is a bare object with no success wrapper", async () => {
    const r = await json(await api("/api/status"));
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(["status"]);
  });

  test("controller failures use `error`, framework failures use `message`", async () => {
    // A registered route rejecting business input: controller envelope.
    const controller = await json(
      await api("/api/messages/read", { method: "POST", body: JSON.stringify({ key: {} }) }),
    );
    expect(controller.status).toBe(422);
    expect(typeof controller.body["error"]).toBe("string");
    expect(controller.body["message"]).toBeUndefined();

    // An unrouted path: framework envelope.
    const framework = await json(await api("/api/definitely-not-a-route"));
    expect(framework.status).toBe(404);
    expect(typeof framework.body["message"]).toBe("string");
    expect(framework.body["error"]).toBeUndefined();
  });

  test("validation errors use Laravel phrasing and per-field arrays", async () => {
    const r = await json(
      await api("/api/whatsapp-sessions", { method: "POST", body: JSON.stringify({ name: "x" }) }, pat),
    );
    expect(r.status).toBe(422);
    expect(r.body["message"]).toBe("Validation failed");
    const errors = r.body["errors"] as Record<string, string[]>;
    expect(errors["phone_number"]?.[0]).toBe("The phone_number field is required.");
  });

  test("rate-limit headers are on every response", async () => {
    const r = await api("/api/status");
    expect(r.headers.get("x-ratelimit-limit")).toBeTruthy();
    expect(r.headers.get("x-ratelimit-remaining")).toBeTruthy();
    expect(r.headers.get("x-ratelimit-reset")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------
d("session lifecycle", () => {
  let created = 0;

  test("create returns the key, list does not leak it", async () => {
    const c = await json(
      await api(
        "/api/whatsapp-sessions",
        {
          method: "POST",
          body: JSON.stringify({
            name: "integration-temp",
            phone_number: "+10000000000",
            account_protection: false,
            log_messages: true,
          }),
        },
        pat,
      ),
    );
    expect(c.status).toBe(201);
    const data = c.body["data"] as Record<string, unknown>;
    created = data["id"] as number;
    // The detail shape carries the key; that is why it cannot be stored hash-only.
    expect(typeof data["api_key"]).toBe("string");
    expect(typeof data["webhook_secret"]).toBe("string");

    const list = await json(await api("/api/whatsapp-sessions", {}, pat));
    const rows = list.body["data"] as Record<string, unknown>[];
    const mine = rows.find((x) => x["id"] === created)!;
    // A key must never appear in a list response.
    expect(mine["api_key"]).toBeUndefined();
    expect(mine["webhook_secret"]).toBeUndefined();
    // Casing is snake_case here and camelCase on messages — copied, not fixed.
    expect(mine["phone_number"]).toBe("+10000000000");
  });

  test("regenerate-key puts api_key at the TOP level, not under data", async () => {
    const r = await json(
      await api(`/api/whatsapp-sessions/${created}/regenerate-key`, { method: "POST" }, pat),
    );
    expect(r.status).toBe(200);
    expect(typeof r.body["api_key"]).toBe("string");
    expect(r.body["data"]).toBeUndefined();
  });

  test("proxy_url rejects private ranges (SSRF guard)", async () => {
    const bad = await json(
      await api(
        `/api/whatsapp-sessions/${created}`,
        { method: "PUT", body: JSON.stringify({ proxy_url: "socks5://10.0.0.1:1080" }) },
        pat,
      ),
    );
    expect(bad.status).toBe(422);

    const good = await json(
      await api(
        `/api/whatsapp-sessions/${created}`,
        { method: "PUT", body: JSON.stringify({ proxy_url: "socks5://proxy.example.com:1080" }) },
        pat,
      ),
    );
    expect(good.status).toBe(200);
  });

  test("delete is 204 with an empty body", async () => {
    const r = await api(`/api/whatsapp-sessions/${created}`, { method: "DELETE" }, pat);
    expect(r.status).toBe(204);
    expect((await r.text()).length).toBe(0);
  });

  test("an unknown session 404s with the controller envelope", async () => {
    const r = await json(await api("/api/whatsapp-sessions/999999", {}, pat));
    expect(r.status).toBe(404);
    expect(r.body["error"]).toBe("The specified session was not found.");
  });
});

// ---------------------------------------------------------------------------------------
d("messaging", () => {
  test("send-message rejects an empty payload and a bad recipient", async () => {
    const empty = await json(
      await api("/api/send-message", { method: "POST", body: JSON.stringify({ to: phone }) }),
    );
    expect(empty.status).toBe(422);

    const bad = await json(
      await api("/api/send-message", { method: "POST", body: JSON.stringify({ to: "123", text: "x" }) }),
    );
    expect(bad.status).toBe(422);
  });

  test("two payload fields is an error, not a silent preference", async () => {
    const r = await json(
      await api("/api/send-message", {
        method: "POST",
        body: JSON.stringify({ to: phone, imageUrl: "https://x/y.jpg", videoUrl: "https://x/z.mp4" }),
      }),
    );
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain("Only one of");
  });

  test("a poll needs 2-12 options", async () => {
    const r = await json(
      await api("/api/send-message", {
        method: "POST",
        body: JSON.stringify({ to: phone, poll: { question: "q", options: ["one"] } }),
      }),
    );
    expect(r.status).toBe(422);
  });

  test("text send mints an integer msgId and /info returns both identifiers", async () => {
    // Always to the session's own number. Never a group.
    const sent = await json(
      await api("/api/send-message", {
        method: "POST",
        body: JSON.stringify({ to: phone, text: `integration ${Date.now()}` }),
      }),
    );
    expect(sent.status).toBe(200);
    const data = sent.body["data"] as Record<string, unknown>;
    const msgId = data["msgId"] as number;
    expect(typeof msgId).toBe("number");
    expect(msgId).toBeGreaterThanOrEqual(100000);
    // camelCase on messages, snake_case on sessions — the documented inconsistency.
    expect(data["status"]).toBe("in_progress");

    const info = await json(await api(`/api/messages/${msgId}/info`));
    expect(info.status).toBe(200);
    const i = info.body["data"] as Record<string, unknown>;
    // Both identifiers side by side: our integer and WhatsApp's string key.
    expect(i["msgId"]).toBe(msgId);
    expect(typeof i["id"]).toBe("string");
  });

  test("message-logs uses the Laravel paginator without `links`", async () => {
    const r = await json(
      await api(`/api/whatsapp-sessions/${SESSION_ID}/message-logs?per_page=2`, {}, pat),
    );
    expect(r.status).toBe(200);
    const p = r.body["data"] as Record<string, unknown>;
    expect(Object.keys(p).sort()).toEqual(
      [
        "current_page",
        "data",
        "first_page_url",
        "from",
        "last_page",
        "last_page_url",
        "next_page_url",
        "path",
        "per_page",
        "prev_page_url",
        "to",
        "total",
      ].sort(),
    );
    const rows = p["data"] as Record<string, unknown>[];
    if (rows.length) {
      // Strings, not integers, and content is a JSON-encoded string — both from the fixture.
      expect(typeof rows[0]!["id"]).toBe("string");
      expect(typeof rows[0]!["whatsapp_session_id"]).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------------------
d("contacts and groups", () => {
  test("contacts come from the event-fed cache", async () => {
    const r = await json(await api("/api/contacts"));
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body["data"])).toBe(true);
  });

  test("on-whatsapp resolves a real number", async () => {
    const r = await json(await api(`/api/on-whatsapp/${encodeURIComponent(phone)}`));
    expect(r.status).toBe(200);
    expect((r.body["data"] as Record<string, unknown>)["exists"]).toBe(true);
  });

  test("lid-from-pn returns a LID", async () => {
    const r = await json(await api(`/api/lid-from-pn/${encodeURIComponent(phone)}`));
    expect([200, 404]).toContain(r.status);
    if (r.status === 200) {
      expect(String((r.body["data"] as Record<string, unknown>)["lid"])).toContain("@lid");
    }
  });

  test("groups list and metadata agree", async () => {
    const list = await json(await api("/api/groups"));
    expect(list.status).toBe(200);
    const groups = list.body["data"] as { id: string }[];
    if (!groups.length) return;
    const md = await json(await api(`/api/groups/${groups[0]!.id}/metadata`));
    expect(md.status).toBe(200);
    expect((md.body["data"] as Record<string, unknown>)["id"]).toBe(groups[0]!.id);

    const parts = await json(await api(`/api/groups/${groups[0]!.id}/participants`));
    expect(parts.status).toBe(200);
    expect(Array.isArray(parts.body["data"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
d("media", () => {
  test("upload rejects an empty body", async () => {
    const r = await json(
      await api("/api/upload", { method: "POST", body: JSON.stringify({ mimetype: "image/png" }) }),
    );
    expect(r.status).toBe(422);
  });

  test("decrypt-media rejects a message with no media node", async () => {
    const r = await json(
      await api("/api/decrypt-media", {
        method: "POST",
        body: JSON.stringify({ data: { messages: { message: { conversation: "hi" } } } }),
      }),
    );
    expect(r.status).toBe(422);
    expect(String(r.body["error"])).toContain("No supported media object");
  });

  /**
   * Media must be reachable on the API's own hostname.
   *
   * A strict client pins the media host to the provider host it was configured with and
   * re-validates it on every redirect hop. Handing back the object store's presigned URL — or
   * 302-ing to it — fails such a client before a byte is read, so these assert the origin and
   * that the bytes come back on the response rather than via a cross-host redirect.
   */
  test("an uploaded object is served from our origin, byte-for-byte, with no redirect", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64",
    );
    const up = await json(
      await api("/api/upload", {
        method: "POST",
        body: JSON.stringify({ base64: png.toString("base64"), mimetype: "image/png" }),
      }),
    );
    expect(up.status).toBe(200);
    // publicUrl is at the TOP level, not under data.
    const url = String(up.body["publicUrl"]);
    expect(new URL(url).origin).toBe(new URL(BASE).origin);

    const fetched = await fetch(url, { redirect: "manual" });
    expect(fetched.status).toBe(200);
    const bytes = Buffer.from(await fetched.arrayBuffer());
    expect(bytes.equals(png)).toBe(true);
  });

  test("a media link carrying a tampered or absent signature is refused", async () => {
    const up = await json(
      await api("/api/upload", {
        method: "POST",
        body: JSON.stringify({ base64: "aGVsbG8=", mimetype: "text/plain" }),
      }),
    );
    const url = new URL(String(up.body["publicUrl"]));

    // The permanent link has no signature and must keep working.
    expect((await fetch(url.href, { redirect: "manual" })).status).toBe(200);

    // Presenting a signature at all means it has to verify.
    url.searchParams.set("expires", String(Math.floor(Date.now() / 1000) + 3600));
    url.searchParams.set("sig", "0".repeat(64));
    expect((await fetch(url.href, { redirect: "manual" })).status).toBe(404);

    // A half-supplied signature is not a way to skip the check.
    const partial = new URL(String(up.body["publicUrl"]));
    partial.searchParams.set("expires", "99999999999");
    expect((await fetch(partial.href, { redirect: "manual" })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------
/**
 * The last unproven path: an actual HTTP webhook delivery.
 *
 * Enabled with COMPAT_WEBHOOK=1 because it reconfigures a live session's webhook URL and then
 * restores it. The sink is ours (`/api/webhook-sink` on the dashboard) rather than a
 * third-party inspector, because these payloads carry real message content.
 */
d("webhook delivery", () => {
  test.if(process.env["COMPAT_WEBHOOK"] === "1")(
    "a send produces an HTTP delivery carrying the signature",
    async () => {
      const { db, close } = createDb(process.env["DATABASE_URL"]!);
      const [before] = await db
        .select()
        .from(webhookDeliveries)
        .orderBy(desc(webhookDeliveries.id))
        .limit(1);
      const lastId = before?.id ?? 0;

      const [session] = await db
        .select()
        .from(whatsappSessions)
        .where(eq(whatsappSessions.id, SESSION_ID));
      const restore = {
        webhookUrl: session!.webhookUrl,
        webhookEnabled: session!.webhookEnabled,
        webhookEvents: session!.webhookEvents,
      };

      await db
        .update(whatsappSessions)
        .set({
          webhookUrl: `${WEB}/api/webhook-sink`,
          webhookEnabled: true,
          webhookEvents: [],
        })
        .where(eq(whatsappSessions.id, SESSION_ID));

      try {
        await api("/api/send-message", {
          method: "POST",
          body: JSON.stringify({ to: phone, text: `webhook probe ${Date.now()}` }),
        });

        let delivered: { event: string; signature: string | null }[] = [];
        for (let i = 0; i < 20 && !delivered.length; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          delivered = await db
            .select({ event: webhookDeliveries.event, signature: webhookDeliveries.signature })
            .from(webhookDeliveries)
            .where(gt(webhookDeliveries.id, lastId));
        }

        expect(delivered.length).toBeGreaterThan(0);
        // Their scheme is the plain secret in the header, not an HMAC (PLAN.md §1).
        expect(delivered[0]!.signature).toBe(session!.webhookSecret);
      } finally {
        await db.update(whatsappSessions).set(restore).where(eq(whatsappSessions.id, SESSION_ID));
        await close();
      }
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------------------
/**
 * `?paginated=true` — the undocumented directory envelope.
 *
 * Found by reading a real consumer (`cuevaio/normal`'s `packages/wasender/src/directory.ts`)
 * rather than the published docs, which only describe the flat array. That consumer rejects
 * the whole page unless the arithmetic matches exactly, so these assertions replicate its
 * validation instead of merely checking that fields exist.
 */
d("paginated directory envelope", () => {
  const validate = (payload: Record<string, unknown>, expectedPage: number) => {
    expect(payload["success"]).toBe(true);
    const data = payload["data"] as Record<string, unknown>;
    const items = data["items"] as unknown[];
    const p = data["pagination"] as Record<string, number>;

    expect(Array.isArray(items)).toBe(true);
    expect(Number.isSafeInteger(p["page"])).toBe(true);
    expect(p["page"]).toBe(expectedPage);
    expect(p["limit"]!).toBeGreaterThanOrEqual(1);
    expect(Number.isSafeInteger(p["total"])).toBe(true);
    expect(p["total"]!).toBeGreaterThanOrEqual(items.length);
    expect(items.length).toBeLessThanOrEqual(p["limit"]!);
    // The exact check that rejects a mismatched page.
    expect(p["totalPages"]).toBe(Math.max(1, Math.ceil(p["total"]! / p["limit"]!)));
    expect(p["page"]!).toBeLessThanOrEqual(p["totalPages"]!);
  };

  test("contacts return items + pagination and satisfy the consumer's arithmetic", async () => {
    const r = await json(await api("/api/contacts?paginated=true&page=1&limit=100"));
    expect(r.status).toBe(200);
    validate(r.body, 1);
  });

  test("groups do too", async () => {
    const r = await json(await api("/api/groups?paginated=true&page=1&limit=100"));
    expect(r.status).toBe(200);
    validate(r.body, 1);
  });

  test("entries carry jid and id identically, and a name", async () => {
    const r = await json(await api("/api/groups?paginated=true&page=1&limit=100"));
    const items = ((r.body["data"] as Record<string, unknown>)["items"] as Record<string, unknown>[]);
    if (!items.length) return;
    for (const g of items) {
      // Both keys are accepted, but a consumer rejects the entry if they differ.
      expect(g["jid"]).toBe(g["id"]);
      expect(String(g["jid"])).toMatch(/^[1-9]\d{1,31}(?:-[1-9]\d{1,31})?@g\.us$/);
      // A group carrying only `subject` parses but comes back unnamed.
      expect(typeof g["name"]).toBe("string");
    }
  });

  test("a small limit produces a consistent multi-page shape", async () => {
    const r = await json(await api("/api/contacts?paginated=true&page=1&limit=2"));
    validate(r.body, 1);
    const p = (r.body["data"] as Record<string, unknown>)["pagination"] as Record<string, number>;
    const items = (r.body["data"] as Record<string, unknown>)["items"] as unknown[];
    expect(items.length).toBeLessThanOrEqual(2);
    if (p["total"]! > 2) expect(p["totalPages"]!).toBeGreaterThan(1);
  });

  test("without the flag the flat array is unchanged", async () => {
    const r = await json(await api("/api/contacts"));
    expect(Array.isArray(r.body["data"])).toBe(true);
  });
});
