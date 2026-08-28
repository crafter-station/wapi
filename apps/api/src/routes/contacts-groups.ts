import { Hono } from "hono";
import type { Db } from "@wapi/db";
import { ok, fail, directoryPage, putApiContactsBody } from "@wapi/contracts";
import {
  contactToWire,
  groupToWire,
  participantToWire,
  resolveRecipient,
  validationFailure,
} from "@wapi/core";
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
      // The same wire shape as a paginated entry; only the envelope around it differs.
      if (!paging) return c.json(ok(contacts.map(contactToWire)));

      const { page, limit } = paging;
      const items = contacts.slice((page - 1) * limit, page * limit).map(contactToWire);
      return c.json(ok(directoryPage({ items, page, limit, total: contacts.length })));
    }),
  );

  app.get("/contacts/:contactPhoneNumber", (c) =>
    guard(c, async (sessionId) => {
      const r = resolveRecipient(c.req.param("contactPhoneNumber"));
      if (!r.ok) return c.json(fail(r.reason), 422);
      const { contact } = await gateway.contact(sessionId, r.jid);
      if (!contact) return c.json(fail("The specified contact was not found."), 404);
      /**
       * Their detail shape is keyed on `id`, not `jid`, and carries `verifiedName`, `imgUrl`
       * and `status`. We returned the raw cache row, so a client reading the documented `id`
       * got undefined. `jid` and the LID pair stay alongside as additions.
       */
      return c.json(ok(contactToWire(contact)));
    }),
  );

  /**
   * PUT /api/contacts — save a contact to this session's address book.
   *
   * **Local to wapi, and deliberately so.** WhatsApp has no "write to the address book" call that
   * Baileys exposes, so the name goes into whatever this session's engine uses as its contact
   * source — the cache table for a real session, the derived directory for a sandbox. Either way
   * `GET /api/contacts` reflects it, and either way the name is *ours*: it never appears on the
   * linked phone and does not survive the account moving to another wapi install.
   *
   * `saveOnPrimaryAddressbook` is accepted and ignored for that reason. Rejecting it would break
   * a client that sends it; pretending to honour it would be worse.
   */
  app.put("/contacts", (c) =>
    guard(c, async (sessionId) => {
      const parsed = putApiContactsBody.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.json(validationFailure(parsed.error), 422);

      const r = resolveRecipient(parsed.data.jid);
      if (!r.ok) return c.json(fail(r.reason), 422);

      const fullName = parsed.data.fullName ?? null;
      await gateway.saveContact(sessionId, r.jid, fullName);
      return c.json(ok({ fullName, jid: r.jid }));
    }),
  );

  /** POST /api/contacts/{n}/block and /unblock — one handler, since only the verb differs. */
  for (const action of ["block", "unblock"] as const) {
    app.post(`/contacts/:contactPhoneNumber/${action}`, (c) =>
      guard(c, async (sessionId) => {
        const r = resolveRecipient(c.req.param("contactPhoneNumber"));
        if (!r.ok) return c.json(fail(r.reason), 422);
        await gateway.blockContact(sessionId, r.jid, action);
        // Their wording, capitalised as documented: "Contact blocked" / "Contact unblocked".
        return c.json(ok({ message: `Contact ${action}ed` }));
      }),
    );
  }

  /**
   * GET /api/contacts/{n}/picture.
   *
   * `imgUrl: null` is a success, not a 404. Most accounts either have no picture or restrict it
   * to their own contacts, so treating absence as an error would make the common case look
   * broken — and would be indistinguishable from the JID not existing.
   */
  app.get("/contacts/:contactPhoneNumber/picture", (c) =>
    guard(c, async (sessionId) => {
      const r = resolveRecipient(c.req.param("contactPhoneNumber"));
      if (!r.ok) return c.json(fail(r.reason), 422);
      const { url } = await gateway.profilePicture(sessionId, r.jid);
      return c.json(ok({ imgUrl: url }));
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
      // Their documented keys first (`jid`, `name`, `imgUrl`); ours are additive.
      if (!paging) return c.json(ok(groups.map(groupToWire)));

      const { page, limit } = paging;
      /**
       * The same wire shape as the flat list, plus the two keys a directory consumer reads.
       *
       * `groupToWire` is what guarantees the title appears as `name` and not only `subject`:
       * directory consumers read `name` for both contacts and groups, so a page carrying only
       * `subject` parses successfully and yields every group unnamed, which is worse than
       * failing outright.
       */
      const items = groups.slice((page - 1) * limit, page * limit).map((g) => ({
        ...groupToWire(g),
        notify: null,
        verifiedName: null,
      }));
      return c.json(ok(directoryPage({ items, page, limit, total: groups.length })));
    }),
  );

  app.get("/groups/:groupJid/metadata", (c) =>
    guard(c, async (sessionId) => {
      const { group } = await gateway.groupMetadata(sessionId, c.req.param("groupJid"));
      if (!group) return c.json(fail("The specified group was not found."), 404);
      return c.json(ok(groupToWire(group)));
    }),
  );

  app.get("/groups/:groupJid/participants", (c) =>
    guard(c, async (sessionId) => {
      const { group } = await gateway.groupMetadata(sessionId, c.req.param("groupJid"));
      if (!group) return c.json(fail("The specified group was not found."), 404);
      return c.json(ok(group.participants.map(participantToWire)));
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
