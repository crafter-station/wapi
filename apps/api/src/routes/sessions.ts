import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { whatsappSessions, type Db } from "@wapi/db";
import {
  generateApiKey,
  generateWebhookSecret,
  hashToken,
  encryptSecret,
  sessionToWire,
  sessionDetailToWire,
  validationFailure,
} from "@wapi/core";
import { ok, fail } from "@wapi/contracts";
import {
  postApiWhatsappSessionsBody,
  putApiWhatsappSessionsWhatsappSessionBody,
} from "@wapi/contracts";

/**
 * Session CRUD — PLAN.md §8 phase 3.
 *
 * Every route here is account-level and therefore Personal-Access-Token only; the guard is
 * applied by the caller. Response shapes come from `@wapi/core/serialize`, which is where the
 * casing warts live.
 */
export function sessionRoutes(db: Db) {
  const app = new Hono();

  /** GET /api/whatsapp-sessions — list. Note: no api_key in list responses. */
  app.get("/whatsapp-sessions", async (c) => {
    const { accountId } = c.get("auth");
    const rows = await db
      .select()
      .from(whatsappSessions)
      .where(eq(whatsappSessions.accountId, accountId))
      .orderBy(desc(whatsappSessions.createdAt));
    return c.json(ok(rows.map(sessionToWire)));
  });

  /** POST /api/whatsapp-sessions — create. */
  app.post("/whatsapp-sessions", async (c) => {
    const { accountId } = c.get("auth");
    const parsed = postApiWhatsappSessionsBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(validationFailure(parsed.error), 422);

    const b = parsed.data;
    const apiKey = generateApiKey();

    const [row] = await db
      .insert(whatsappSessions)
      .values({
        accountId,
        name: b.name,
        phoneNumber: b.phone_number,
        accountProtection: b.account_protection,
        logMessages: b.log_messages,
        readIncomingMessages: b.read_incoming_messages ?? false,
        autoRejectCalls: (b as Record<string, unknown>)["auto_reject_calls"] === true,
        alwaysOnline: (b as Record<string, unknown>)["always_online"] === true,
        ignoreGroups: (b as Record<string, unknown>)["ignore_groups"] === true,
        ignoreChannels: (b as Record<string, unknown>)["ignore_channels"] === true,
        ignoreBroadcasts: (b as Record<string, unknown>)["ignore_broadcasts"] === true,
        proxyUrl: (b as Record<string, unknown>)["proxy_url"] as string | undefined,
        webhookUrl: b.webhook_url,
        webhookEnabled: b.webhook_enabled ?? false,
        webhookEvents: (b.webhook_events as string[] | undefined) ?? [],
        webhookSecret: generateWebhookSecret(),
        // The key is issued at creation so it can be shown once, and stored two ways:
        // hashed for lookup, encrypted so GET can return it in plaintext (PLAN.md §1).
        apiKeyHash: hashToken(apiKey),
        apiKeyEncrypted: encryptSecret(apiKey),
        status: "disconnected",
      })
      .returning();

    return c.json(ok(sessionDetailToWire(row!)), 201);
  });

  /** GET /api/whatsapp-sessions/{id} — detail, including api_key and webhook_secret. */
  app.get("/whatsapp-sessions/:whatsappSession", async (c) => {
    const row = await findOwned(db, c.get("auth").accountId, c.req.param("whatsappSession"));
    if (!row) return c.json(fail("The specified session was not found."), 404);
    return c.json(ok(sessionDetailToWire(row)));
  });

  /** PUT /api/whatsapp-sessions/{id} — update. This is where proxy_url is set. */
  app.put("/whatsapp-sessions/:whatsappSession", async (c) => {
    const { accountId } = c.get("auth");
    const row = await findOwned(db, accountId, c.req.param("whatsappSession"));
    if (!row) return c.json(fail("The specified session was not found."), 404);

    const parsed = putApiWhatsappSessionsWhatsappSessionBody
      .partial()
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(validationFailure(parsed.error), 422);
    const b = parsed.data as Record<string, unknown>;

    const patch: Partial<typeof whatsappSessions.$inferInsert> = { updatedAt: new Date() };
    if (b["name"] !== undefined) patch.name = b["name"] as string;
    if (b["phone_number"] !== undefined) patch.phoneNumber = b["phone_number"] as string;
    if (b["account_protection"] !== undefined) patch.accountProtection = Boolean(b["account_protection"]);
    if (b["log_messages"] !== undefined) patch.logMessages = Boolean(b["log_messages"]);
    if (b["read_incoming_messages"] !== undefined) patch.readIncomingMessages = Boolean(b["read_incoming_messages"]);
    if (b["auto_reject_calls"] !== undefined) patch.autoRejectCalls = Boolean(b["auto_reject_calls"]);
    if (b["always_online"] !== undefined) patch.alwaysOnline = Boolean(b["always_online"]);
    if (b["ignore_groups"] !== undefined) patch.ignoreGroups = Boolean(b["ignore_groups"]);
    if (b["ignore_channels"] !== undefined) patch.ignoreChannels = Boolean(b["ignore_channels"]);
    if (b["ignore_broadcasts"] !== undefined) patch.ignoreBroadcasts = Boolean(b["ignore_broadcasts"]);
    if (b["webhook_url"] !== undefined) patch.webhookUrl = b["webhook_url"] as string;
    if (b["webhook_enabled"] !== undefined) patch.webhookEnabled = Boolean(b["webhook_enabled"]);
    if (b["webhook_events"] !== undefined) patch.webhookEvents = b["webhook_events"] as string[];

    if (b["proxy_url"] !== undefined) {
      const proxy = b["proxy_url"] as string | null;
      if (proxy) {
        const err = validateProxy(proxy);
        if (err) return c.json(fail(err), 422);
      }
      patch.proxyUrl = proxy;
    }

    const [updated] = await db
      .update(whatsappSessions)
      .set(patch)
      .where(eq(whatsappSessions.id, row.id))
      .returning();

    // TODO(phase 4): when connected, push webhook + proxy changes to the gateway. Their docs
    // say an update "syncs webhook settings with the WhatsApp API server".
    return c.json(ok(sessionDetailToWire(updated!)));
  });

  /** DELETE /api/whatsapp-sessions/{id} — 204, empty body. */
  app.delete("/whatsapp-sessions/:whatsappSession", async (c) => {
    const { accountId } = c.get("auth");
    const row = await findOwned(db, accountId, c.req.param("whatsappSession"));
    if (!row) return c.json(fail("The specified session was not found."), 404);
    // TODO(phase 4): disconnect from the gateway first, as their docs describe.
    await db.delete(whatsappSessions).where(eq(whatsappSessions.id, row.id));
    return c.body(null, 204);
  });

  /**
   * POST /api/whatsapp-sessions/{id}/regenerate-key.
   *
   * Note the envelope: `api_key` sits at the TOP level, not under `data`. That is what their
   * documented response shows, and it differs from every other success shape in the API.
   */
  app.post("/whatsapp-sessions/:whatsappSession/regenerate-key", async (c) => {
    const { accountId } = c.get("auth");
    const row = await findOwned(db, accountId, c.req.param("whatsappSession"));
    if (!row) return c.json(fail("The specified session was not found."), 404);

    const apiKey = generateApiKey();
    await db
      .update(whatsappSessions)
      .set({ apiKeyHash: hashToken(apiKey), apiKeyEncrypted: encryptSecret(apiKey), updatedAt: new Date() })
      .where(eq(whatsappSessions.id, row.id));

    return c.json({ success: true, api_key: apiKey });
  });

  return app;
}

async function findOwned(db: Db, accountId: number, idParam: string) {
  const id = Number(idParam);
  if (!Number.isInteger(id)) return null;
  const [row] = await db
    .select()
    .from(whatsappSessions)
    .where(and(eq(whatsappSessions.id, id), eq(whatsappSessions.accountId, accountId)))
    .limit(1);
  return row ?? null;
}

/**
 * Their documented constraint: "Allowed protocols: http, https, socks5. Use a public domain
 * only (IP addresses and local/private networks are blocked)." The private-range block is a
 * genuine SSRF guard, not decoration — this URL becomes an outbound proxy for our egress.
 */
function validateProxy(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "The proxy_url must be a valid URL.";
  }
  if (!["http:", "https:", "socks5:"].includes(u.protocol)) {
    return "Allowed proxy protocols are http, https and socks5.";
  }
  const host = u.hostname;
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
  const isPrivate =
    /^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1|0\.0\.0\.0)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (isIp || isPrivate) {
    return "Use a public domain for proxy_url; IP addresses and private networks are blocked.";
  }
  return null;
}
