/**
 * The gateway service.
 *
 * Internal only — no published port, no domain (PLAN.md §7). This is an unauthenticated-by-
 * design RPC surface protected solely by a shared secret and the Docker network, and two of
 * the loudest "mystery ban" reports in the research turned out to be hijacked open instances
 * used as spam relays. It must never be reachable from outside.
 *
 * Commands arrive over HTTP because the caller waits on a result (`send-message` needs the
 * WhatsApp ack before the API can write its row and return `msgId`). Events go out over Redis
 * pub/sub because they fan out to more than one consumer — the SSE stream in `web` and the
 * webhook queue both want `qrcode.updated` (PLAN.md §2).
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import pino from "pino";
import { createClient } from "redis";
import { createDb, whatsappSessions } from "@wapi/db";
import { eq } from "drizzle-orm";
import { BaileysEngine, SessionNotConnectedError } from "./engine/baileys-engine.js";
import { DispatchingEngine } from "./engine/dispatching-engine.js";
import { SandboxEngine } from "./engine/sandbox-engine.js";
import { quietSignal } from "./quiet-signal.js";
import { resumeSessions } from "./resume.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const REDIS_URL = process.env["REDIS_URL"];
const GATEWAY_TOKEN = process.env["GATEWAY_TOKEN"];
const PORT = Number(process.env["PORT"] ?? 3002);

if (!DATABASE_URL || !GATEWAY_TOKEN) {
  console.error("DATABASE_URL and GATEWAY_TOKEN are required.");
  process.exit(1);
}

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });
// libsignal prints SessionEntry objects — including ephemeral private keys — via console
// directly. In a container that is key material in shipped logs (PLAN.md §5).
quietSignal(logger);

const { db } = createDb(DATABASE_URL);

/**
 * Two engines behind one port.
 *
 * `engine` is a `DispatchingEngine`, which itself implements `WhatsAppEngine` — so `resumeSessions`
 * and every RPC route below are unchanged and cannot tell there are two. Routing is on the
 * `sandbox` column, and each engine additionally asserts its own precondition: the fake refuses a
 * session that is not marked sandbox, Baileys refuses one that is.
 *
 * That belt-and-braces is not ceremony. A sandbox session reaching Baileys fails loudly. A *real*
 * session reaching the fake does not — it would return a msgId, show as sent everywhere, and
 * never leave the building.
 */
const baileys = new BaileysEngine(db, logger);
const sandbox = new SandboxEngine(logger, async (sessionId) => {
  const [row] = await db
    .select({ sandbox: whatsappSessions.sandbox })
    .from(whatsappSessions)
    .where(eq(whatsappSessions.id, sessionId))
    .limit(1);
  if (!row?.sandbox) {
    throw new Error(`session ${sessionId} is not a sandbox session and must not reach the fake`);
  }
});
const engine = new DispatchingEngine(db, baileys, sandbox, logger);

/** Redis is optional at boot so the gateway still starts if it is briefly unavailable. */
const redis = REDIS_URL ? createClient({ url: REDIS_URL }) : null;
if (redis) {
  redis.on("error", (err) => logger.error({ err }, "redis error"));
  /**
   * Bounded, because the comment above was not true of the code below it.
   *
   * node-redis retries a failed initial connect indefinitely, so `await redis.connect()` never
   * settles while Redis is unreachable — and `serve()` is further down this file. The gateway
   * did not start "if Redis is briefly unavailable"; it hung, answering nothing, not even
   * /health. Found by pointing a local gateway at a Redis it could not reach.
   *
   * Waiting a little is still worth it: connecting before the first event avoids dropping the
   * events a resume emits. After that the client reconnects on its own, and `redis?.isReady`
   * already guards every publish.
   */
  await Promise.race([
    redis.connect().catch((err) => logger.error({ err }, "redis connect failed")),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (!redis.isReady) logger.warn("redis not ready; events are dropped until it connects");
}

const CHANNEL = "wapi:events";
engine.on((event) => {
  logger.debug({ event: event.type, sessionId: event.sessionId }, "engine event");
  if (redis?.isReady) {
    void redis.publish(CHANNEL, JSON.stringify(event)).catch((err) => logger.error({ err }, "publish failed"));
  }
});

const app = new Hono();

/** Shared-secret guard. Constant-time compare so the token is not probeable by timing. */
app.use("/rpc/*", async (c, next) => {
  const given = c.req.header("X-Gateway-Token") ?? "";
  const expected = GATEWAY_TOKEN;
  if (given.length !== expected.length || given !== expected) {
    return c.json({ error: "forbidden" }, 403);
  }
  await next();
});

app.get("/health", (c) =>
  c.json({ status: "ok", service: "wapi-gateway", redis: redis?.isReady ?? false }),
);

app.post("/rpc/connect", async (c) => {
  const { sessionId, accountProtection } = await c.req.json();
  const r = await engine.connect(Number(sessionId), { accountProtection: Boolean(accountProtection) });
  return c.json(r);
});

app.post("/rpc/disconnect", async (c) => {
  const { sessionId } = await c.req.json();
  await engine.disconnect(Number(sessionId));
  return c.json({ ok: true });
});

app.post("/rpc/restart", async (c) => {
  const { sessionId } = await c.req.json();
  return c.json(await engine.restart(Number(sessionId)));
});

app.post("/rpc/logout", async (c) => {
  const { sessionId } = await c.req.json();
  await engine.logout(Number(sessionId));
  return c.json({ ok: true });
});

app.get("/rpc/state/:sessionId", (c) => {
  const id = Number(c.req.param("sessionId"));
  return c.json({
    status: engine.status(id),
    qr: engine.currentQr(id),
    identity: engine.identity(id),
  });
});

/** One RPC for the whole documented union — their API has one route, so this has one method. */
app.post("/rpc/send", async (c) => {
  const { sessionId, to, content, opts } = await c.req.json();
  try {
    const r = await engine.send(Number(sessionId), String(to), content, opts ?? {});
    return c.json(r);
  } catch (err) {
    if (err instanceof SessionNotConnectedError) {
      return c.json({ error: "not_connected", message: err.message }, 409);
    }
    throw err;
  }
});

app.post("/rpc/send-text", async (c) => {
  const { sessionId, to, text, quoted } = await c.req.json();
  try {
    const r = await engine.sendText(Number(sessionId), String(to), String(text), { quoted });
    return c.json(r);
  } catch (err) {
    if (err instanceof SessionNotConnectedError) {
      // Surfaced to the caller so the API can return their exact documented string.
      return c.json({ error: "not_connected", message: err.message }, 409);
    }
    throw err;
  }
});

/**
 * Contacts, groups and reads. Thin pass-throughs: the engine holds all the logic, and a
 * SessionNotConnectedError becomes a 409 so the API can return their exact documented string.
 */
const rpc = <T>(fn: () => Promise<T>) => async (c: { json: (b: unknown, s?: number) => Response }) => {
  try {
    return c.json(await fn());
  } catch (err) {
    if (err instanceof SessionNotConnectedError) {
      return c.json({ error: "not_connected", message: err.message }, 409);
    }
    throw err;
  }
};

app.post("/rpc/read-messages", async (c) => {
  const { sessionId, keys } = await c.req.json();
  return rpc(() => engine.readMessages(Number(sessionId), keys).then(() => ({ ok: true })))(c);
});

app.post("/rpc/react", async (c) => {
  const { sessionId, key, emoji } = await c.req.json();
  return rpc(() => engine.reactToMessage(Number(sessionId), key, String(emoji ?? "")))(c);
});

/**
 * Sandbox controls.
 *
 * On the dispatcher rather than the port: `WhatsAppEngine` describes what a WhatsApp engine can
 * do, and "fabricate an inbound message" is not that. Adding it to the port would oblige the
 * Baileys engine to implement something it can never honour.
 *
 * Both refuse a session that is not marked sandbox, so a mis-addressed control cannot poke a
 * real session.
 */
app.post("/rpc/sandbox-inbound", async (c) => {
  const { sessionId, from, text } = await c.req.json();
  return rpc(() => engine.sandboxInbound(Number(sessionId), from, String(text ?? "")))(c);
});

app.post("/rpc/sandbox-scan", async (c) => {
  const { sessionId } = await c.req.json();
  return rpc(() => engine.sandboxScan(Number(sessionId)).then(() => ({ ok: true })))(c);
});

app.post("/rpc/sandbox-thread", async (c) => {
  const { sessionId } = await c.req.json();
  return rpc(() => engine.sandboxThread(Number(sessionId)))(c);
});

app.post("/rpc/leave-group", async (c) => {
  const { sessionId, jid } = await c.req.json();
  return rpc(() => engine.leaveGroup(Number(sessionId), String(jid)).then(() => ({ ok: true })))(c);
});

app.post("/rpc/group-invite-code", async (c) => {
  const { sessionId, jid } = await c.req.json();
  return rpc(() => engine.groupInviteCode(Number(sessionId), String(jid)).then((code) => ({ code })))(c);
});

app.post("/rpc/group-by-invite", async (c) => {
  const { sessionId, code } = await c.req.json();
  return rpc(() => engine.groupByInvite(Number(sessionId), String(code)).then((group) => ({ group })))(c);
});

app.post("/rpc/accept-group-invite", async (c) => {
  const { sessionId, code } = await c.req.json();
  return rpc(() => engine.acceptGroupInvite(Number(sessionId), String(code)).then((jid) => ({ jid })))(c);
});

app.post("/rpc/group-settings", async (c) => {
  const { sessionId, jid, settings } = await c.req.json();
  return rpc(() =>
    engine.updateGroupSettings(Number(sessionId), String(jid), settings ?? {}).then(() => ({ ok: true })),
  )(c);
});

app.post("/rpc/save-contact", async (c) => {
  const { sessionId, jid, fullName } = await c.req.json();
  return rpc(() =>
    engine.saveContact(Number(sessionId), String(jid), fullName ?? null).then(() => ({ ok: true })),
  )(c);
});

app.post("/rpc/block-contact", async (c) => {
  const { sessionId, jid, action } = await c.req.json();
  return rpc(() =>
    engine.blockContact(Number(sessionId), String(jid), action === "unblock" ? "unblock" : "block").then(() => ({ ok: true })),
  )(c);
});

app.post("/rpc/profile-picture", async (c) => {
  const { sessionId, jid } = await c.req.json();
  return rpc(() => engine.profilePicture(Number(sessionId), String(jid)).then((url) => ({ url })))(c);
});

app.post("/rpc/on-whatsapp", async (c) => {
  const { sessionId, identifier } = await c.req.json();
  return rpc(() => engine.onWhatsApp(Number(sessionId), String(identifier)))(c);
});

app.get("/rpc/contacts/:sessionId", (c) =>
  rpc(() => engine.contacts(Number(c.req.param("sessionId"))).then((contacts) => ({ contacts })))(c));

/**
 * Media comes back base64 over this JSON transport. Bounded by the 16 MB cap the API enforces
 * before calling, so the ~33% encoding overhead is acceptable versus adding a binary channel.
 */
app.post("/rpc/download-media", async (c) => {
  const { sessionId, message } = await c.req.json();
  return rpc(async () => {
    const r = await engine.downloadMedia(Number(sessionId), message);
    if (!r) return { media: null };
    return {
      media: { base64: r.data.toString("base64"), mimetype: r.mimetype, fileName: r.fileName },
    };
  })(c);
});

app.post("/rpc/sync-contacts", async (c) => {
  const { sessionId } = await c.req.json();
  return rpc(() => engine.syncContacts(Number(sessionId)).then(() => ({ ok: true })))(c);
});

app.post("/rpc/contact", async (c) => {
  const { sessionId, jid } = await c.req.json();
  return rpc(() => engine.contact(Number(sessionId), String(jid)).then((contact) => ({ contact })))(c);
});

app.post("/rpc/lid-from-pn", async (c) => {
  const { sessionId, pn } = await c.req.json();
  return rpc(() => engine.lidFromPn(Number(sessionId), String(pn)).then((lid) => ({ lid })))(c);
});

app.post("/rpc/pn-from-lid", async (c) => {
  const { sessionId, lid } = await c.req.json();
  return rpc(() => engine.pnFromLid(Number(sessionId), String(lid)).then((pn) => ({ pn })))(c);
});

app.get("/rpc/groups/:sessionId", (c) =>
  rpc(() => engine.groups(Number(c.req.param("sessionId"))).then((groups) => ({ groups })))(c));

app.post("/rpc/group-metadata", async (c) => {
  const { sessionId, jid } = await c.req.json();
  return rpc(() => engine.groupMetadata(Number(sessionId), String(jid)).then((group) => ({ group })))(c);
});

app.post("/rpc/group-create", async (c) => {
  const { sessionId, subject, participants } = await c.req.json();
  return rpc(() => engine.createGroup(Number(sessionId), String(subject), participants).then((group) => ({ group })))(c);
});

app.post("/rpc/group-participants", async (c) => {
  const { sessionId, jid, participants, action } = await c.req.json();
  return rpc(() =>
    engine.updateParticipants(Number(sessionId), String(jid), participants, action).then((results) => ({ results })),
  )(c);
});

app.onError((err, c) => {
  logger.error({ err: err.message, path: c.req.path }, "gateway error");
  return c.json({ error: "internal", message: err.message }, 500);
});

logger.info({ port: PORT }, "wapi-gateway listening (internal only)");
serve({ fetch: app.fetch, port: PORT });

/**
 * Resume after the HTTP server is listening, not before.
 *
 * Reconnecting can take a while with several sessions, and the api container's health check
 * and depends_on should not wait on it. A gateway that is up but still resuming is a better
 * state than one that looks down.
 */
void resumeSessions(db, engine, logger).catch((err) =>
  logger.error({ err: String(err) }, "resume threw"),
);
