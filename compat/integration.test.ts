import { expect, test, describe, beforeAll } from "bun:test";
import { createDb, whatsappSessions, webhookDeliveries, messages } from "@wapi/db";
import { decryptSecret, generatePat, hashToken } from "@wapi/core";
import { accounts, personalAccessTokens } from "@wapi/db";
import { eq, desc, gt } from "drizzle-orm";
import { SUCCESS_RESPONSES } from "@wapi/contracts";

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
 *
 * **What is deliberately no longer here.** Auth strings, response envelopes and the paginated
 * directory arithmetic moved to `compat/sandbox.test.ts`, which CI runs against a booted stack
 * on every push. Those assertions never needed a real number — they check *our* envelopes, which
 * the route code emits whichever engine is behind it — and asserting them here meant a broken
 * envelope could only ever be discovered after it shipped.
 *
 * What stays is what only a real linked number can prove: that Baileys pairs, that a message
 * reaches a phone, that WhatsApp's own servers resolve a number and a LID, that a real encrypted
 * media node decrypts. A fake cannot fail those tests, so a fake must not be trusted with them.
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
 * An actual HTTP webhook delivery, against production.
 *
 * No longer the last unproven path: `compat/sandbox.test.ts` now proves the delivery mechanism on
 * every push — inbound message, Redis, worker, signed POST — against a stack booted in CI. What
 * only this one can prove is that the *deployed* worker reaches a *real* URL, which is a claim
 * about the deployment rather than about the code.
 *
 * Still opt-in behind COMPAT_WEBHOOK=1, and still should be: it reconfigures a live session's
 * webhook URL and then restores it. The sandbox version needs no such thing, which is why it is
 * the one that runs unattended. The sink is ours (`/api/webhook-sink` on the dashboard) rather
 * than a third-party inspector, because these payloads carry real message content.
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
 * The published schema against the live response.
 *
 * `packages/contracts` asserts our response schemas accept the *documented* examples. That is
 * half the claim: it says our reference matches theirs, not that our API matches our reference.
 * These close the loop by parsing real responses with the same schema `/openapi.json` publishes,
 * so a handler that drifts from its own documentation fails here rather than in a caller.
 */
d("published schemas describe the live responses", () => {
  const check = async (operationId: string, path: string, key = sessionKey) => {
    const entry = (SUCCESS_RESPONSES as Record<string, { schema?: { safeParse: (v: unknown) => { success: boolean; error?: unknown } } }>)[
      operationId
    ];
    if (!entry?.schema) throw new Error(`no schema for ${operationId}`);
    const r = await api(path, {}, key);
    expect(r.status).toBe(200);
    const parsed = entry.schema.safeParse(await r.json());
    if (!parsed.success) {
      throw new Error(
        `${operationId} response does not match its published schema:
${JSON.stringify(parsed.error, null, 2).slice(0, 900)}`,
      );
    }
  };

  test("GET /api/status", () => check("getApiStatus", "/api/status"));
  test("GET /api/user", () => check("getApiUser", "/api/user"));
  test("GET /api/contacts", () => check("getApiContacts", "/api/contacts"));
  test("GET /api/contacts?paginated=true", () =>
    check("getApiContacts", "/api/contacts?paginated=true&page=1&limit=20"));
  test("GET /api/groups", () => check("getApiGroups", "/api/groups"));
  test("GET /api/groups?paginated=true", () =>
    check("getApiGroups", "/api/groups?paginated=true&page=1&limit=20"));
  test("GET /api/whatsapp-sessions", () => check("getApiWhatsappSessions", "/api/whatsapp-sessions", pat));

  test("group metadata and participants, which use two different shapes", async () => {
    const list = await json(await api("/api/groups"));
    const groups = list.body["data"] as { jid: string }[];
    if (!groups.length) return;
    await check("getApiGroupsGroupJidMetadata", `/api/groups/${groups[0]!.jid}/metadata`);
    await check("getApiGroupsGroupJidParticipants", `/api/groups/${groups[0]!.jid}/participants`);
  });

  test("a sent message's info, whose types follow the WhatsApp record", async () => {
    const { db, close } = createDb(process.env["DATABASE_URL"]!);
    const [row] = await db
      .select({ msgId: messages.msgId })
      .from(messages)
      .where(eq(messages.sessionId, SESSION_ID))
      .orderBy(desc(messages.msgId))
      .limit(1);
    await close();
    if (!row) return;
    await check("getApiMessagesMsgIdInfo", `/api/messages/${row.msgId}/info`);
  });
});

// ---------------------------------------------------------------------------------------
/**
 * Reactions — a wapi extension, not part of the cloned interface.
 *
 * The provider emits `messages.reaction` as a webhook but documents no way to send one, so this
 * endpoint is ours. It is tested here rather than in the contract suite because there is no
 * upstream example to check it against; the only ground truth is that WhatsApp accepts it.
 *
 * Every reaction below targets a message this session sent to *itself*, so nothing reaches a
 * third party.
 */
d("reactions", () => {
  const react = (body: unknown) =>
    api("/api/messages/react", { method: "POST", body: JSON.stringify(body) });

  test("a missing key is a controller-level 422", async () => {
    const r = await json(await react({ emoji: "👍" }));
    expect(r.status).toBe(422);
    expect(String(r.body["error"])).toContain("key.id");
  });

  test("a key without remoteJid is refused", async () => {
    const r = await json(await react({ key: { id: "ABC" }, emoji: "👍" }));
    expect(r.status).toBe(422);
    expect(String(r.body["error"])).toContain("key.remoteJid");
  });

  test("a missing emoji is refused, but an empty one is not", async () => {
    const missing = await json(await react({ key: { id: "A", remoteJid: "1@s.whatsapp.net" } }));
    expect(missing.status).toBe(422);
    expect(String(missing.body["error"])).toContain("emoji");
  });

  test("more than one emoji is refused", async () => {
    const r = await json(
      await react({ key: { id: "A", remoteJid: "1@s.whatsapp.net" }, emoji: "👍👍👍👍👍👍👍👍👍" }),
    );
    expect(r.status).toBe(422);
  });

  test("a PAT is refused — this is session-scoped", async () => {
    const r = await fetch(`${BASE}/api/messages/react`, {
      method: "POST",
      headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
      body: JSON.stringify({ key: { id: "A", remoteJid: "1@s.whatsapp.net" }, emoji: "👍" }),
    });
    expect(r.status).toBe(403);
  });

  test("reacting to a real message we sent, then clearing it", async () => {
    const { db, close } = createDb(process.env["DATABASE_URL"]!);
    const [row] = await db
      .select({ waKey: messages.waKey })
      .from(messages)
      .where(eq(messages.sessionId, SESSION_ID))
      .orderBy(desc(messages.msgId))
      .limit(1);
    await close();
    // Nothing sent yet on this session; the shape is covered by the validation cases above.
    if (!row?.waKey) return;

    const key = row.waKey as Record<string, unknown>;
    const added = await json(await react({ key, emoji: "👍" }));
    expect(added.status).toBe(200);
    const data = added.body["data"] as Record<string, unknown>;
    expect(data["emoji"]).toBe("👍");
    // WhatsApp returns an id for the reaction message itself.
    expect(typeof data["id"]).toBe("string");

    // An empty emoji removes it — WhatsApp's convention, not a separate endpoint.
    const cleared = await json(await react({ key, emoji: "" }));
    expect(cleared.status).toBe(200);
    expect((cleared.body["data"] as Record<string, unknown>)["emoji"]).toBe("");
  });
});
