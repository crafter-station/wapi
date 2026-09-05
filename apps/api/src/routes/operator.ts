import { Hono } from "hono";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { auditLogs, personalAccessTokens, webhookDispatches, type Db } from "@wapi/db";
import {
  fail,
  getApiAuditLogsBody,
  getApiDispatchesBody,
  ok,
  paginate,
  postApiTokensBody,
} from "@wapi/contracts";
import { generatePat, hashToken, validationFailure } from "@wapi/core";
import { gateway, GatewayUnavailableError, SessionNotConnectedError } from "../gateway-client.ts";

/**
 * Operator routes — **wapi extensions**, not part of the cloned interface.
 *
 * These are the four things the dashboard could do and the API could not: manage tokens, read the
 * audit trail, see webhook deliveries, and read a sandbox conversation. They exist because a CLI
 * without them would have needed `DATABASE_URL` on every user's machine to match the dashboard,
 * which is not a thing to ask of anyone using a hosted deployment.
 *
 * Being ours, they use our conventions rather than reproducing an upstream quirk — see
 * `packages/contracts/src/extensions.ts` for the bar each had to clear.
 */
export function operatorRoutes(db: Db) {
  const app = new Hono();

  const pageArgs = (c: { req: { query: (k: string) => string | undefined } }) => ({
    page: Math.max(1, Number(c.req.query("page") ?? 1) || 1),
    perPage: Math.min(100, Math.max(1, Number(c.req.query("per_page") ?? 15) || 15)),
  });

  const iso = (d: Date | null) => (d ? d.toISOString() : null);

  /**
   * POST /api/tokens — mint a Personal Access Token.
   *
   * The plaintext is returned exactly once. Only the hash is stored, so there is no endpoint that
   * can show it again, and `GET /api/tokens` deliberately cannot.
   *
   * Needs a PAT itself, which is not circular in practice: the first one comes from the browser
   * device flow. This is for the second machine.
   */
  app.post("/tokens", async (c) => {
    const { accountId } = c.get("auth");
    const parsed = postApiTokensBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(validationFailure(parsed.error), 422);

    const token = generatePat();
    const [row] = await db
      .insert(personalAccessTokens)
      .values({ accountId, name: parsed.data.name, tokenHash: hashToken(token) })
      .returning();

    return c.json(
      ok({ created_at: row!.createdAt.toISOString(), id: row!.id, name: row!.name, token }),
      201,
    );
  });

  /** GET /api/tokens — every token on the account, including revoked ones, never the secret. */
  app.get("/tokens", async (c) => {
    const { accountId } = c.get("auth");
    const rows = await db
      .select()
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.accountId, accountId))
      .orderBy(desc(personalAccessTokens.createdAt));

    return c.json(
      ok(
        rows.map((t) => ({
          created_at: t.createdAt.toISOString(),
          id: t.id,
          last_used_at: iso(t.lastUsedAt),
          name: t.name,
          revoked_at: iso(t.revokedAt),
        })),
      ),
    );
  });

  /**
   * DELETE /api/tokens/{id} — revoke.
   *
   * Marked revoked rather than deleted, so the audit trail keeps pointing at something. Revoking
   * the token you are holding is allowed and works: the call authenticates first, then the
   * credential stops working. That is a feature — it is how a CLI logs itself out of a machine
   * it no longer trusts.
   */
  app.delete("/tokens/:token", async (c) => {
    const { accountId } = c.get("auth");
    const id = Number(c.req.param("token"));
    if (!Number.isInteger(id)) return c.json(fail("The specified token was not found."), 404);

    const [row] = await db
      .update(personalAccessTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(personalAccessTokens.id, id),
          eq(personalAccessTokens.accountId, accountId),
          isNull(personalAccessTokens.revokedAt),
        ),
      )
      .returning();
    if (!row) return c.json(fail("The specified token was not found."), 404);

    return c.json({ message: "Token revoked successfully.", success: true });
  });

  /**
   * GET /api/audit-logs — every call this account made, newest first.
   *
   * Account-scoped rather than session-scoped on purpose: calls made with a PAT — creating a
   * session, rotating a key — belong to the account and have no session at all, so filing the
   * trail under a session would hide exactly the actions most worth auditing. `?session_id=`
   * narrows to one when that is what you want.
   */
  app.get("/audit-logs", async (c) => {
    const { accountId } = c.get("auth");
    const parsed = getApiAuditLogsBody.safeParse({
      page: c.req.query("page") ? Number(c.req.query("page")) : undefined,
      per_page: c.req.query("per_page") ? Number(c.req.query("per_page")) : undefined,
      session_id: c.req.query("session_id") ? Number(c.req.query("session_id")) : undefined,
    });
    if (!parsed.success) return c.json(validationFailure(parsed.error), 422);

    const { page, perPage } = pageArgs(c);
    const where = parsed.data.session_id
      ? and(eq(auditLogs.accountId, accountId), eq(auditLogs.sessionId, parsed.data.session_id))
      : eq(auditLogs.accountId, accountId);

    const [totals] = await db.select({ total: count() }).from(auditLogs).where(where);
    const rows = await db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(perPage)
      .offset((page - 1) * perPage);

    return c.json(
      ok(
        paginate({
          items: rows.map(auditToWire),
          page,
          perPage,
          path: "/api/audit-logs",
          total: totals?.total ?? 0,
        }),
      ),
    );
  });

  /** GET /api/audit-logs/{id} — one call, with the bodies the list omits. */
  app.get("/audit-logs/:auditLog", async (c) => {
    const { accountId } = c.get("auth");
    const id = Number(c.req.param("auditLog"));
    if (!Number.isInteger(id)) return c.json(fail("The specified audit log was not found."), 404);

    const [row] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.id, id), eq(auditLogs.accountId, accountId)))
      .limit(1);
    if (!row) return c.json(fail("The specified audit log was not found."), 404);

    /**
     * Bodies are only here, and only when `AUDIT_BODIES` was on when the call happened — the
     * retention sweep also nulls them after a week. Absent is normal, not an error.
     */
    return c.json(
      ok({ ...auditToWire(row), request_body: row.requestBody, response_body: row.responseBody }),
    );
  });

  /**
   * GET /api/dispatches — what the webhook worker sent for *this* session.
   *
   * Session-scoped, unlike the audit log: a dispatch belongs to one session, and the key is
   * already the selector everywhere else that is true. It is also what the CLI's `doctor` reads
   * while holding a session key.
   *
   * One row per event, updated in place across retries — so `attempts` climbing is the same row,
   * not five of them.
   */
  app.get("/dispatches", async (c) => {
    const auth = c.get("auth");
    if (auth.kind !== "session") {
      return c.json(fail("This endpoint requires a session API key."), 403);
    }

    const parsed = getApiDispatchesBody.safeParse({
      page: c.req.query("page") ? Number(c.req.query("page")) : undefined,
      per_page: c.req.query("per_page") ? Number(c.req.query("per_page")) : undefined,
    });
    if (!parsed.success) return c.json(validationFailure(parsed.error), 422);

    const { page, perPage } = pageArgs(c);
    const where = eq(webhookDispatches.sessionId, auth.sessionId);

    const [totals] = await db.select({ total: count() }).from(webhookDispatches).where(where);
    const rows = await db
      .select()
      .from(webhookDispatches)
      .where(where)
      .orderBy(desc(webhookDispatches.lastAttemptAt))
      .limit(perPage)
      .offset((page - 1) * perPage);

    return c.json(
      ok(
        paginate({
          items: rows.map((d) => ({
            attempts: d.attempts,
            event: d.event,
            first_attempt_at: d.firstAttemptAt.toISOString(),
            id: d.id,
            job_id: d.jobId,
            last_attempt_at: d.lastAttemptAt.toISOString(),
            last_error: d.lastError,
            status: d.status,
            status_code: d.statusCode,
            url: d.url,
          })),
          page,
          perPage,
          path: "/api/dispatches",
          total: totals?.total ?? 0,
        }),
      ),
    );
  });

  /**
   * GET /api/sandbox/thread — the fake conversation.
   *
   * The one piece of the dashboard's sandbox view that had no API, which meant a terminal could
   * drive a sandbox but never watch one. It lives in the gateway's memory, so it is not
   * paginated: it is bounded at 200 entries by construction.
   */
  app.get("/sandbox/thread", async (c) => {
    const auth = c.get("auth");
    if (auth.kind !== "session") {
      return c.json(fail("This endpoint requires a session API key."), 403);
    }

    try {
      const { thread } = await gateway.sandboxThread(auth.sessionId);
      return c.json(
        ok(
          thread.map((m) => ({
            at: m.at,
            from_me: m.fromMe,
            id: m.id,
            jid: m.jid,
            kind: m.kind,
            text: m.text,
          })),
        ),
      );
    } catch (err) {
      if (err instanceof SessionNotConnectedError) return c.json(fail(err.message), 409);
      if (err instanceof GatewayUnavailableError) {
        return c.json(fail("The WhatsApp service is temporarily unavailable. Please retry."), 503);
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not a sandbox session")) {
        return c.json(
          fail("This is not a sandbox session. Sandbox controls only apply to sandbox sessions."),
          422,
        );
      }
      throw err;
    }
  });

  return app;
}

function auditToWire(a: typeof auditLogs.$inferSelect) {
  return {
    country: a.country,
    created_at: a.createdAt.toISOString(),
    credential_kind: a.credentialKind,
    duration_ms: a.durationMs,
    id: a.id,
    ip: a.ip,
    method: a.method,
    path: a.path,
    route: a.route,
    status: a.status,
    whatsapp_session_id: a.sessionId,
  };
}
