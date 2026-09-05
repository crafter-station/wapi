import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { whatsappSessions, type Db } from "@wapi/db";
import {
  encryptSecret,
  generateApiKey,
  generateWebhookSecret,
  hashToken,
  sessionDetailToWire,
  sessionSettingsToWire,
  sessionToWire,
  validateProxy,
  validationFailure,
} from "@wapi/core";
import { gateway } from "../gateway-client.ts";
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

  /** GET /api/whatsapp-sessions/{id}/settings — wapi extension for omitted safety controls. */
  app.get("/whatsapp-sessions/:whatsappSession/settings", async (c) => {
    const row = await findOwned(db, c.get("auth").accountId, c.req.param("whatsappSession"));
    if (!row) return c.json(fail("The specified session was not found."), 404);
    return c.json(ok(sessionSettingsToWire(row)));
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

    /**
     * Nothing to push for webhooks — checked, not assumed.
     *
     * Their docs say an update "syncs webhook settings with the WhatsApp API server", which
     * reads like it needs a call to the gateway. It does not: the worker calls `loadSession`
     * per job with an uncached read, so a change to the URL, the enabled flag or the event list
     * applies to the very next delivery. Pushing anything would be a second source of truth for
     * a value that is already read fresh.
     *
     * `proxy_url` and `account_protection` are different: both are read when the socket is
     * built, so both take effect at the next connect. Pushing them to a live socket is not
     * possible without rebuilding it, which is a disconnect by another name.
     */
    return c.json(ok(sessionDetailToWire(updated!)));
  });

  /** DELETE /api/whatsapp-sessions/{id} — 204, empty body. */
  app.delete("/whatsapp-sessions/:whatsappSession", async (c) => {
    const { accountId } = c.get("auth");
    const row = await findOwned(db, accountId, c.req.param("whatsappSession"));
    if (!row) return c.json(fail("The specified session was not found."), 404);
    /**
     * Close the socket before dropping the row, as their docs describe.
     *
     * Deleting first leaves the gateway holding a live WhatsApp connection for a session that no
     * longer exists: it keeps emitting events whose `sessionId` resolves to nothing, and the
     * credentials rows go with the cascade while the socket stays up until the process restarts.
     *
     * Best-effort on purpose. If the gateway is unreachable the user still asked for this
     * session to be gone, and refusing to delete it would leave them unable to clean up during
     * exactly the incident where they most want to. The orphaned socket dies with the next
     * gateway restart; a row we refused to delete would not fix itself.
     */
    await gateway.logout(row.id).catch(() => null);
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
