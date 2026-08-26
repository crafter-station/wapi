import { Hono } from "hono";

/**
 * Our lifecycle status to WhatsApp's ack enum, as Baileys defines it: ERROR 0, PENDING 1,
 * SERVER_ACK 2, DELIVERY_ACK 3, READ 4, PLAYED 5. Inferred rather than documented — recorded
 * in PLAN.md §10 — but anchored by their own example, which shows 2 for a sent message.
 */
const WA_ACK: Record<string, number> = {
  failed: 0,
  in_progress: 1,
  sent: 2,
  delivered: 3,
  read: 4,
};
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
        /**
         * Both of these are typed the way the WhatsApp record types them, not the way our own
         * row does, because this endpoint returns that record.
         *
         * `messageTimestamp` is a string: it is a protobuf int64, which JSON-serialises as a
         * string, and their documented example shows one. `status` is WhatsApp's numeric ack
         * rather than our lifecycle word — their example shows `2` on a sent message, which is
         * SERVER_ACK in Baileys' own enum and corroborates the mapping below. A client typed
         * against the documented response broke on both.
         */
        messageTimestamp: String(Math.floor(m.createdAt.getTime() / 1000)),
        status: WA_ACK[m.status] ?? 1,
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

  /**
   * POST /api/messages/react — session-key scoped. **A wapi extension.**
   *
   * WasenderAPI emits `messages.reaction` as a webhook but documents no way to send one; none of
   * the 51 endpoints in the mirrored spec does. This is therefore ours, and lives in
   * `packages/contracts/src/extensions.ts` rather than the generated route table so the cloned
   * surface stays exactly the 29 endpoints being reproduced.
   *
   * Keyed the same way as `/messages/read`, for the same reason: the useful case is reacting to
   * a message someone *else* sent, and inbound messages have no row in our table. `msgId` only
   * ever identifies something we sent.
   */
  app.post("/messages/react", async (c) => {
    const auth = c.get("auth");
    if (auth.kind !== "session") return c.json(fail("This endpoint requires a session API key."), 403);

    const body = (await c.req.json().catch(() => ({}))) as {
      key?: Record<string, unknown>;
      emoji?: unknown;
    };
    const key = body.key;
    if (!key || typeof key["id"] !== "string" || !key["id"]) {
      return c.json(fail("The key.id field is required and must be a non-empty string."), 422);
    }
    if (typeof key["remoteJid"] !== "string" || !key["remoteJid"]) {
      return c.json(fail("The key.remoteJid field is required and must be a non-empty string."), 422);
    }
    /**
     * An empty string is valid and means "remove the reaction" — WhatsApp's own convention
     * rather than a separate call. Rejecting blanks would leave no way to undo one.
     */
    if (typeof body.emoji !== "string") {
      return c.json(fail("The emoji field is required and must be a string."), 422);
    }
    const emoji = body.emoji;
    if ([...emoji].length > 8) {
      return c.json(fail("The emoji field must be a single emoji."), 422);
    }

    try {
      const { id } = await gateway.reactToMessage(auth.sessionId, key, emoji);
      return c.json(ok({ id, emoji }));
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
