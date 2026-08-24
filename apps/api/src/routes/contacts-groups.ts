import { Hono } from "hono";
import type { Db } from "@wapi/db";
import { ok, fail, directoryPage } from "@wapi/contracts";
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

  /**
   * `?paginated=true` selects a different envelope entirely.
   *
   * Documented by the original on both endpoints, and already declared in our own generated
   * contract (`getApiContactsBody` / `getApiGroupsBody`) — this handler simply ignored it until
   * a real consumer asked for it. Consumers validate the page strictly: it is rejected unless
   * `totalPages === max(1, ceil(total / limit))`, `page` echoes the request, and
   * `items.length <= limit`. Returning the flat array to a caller that asked for pagination
   * fails on its first call, so this is a compatibility requirement rather than a nicety.
   */
  const pageArgs = (c: { req: { query: (k: string) => string | undefined } }) => {
    if (c.req.query("paginated") !== "true") return null;
    const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
    // 20 is their documented default, not a round number of our choosing.
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 20) || 20));
    return { page, limit };
  };

  // ---- contacts ---------------------------------------------------------------------

  app.get("/contacts", (c) =>
    guard(c, async (sessionId) => {
      let { contacts } = await gateway.contacts(sessionId);
      /**
       * An empty cache on a connected session means this session predates the cache, or was
       * reconnected with existing sync data so Baileys never re-emitted contacts. Trigger one
       * resync and let the caller retry, rather than returning [] as if that were the answer.
       */
      if (!contacts.length) {
        await gateway.syncContacts(sessionId).catch(() => {});
        ({ contacts } = await gateway.contacts(sessionId));
      }

      const paging = pageArgs(c);
      if (!paging) return c.json(ok(contacts));

      const { page, limit } = paging;
      const items = contacts.slice((page - 1) * limit, page * limit).map((x) => ({
        // `jid` and `id` are both emitted with the same value: consumers accept either, and
        // reject the entry outright if both are present and differ.
        jid: x.jid,
        id: x.jid,
        name: x.name,
        notify: x.notify,
        verifiedName: null,
        /**
         * Documented keys we cannot fill, present and null rather than absent.
         *
         * A profile picture and an "about" string are per-contact fetches against WhatsApp;
         * doing them for every row would turn one list call into N network round-trips. Their
         * own groups example ships `imgUrl: null`, so null is the documented shape for
         * "not known", and omitting the key entirely is what breaks a typed client.
         */
        imgUrl: null,
        status: null,
        phoneNumber: x.phoneNumber,
        lid: x.lid,
      }));
      return c.json(ok(directoryPage({ items, page, limit, total: contacts.length })));
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

      const paging = pageArgs(c);
      if (!paging) return c.json(ok(groups));

      const { page, limit } = paging;
      const items = groups.slice((page - 1) * limit, page * limit).map((g) => ({
        jid: g.id,
        id: g.id,
        /**
         * A group's title has to appear as `name`, not only `subject`.
         *
         * Directory consumers read `name` for both contacts and groups; a paginated group page
         * carrying only `subject` parses successfully and yields every group unnamed, which is
         * worse than failing. `subject` is kept alongside for our own callers.
         */
        name: g.subject,
        subject: g.subject,
        notify: null,
        verifiedName: null,
        imgUrl: null,
        owner: g.owner,
        creation: g.creation,
        desc: g.desc,
        participants: g.participants,
      }));
      return c.json(ok(directoryPage({ items, page, limit, total: groups.length })));
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
