import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { contacts, whatsappSessions, type Db } from "@wapi/db";
import { ok, fail, postApiSendPresenceUpdateBody } from "@wapi/contracts";
import { resolveRecipient, userToWire, validationFailure } from "@wapi/core";
import { gateway, GatewayUnavailableError, SessionNotConnectedError } from "../gateway-client.ts";

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

  /**
   * POST /api/send-presence-update — "typing…", "recording…", online.
   *
   * Fire-and-forget by nature: WhatsApp acknowledges nothing, so a 200 means the frame left, not
   * that anybody saw it. `delayMs` is accepted and ignored — holding a request open to sleep
   * server-side would occupy a connection to simulate something the caller can do better itself.
   */
  app.post("/send-presence-update", async (c) => {
    const auth = c.get("auth");
    if (auth.kind !== "session") return c.json(fail("This endpoint requires a session API key."), 403);

    const parsed = postApiSendPresenceUpdateBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(validationFailure(parsed.error), 422);

    const allowed = ["unavailable", "available", "composing", "recording", "paused"] as const;
    const type = parsed.data.type as (typeof allowed)[number];
    if (!allowed.includes(type)) {
      return c.json(fail(`The type field must be one of: ${allowed.join(", ")}.`), 422);
    }
    const r = resolveRecipient(parsed.data.jid);
    if (!r.ok) return c.json(fail("Error sending presence update: Invalid JID provided."), 422);

    try {
      await gateway.sendPresence(auth.sessionId, r.jid, type);
      return c.json(ok({ jid: parsed.data.jid, type }));
    } catch (err) {
      if (err instanceof SessionNotConnectedError) return c.json(fail(err.message), 409);
      if (err instanceof GatewayUnavailableError) {
        return c.json(fail("The WhatsApp service is temporarily unavailable. Please retry."), 503);
      }
      throw err;
    }
  });

  /**
   * GET /api/fetch-username/{identifier}.
   *
   * Read from the contact cache rather than asked for: WhatsApp volunteers a username on contact
   * events for accounts that have set one, and offers no way to request it. So `null` here means
   * "WhatsApp has not told us", which is indistinguishable from "they have none" — and is the
   * ordinary answer either way.
   */
  app.get("/fetch-username/:contact_identifier", async (c) => {
    const auth = c.get("auth");
    if (auth.kind !== "session") return c.json(fail("This endpoint requires a session API key."), 403);

    const r = resolveRecipient(c.req.param("contact_identifier"));
    if (!r.ok) return c.json(fail(r.reason), 422);

    const [row] = await db
      .select({ username: contacts.username })
      .from(contacts)
      .where(and(eq(contacts.sessionId, auth.sessionId), eq(contacts.jid, r.jid)))
      .limit(1);

    return c.json(ok({ jid: r.jid, username: row?.username ?? null }));
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
