/**
 * Webhook delivery worker.
 *
 * Subscribes to the gateway's Redis channel, expands each engine event into the documented
 * public events, filters by what the session subscribed to, and delivers over HTTP with
 * retry and backoff (PLAN.md §1, §2).
 *
 * Signature: their scheme is a **plain string compare** of `X-Webhook-Signature` against the
 * stored secret — not an HMAC. We reproduce that as the default for drop-in compatibility and
 * offer HMAC-SHA256 over the raw body as an opt-in per session, so we are not shipping the
 * weaker thing as the only option.
 */
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { createClient } from "redis";
import pino from "pino";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, whatsappSessions, type WhatsappSession } from "@wapi/db";
import { toPublicEvents, passesSessionFilters, type PublicEvent } from "./events.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const REDIS_URL = process.env["REDIS_URL"];
if (!DATABASE_URL || !REDIS_URL) {
  console.error("DATABASE_URL and REDIS_URL are required.");
  process.exit(1);
}

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });
const { db } = createDb(DATABASE_URL);

const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const QUEUE = "webhooks";

type JobData = { sessionId: number; event: string; data: unknown };

const queue = new Queue<JobData>(QUEUE, { connection });

/**
 * Session config is read per delivery batch rather than cached.
 *
 * Their docs say updating a session "syncs webhook settings with the WhatsApp API server",
 * so a change must take effect promptly. A stale cache here means events silently going to
 * an old URL, which is worse than the query.
 */
async function loadSession(sessionId: number): Promise<WhatsappSession | null> {
  const [row] = await db
    .select()
    .from(whatsappSessions)
    .where(eq(whatsappSessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

/** Subscribe to the gateway and enqueue whatever it emits. */
const sub = createClient({ url: REDIS_URL });
sub.on("error", (err) => logger.error({ err }, "redis subscriber error"));
await sub.connect();

await sub.subscribe("wapi:events", async (raw) => {
  let engineEvent: { type: string; sessionId: number; event?: string; payload?: unknown; status?: string; qr?: string };
  try {
    engineEvent = JSON.parse(raw);
  } catch {
    logger.warn("unparseable event on wapi:events");
    return;
  }

  const sessionId = engineEvent.sessionId;
  const session = await loadSession(sessionId);
  if (!session) return;

  // `last_event_at` powers the dashboard staleness signal. It deliberately never reaches
  // GET /api/status — their seven statuses have no "connected but stale" (PLAN.md §9).
  void db
    .update(whatsappSessions)
    .set({ lastEventAt: new Date() })
    .where(eq(whatsappSessions.id, sessionId))
    .catch(() => {});

  if (!session.webhookEnabled || !session.webhookUrl) return;

  const publicEvents: PublicEvent[] = [];
  if (engineEvent.type === "status" && engineEvent.status) {
    publicEvents.push({ event: "session.status", data: { status: engineEvent.status } });
  } else if (engineEvent.type === "qr" && engineEvent.qr) {
    publicEvents.push({ event: "qrcode.updated", data: { qrCode: engineEvent.qr } });
  } else if (engineEvent.type === "wa" && engineEvent.event) {
    publicEvents.push(...toPublicEvents(engineEvent.event, engineEvent.payload));
  }

  const subscribed = new Set(session.webhookEvents ?? []);
  for (const e of publicEvents) {
    if (subscribed.size && !subscribed.has(e.event)) continue;
    if (
      !passesSessionFilters(e, {
        ignoreGroups: session.ignoreGroups,
        ignoreChannels: session.ignoreChannels,
        ignoreBroadcasts: session.ignoreBroadcasts,
      })
    ) {
      continue;
    }
    await queue.add(e.event, { sessionId, event: e.event, data: e.data }, {
      attempts: 5,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }
});

logger.info("subscribed to wapi:events");

/** Deliver one webhook. Throwing marks the job for retry with backoff. */
new Worker<JobData>(
  QUEUE,
  async (job: Job<JobData>) => {
    const session = await loadSession(job.data.sessionId);
    if (!session?.webhookUrl) return;

    const body = JSON.stringify({
      event: job.data.event,
      sessionId: job.data.sessionId,
      timestamp: Math.floor(Date.now() / 1000),
      data: job.data.data,
    });

    const signature = session.webhookHmac
      ? createHmac("sha256", session.webhookSecret ?? "").update(body).digest("hex")
      : (session.webhookSecret ?? "");

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(session.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Webhook-Signature": signature },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`webhook responded ${res.status}`);
      logger.debug({ event: job.data.event, sessionId: job.data.sessionId }, "delivered");
    } finally {
      clearTimeout(timer);
    }
  },
  { connection, concurrency: 10 },
).on("failed", (job, err) => {
  logger.warn(
    { event: job?.data.event, attempts: job?.attemptsMade, err: err.message },
    "webhook delivery failed",
  );
});

logger.info("webhook worker running");
