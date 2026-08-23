import { Hono } from "hono";
import { eq, and, desc, count } from "drizzle-orm";
import { messages, whatsappSessions, type Db } from "@wapi/db";
import { ok, fail, paginate } from "@wapi/contracts";
import { gateway, GatewayUnavailableError, SessionNotConnectedError } from "../gateway-client.ts";

/**
 * Message reads — `/info`, `/read` and `message-logs`.
 *
 * `message-logs` is where the Laravel paginator finally earns the fidelity work in
 * `packages/contracts/src/envelope.ts`, and it carries warts of its own that differ from the
 * session endpoints:
 *   - `id` and `whatsapp_session_id` are **strings**, not integers.
 *   - `content` is a **JSON-encoded string**, not an object.
 *   - timestamps are `"2023-10-27 10:30:15"` — space separated, no `T`, no `Z` — where session
 *     objects use ISO-8601. Their own `session-logs` example uses ISO with microseconds.
 * Three different timestamp formats in one API. All reproduced.
 */
export function messageReadRoutes(db: Db) {
  const app = new Hono();

  /** MySQL-style datetime, as the message-logs fixture shows. */
  const logTime = (d: Date) => d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

  /** GET /api/whatsapp-sessions/{id}/message-logs — PAT-scoped, paginated. */
  app.get("/whatsapp-sessions/:whatsappSession/message-logs", async (c) => {
    const { accountId } = c.get("auth");
    const sessionId = Number(c.req.param("whatsappSession"));
    if (!Number.isInteger(sessionId)) return c.json(fail("The specified session was not found."), 404);

    const [session] = await db
      .select({ id: whatsappSessions.id })
      .from(whatsappSessions)
      .where(and(eq(whatsappSessions.id, sessionId), eq(whatsappSessions.accountId, accountId)))
      .limit(1);
    if (!session) return c.json(fail("The specified session was not found."), 404);

    const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
    const perPage = Math.min(100, Math.max(1, Number(c.req.query("per_page") ?? 15) || 15));

    const [totals] = await db
      .select({ total: count() })
      .from(messages)
      .where(eq(messages.sessionId, sessionId));
    const total = totals?.total ?? 0;

    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(desc(messages.createdAt))
      .limit(perPage)
      .offset((page - 1) * perPage);

    const items = rows.map((m) => ({
      id: String(m.msgId),
      whatsapp_session_id: String(m.sessionId),
      to: m.remoteJid,
      // A JSON-encoded string, not an object — see the fixture.
      content: m.content ? JSON.stringify(m.content) : null,
      status: m.status,
      failed_reason: m.failedReason,
      created_at: logTime(m.createdAt),
      updated_at: logTime(m.updatedAt),
    }));

    return c.json(
      ok(
        paginate({
          items,
          page,
          perPage,
          total,
          path: `/api/whatsapp-sessions/${sessionId}/message-logs`,
        }),
      ),
    );
  });

  /**
   * GET /api/messages/{msgId}/info — session-key scoped.
   *
   * Returns BOTH identifiers: our integer `msgId` and WhatsApp's `key.id`. That duality is
   * the whole reason the sequence exists (PLAN.md §1.2).
   */
  app.get("/messages/:msgId/info", async (c) => {
    const auth = c.get("auth");
    if (auth.kind !== "session") return c.json(fail("This endpoint requires a session API key."), 403);

    const msgId = Number(c.req.param("msgId"));
    if (!Number.isInteger(msgId)) return c.json(fail("The specified message was not found."), 404);

    const [m] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.msgId, msgId), eq(messages.sessionId, auth.sessionId)))
      .limit(1);
    if (!m) return c.json(fail("The specified message was not found."), 404);

    const key = (m.waKey ?? {}) as Record<string, unknown>;
    return c.json(
      ok({
        remoteJid: m.remoteJid,
        id: key["id"] ?? null,
        msgId: m.msgId,
        key,
        message: m.content ?? null,
        messageTimestamp: Math.floor(m.createdAt.getTime() / 1000),
        status: m.status,
      }),
    );
  });

  /**
   * POST /api/messages/read — session-key scoped.
   *
   * Takes a WhatsApp `key`, not our integer msgId: it marks a *received* message read, and
   * inbound messages have no row in our table until the webhook pipeline stores them.
   */
  app.post("/messages/read", async (c) => {
    const auth = c.get("auth");
    if (auth.kind !== "session") return c.json(fail("This endpoint requires a session API key."), 403);

    const body = (await c.req.json().catch(() => ({}))) as { key?: Record<string, unknown> };
    const key = body.key;
    if (!key || typeof key["id"] !== "string" || !key["id"]) {
      return c.json(fail("The key.id field is required and must be a non-empty string."), 422);
    }
    if (typeof key["remoteJid"] !== "string" || !key["remoteJid"]) {
      return c.json(fail("The key.remoteJid field is required and must be a non-empty string."), 422);
    }

    try {
      await gateway.readMessages(auth.sessionId, [key]);
      return c.json(ok({ status: "read" }));
    } catch (err) {
      if (err instanceof SessionNotConnectedError) return c.json(fail(err.message), 409);
      if (err instanceof GatewayUnavailableError) {
        return c.json(fail("The WhatsApp service is temporarily unavailable. Please retry."), 503);
      }
      throw err;
    }
  });

  return app;
}
