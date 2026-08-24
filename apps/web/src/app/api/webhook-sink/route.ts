import { createDb, webhookDeliveries } from "@wapi/db";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A webhook receiver, hosted by us.
 *
 * Webhook HTTP delivery was the last unproven path in the system: the Redis chain was
 * verified, but nothing had ever actually been POSTed anywhere. Proving it needs a receiver,
 * and pointing one at a third-party inspector would ship real WhatsApp message content to
 * someone else's server. So the sink lives here.
 *
 * It doubles as a debugging view — "what did we actually send, and did the signature match"
 * is the first question anyone integrating webhooks asks.
 *
 * Deliberately in the dashboard app, not the public API: it is not part of the 29-route
 * WasenderAPI surface and must not pollute it.
 */

let dbSingleton: ReturnType<typeof createDb> | null = null;
function db() {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set");
  dbSingleton ??= createDb(url, { max: 2 });
  return dbSingleton.db;
}

/** Receive a delivery. Always 200s quickly — their own docs ask receivers to do exactly that. */
export async function POST(req: Request) {
  const signature = req.headers.get("x-webhook-signature") ?? null;
  const raw = await req.text();

  let event = "unknown";
  let sessionId: number | null = null;
  try {
    const parsed = JSON.parse(raw) as { event?: string; sessionId?: number };
    event = parsed.event ?? "unknown";
    sessionId = typeof parsed.sessionId === "number" ? parsed.sessionId : null;
  } catch {
    /* record it anyway — an unparseable body is itself worth seeing */
  }

  await db()
    .insert(webhookDeliveries)
    .values({
      sessionId,
      event,
      signature,
      payload: raw.slice(0, 20_000),
    })
    .catch(() => {});

  return Response.json({ received: true });
}

/** Read back what arrived. Used by the integration suite and by a human debugging. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const since = url.searchParams.get("since");
  const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 20) || 20);
  const event = url.searchParams.get("event");

  const rows = await db()
    .select()
    .from(webhookDeliveries)
    .where(event ? eq(webhookDeliveries.event, event) : undefined)
    .orderBy(desc(webhookDeliveries.id))
    .limit(limit);

  const filtered = since ? rows.filter((r) => r.receivedAt > new Date(since)) : rows;
  return Response.json({ count: filtered.length, deliveries: filtered });
}
