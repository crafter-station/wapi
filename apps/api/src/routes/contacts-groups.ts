import { Hono } from "hono";
import type { Db } from "@wapi/db";
import { ok, fail } from "@wapi/contracts";
import { resolveRecipient } from "@wapi/core";
import { gateway, GatewayUnavailableError, SessionNotConnectedError } from "../gateway-client.ts";

/**
 * Contacts and groups — the breadth half of Tier 1.
 *
 * Mostly thin pass-throughs over the engine, which is exactly why PLAN.md §7 judged the last
 * twenty routes the cheapest twenty in the project. All session-key scoped: the key is the
 * selector, so none of them carry a session id.
 */
export function contactGroupRoutes(_db: Db) {
  const app = new Hono();

  const requireSession = (c: { get: (k: "auth") => { kind: string; sessionId?: number } }) => {
    const auth = c.get("auth");
    return auth.kind === "session" ? (auth.sessionId as number) : null;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const guard = async (c: any, fn: (sessionId: number) => Promise<Response>) => {
    const sessionId = requireSession(c);
    if (sessionId === null) return c.json(fail("This endpoint requires a session API key."), 403);
    try {
      return await fn(sessionId);
    } catch (err) {
      if (err instanceof SessionNotConnectedError) return c.json(fail(err.message), 409);
      if (err instanceof GatewayUnavailableError) {
        return c.json(fail("The WhatsApp service is temporarily unavailable. Please retry."), 503);
      }
      throw err;
    }
  };

  // ---- contacts ---------------------------------------------------------------------

  app.get("/contacts", (c) =>
    guard(c, async (sessionId) => {
      const { contacts } = await gateway.contacts(sessionId);
      return c.json(ok(contacts));
    }),
  );

  app.get("/contacts/:contactPhoneNumber", (c) =>
    guard(c, async (sessionId) => {
      const r = resolveRecipient(c.req.param("contactPhoneNumber"));
      if (!r.ok) return c.json(fail(r.reason), 422);
      const { contact } = await gateway.contact(sessionId, r.jid);
      if (!contact) return c.json(fail("The specified contact was not found."), 404);
      return c.json(ok(contact));
    }),
  );

  /**
   * GET /api/on-whatsapp/{identifier}.
   *
   * Note v7 stopped returning LIDs here, so a caller needing the LID must follow up with
   * /api/lid-from-pn — which is why both LID routes were promoted into Tier 1 (PLAN.md §1).
   */
  app.get("/on-whatsapp/:contact_identifier", (c) =>
    guard(c, async (sessionId) => {
      const raw = c.req.param("contact_identifier");
      const r = resolveRecipient(raw);
      if (!r.ok) return c.json(fail(r.reason), 422);
      const res = await gateway.onWhatsApp(sessionId, r.jid);
      return c.json(ok({ exists: res.exists, jid: res.jid }));
    }),
  );

  app.get("/lid-from-pn/:pn", (c) =>
    guard(c, async (sessionId) => {
      const r = resolveRecipient(c.req.param("pn"));
      if (!r.ok) return c.json(fail(r.reason), 422);
      const { lid } = await gateway.lidFromPn(sessionId, r.jid);
      if (!lid) return c.json(fail("No LID mapping is known for that phone number."), 404);
      return c.json(ok({ lid }));
    }),
  );

  /**
   * GET /api/pn-from-lid/{lid}.
   *
   * A miss here is legitimate, not an error: resolution is one-way, and `getPNForLID` only
   * succeeds for pairs already cached from inbound traffic (PLAN.md §1).
   */
  app.get("/pn-from-lid/:lid", (c) =>
    guard(c, async (sessionId) => {
      const { pn } = await gateway.pnFromLid(sessionId, c.req.param("lid"));
      if (!pn) return c.json(fail("No phone number mapping is known for that LID."), 404);
      return c.json(ok({ pn }));
    }),
  );

  // ---- groups -----------------------------------------------------------------------

  app.get("/groups", (c) =>
    guard(c, async (sessionId) => {
      const { groups } = await gateway.groups(sessionId);
      return c.json(ok(groups));
    }),
  );

  app.get("/groups/:groupJid/metadata", (c) =>
    guard(c, async (sessionId) => {
      const { group } = await gateway.groupMetadata(sessionId, c.req.param("groupJid"));
      if (!group) return c.json(fail("The specified group was not found."), 404);
      return c.json(ok(group));
    }),
  );

  app.get("/groups/:groupJid/participants", (c) =>
    guard(c, async (sessionId) => {
      const { group } = await gateway.groupMetadata(sessionId, c.req.param("groupJid"));
      if (!group) return c.json(fail("The specified group was not found."), 404);
      return c.json(ok(group.participants));
    }),
  );

  app.post("/groups", (c) =>
    guard(c, async (sessionId) => {
      const body = (await c.req.json().catch(() => ({}))) as { name?: string; participants?: string[] };
      if (!body.name) return c.json(fail("The name field is required."), 422);
      if (!Array.isArray(body.participants) || !body.participants.length) {
        return c.json(fail("The participants field is required and must not be empty."), 422);
      }
      const jids = resolveAll(body.participants);
      if ("error" in jids) return c.json(fail(jids.error), 422);
      const { group } = await gateway.createGroup(sessionId, body.name, jids.jids);
      return c.json(ok(group), 201);
    }),
  );

  for (const [suffix, action] of [
    ["add", "add"],
    ["remove", "remove"],
  ] as const) {
    app.post(`/groups/:groupJid/participants/${suffix}`, (c) =>
      guard(c, async (sessionId) => {
        const body = (await c.req.json().catch(() => ({}))) as { participants?: string[] };
        if (!Array.isArray(body.participants) || !body.participants.length) {
          return c.json(fail("The participants field is required and must not be empty."), 422);
        }
        const jids = resolveAll(body.participants);
        if ("error" in jids) return c.json(fail(jids.error), 422);
        const results = await gateway.updateParticipants(
          sessionId,
          c.req.param("groupJid"),
          jids.jids,
          action,
        );
        return c.json(ok(results.results));
      }),
    );
  }

  return app;
}

/** Participants arrive as phone numbers or JIDs; the engine needs JIDs. */
function resolveAll(input: string[]): { jids: string[] } | { error: string } {
  const jids: string[] = [];
  for (const p of input) {
    const r = resolveRecipient(p);
    if (!r.ok) return { error: `${p}: ${r.reason}` };
    jids.push(r.jid);
  }
  return { jids };
}
