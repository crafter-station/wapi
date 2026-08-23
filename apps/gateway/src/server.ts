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
import { createDb } from "@wapi/db";
import { BaileysEngine, SessionNotConnectedError } from "./engine/baileys-engine.js";
import { quietSignal } from "./quiet-signal.js";

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
const engine = new BaileysEngine(db, logger);

/** Redis is optional at boot so the gateway still starts if it is briefly unavailable. */
const redis = REDIS_URL ? createClient({ url: REDIS_URL }) : null;
if (redis) {
  redis.on("error", (err) => logger.error({ err }, "redis error"));
  await redis.connect().catch((err) => logger.error({ err }, "redis connect failed"));
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

app.onError((err, c) => {
  logger.error({ err: err.message, path: c.req.path }, "gateway error");
  return c.json({ error: "internal", message: err.message }, 500);
});

logger.info({ port: PORT }, "wapi-gateway listening (internal only)");
serve({ fetch: app.fetch, port: PORT });
