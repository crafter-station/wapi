import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { whatsappSessions, type Db } from "@wapi/db";
import { ok, fail } from "@wapi/contracts";
import { userToWire } from "@wapi/core";
import { gateway, GatewayUnavailableError } from "../gateway-client.ts";

/**
 * Connection lifecycle and identity — PLAN.md §8 phase 3.
 *
 * Four different success envelopes appear in this file alone, all verified against their
 * documented responses (§1.4):
 *   connect    -> { success, data: { status: "NEED_SCAN", qrCode } }   status SCREAMING
 *   disconnect -> { success, data: { status, message } }
 *   restart    -> { success, message }                                  no data
 *   status     -> { status: "connected" }                               no envelope at all
 *
 * They are not unified on purpose. Their published SDKs parse what Laravel actually emits.
 */
export function connectionRoutes(db: Db) {
  const app = new Hono();

  /** PAT-scoped: connect a specific session. Returns the QR inline when one is ready. */
  app.post("/whatsapp-sessions/:whatsappSession/connect", async (c) => {
    const row = await findOwned(db, c.get("auth").accountId, c.req.param("whatsappSession"));
    if (!row) return c.json(fail("The specified session was not found."), 404);

    try {
      const r = await gateway.connect(row.id, row.accountProtection);
      await db
        .update(whatsappSessions)
        .set({ status: r.status, updatedAt: new Date() })
        .where(eq(whatsappSessions.id, row.id));

      // Status is SCREAMING in connect responses and lowercase in list responses. Copying
      // the inconsistency is the point — see PLAN.md §1.3.
      const data: Record<string, unknown> = { status: r.status.toUpperCase() };
      if (r.qr) data["qrCode"] = r.qr;
      return c.json(ok(data));
    } catch (err) {
      return gatewayError(c, err);
    }
  });

  app.post("/whatsapp-sessions/:whatsappSession/disconnect", async (c) => {
    const row = await findOwned(db, c.get("auth").accountId, c.req.param("whatsappSession"));
    if (!row) return c.json(fail("The specified session was not found."), 404);
    try {
      await gateway.disconnect(row.id);
      await db
        .update(whatsappSessions)
        .set({ status: "disconnected", updatedAt: new Date() })
        .where(eq(whatsappSessions.id, row.id));
      return c.json(ok({ status: "disconnected", message: "WhatsApp session disconnected successfully" }));
    } catch (err) {
      return gatewayError(c, err);
    }
  });

  /** Their documented refusal: a session that is not connected cannot be restarted. */
  app.post("/whatsapp-sessions/:whatsappSession/restart", async (c) => {
    const row = await findOwned(db, c.get("auth").accountId, c.req.param("whatsappSession"));
    if (!row) return c.json(fail("The specified session was not found."), 404);
    try {
      const state = await gateway.state(row.id);
      if (state.status !== "connected") {
        return c.json(fail("WhatsApp session is not connected. Cannot restart."), 409);
      }
      await gateway.restart(row.id);
      // Note: `message` at the top level, no `data`.
      return c.json({ success: true, message: "WhatsApp session restarted successfully." });
    } catch (err) {
      return gatewayError(c, err);
    }
  });

  app.get("/whatsapp-sessions/:whatsappSession/qrcode", async (c) => {
    const row = await findOwned(db, c.get("auth").accountId, c.req.param("whatsappSession"));
    if (!row) return c.json(fail("The specified session was not found."), 404);
    try {
      const state = await gateway.state(row.id);
      if (!state.qr) {
        return c.json(fail("Session not initialized. Call the connect endpoint first."), 409);
      }
      return c.json(ok({ qrCode: state.qr }));
    } catch (err) {
      return gatewayError(c, err);
    }
  });

  /**
   * GET /api/status — session-key scoped, and note the envelope: a bare `{ "status": ... }`
   * with no `success` and no `data`. That is what their documentation shows.
   *
   * Staleness deliberately does NOT appear here. There is no "connected but stale" among
   * their seven statuses, so it lives in the dashboard only (PLAN.md §9).
   */
  app.get("/status", async (c) => {
    const auth = c.get("auth");
    if (auth.kind !== "session") return c.json(fail("This endpoint requires a session API key."), 403);
    try {
      const state = await gateway.state(auth.sessionId);
      return c.json({ status: state.status });
    } catch {
      // A gateway outage is not a session state; report the last thing we stored.
      const [row] = await db
        .select({ status: whatsappSessions.status })
        .from(whatsappSessions)
        .where(eq(whatsappSessions.id, auth.sessionId))
        .limit(1);
      return c.json({ status: row?.status ?? "disconnected" });
    }
  });

  /** GET /api/user — the WhatsApp identity behind the session key. Returns `lid` first-class. */
  app.get("/user", async (c) => {
    const auth = c.get("auth");
    if (auth.kind !== "session") return c.json(fail("This endpoint requires a session API key."), 403);
    try {
      const state = await gateway.state(auth.sessionId);
      if (!state.identity) {
        return c.json(fail("Your Whatsapp Session is not connected please connect your session first."), 409);
      }
      return c.json(ok(userToWire(state.identity)));
    } catch (err) {
      return gatewayError(c, err);
    }
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

/** A gateway outage is our fault, not the caller's — 503, controller envelope. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function gatewayError(c: any, err: unknown) {
  if (err instanceof GatewayUnavailableError) {
    return c.json(fail("The WhatsApp service is temporarily unavailable. Please retry."), 503);
  }
  throw err;
}
