import type { Logger } from "pino";
import { eq, inArray } from "drizzle-orm";
import { whatsappSessions, baileysCreds, type Db } from "@wapi/db";
import type { WhatsAppEngine } from "@wapi/core";

/**
 * Reconnect sessions on boot.
 *
 * A WhatsApp session is a WebSocket owned by one process, so there is no rolling deploy for
 * the gateway — every redeploy drops every socket (PLAN.md §7). Without this, a deploy leaves
 * every session dark until someone calls `/connect` by hand, which happened twice during
 * testing before this existed.
 *
 * The auth state is already in Postgres, so this costs no re-pair — it is purely reopening
 * sockets against credentials we still hold.
 */

/** Sessions that were live before the restart, or were mid-connect when it happened. */
const RESUMABLE = ["connected", "connecting"];

/**
 * Reconnects are staggered.
 *
 * §10 asked what happens when the box reboots and many sessions reconnect at once. Opening
 * every socket simultaneously is both a memory spike and a burst of near-identical traffic
 * from one IP — and burst smoothing over average-rate limiting is one of the few mitigations
 * the research found actual evidence for (PLAN.md §5). So: bounded concurrency, with a gap
 * between each.
 */
const CONCURRENCY = 3;
const GAP_MS = 1500;

export async function resumeSessions(
  db: Db,
  engine: WhatsAppEngine,
  logger: Logger,
): Promise<void> {
  const rows = await db
    .select({
      id: whatsappSessions.id,
      status: whatsappSessions.status,
      accountProtection: whatsappSessions.accountProtection,
    })
    .from(whatsappSessions)
    .where(inArray(whatsappSessions.status, RESUMABLE));

  if (!rows.length) {
    logger.info("no sessions to resume");
    return;
  }

  /**
   * Only resume sessions we can actually authenticate.
   *
   * A row can say `connected` while its credentials were cleared by a logout, and readiness
   * is `creds.me`, never `creds.registered` — that flag belongs to the pairing-code flow and
   * stays false forever after a QR pair (PLAN.md §4). Here we check for the `me` row directly
   * rather than opening a socket to find out.
   */
  const ids = rows.map((r) => String(r.id));
  const credRows = await db
    .select({ sessionId: baileysCreds.sessionId })
    .from(baileysCreds)
    .where(inArray(baileysCreds.sessionId, ids));
  const paired = new Set(
    credRows.filter((c) => c.sessionId).map((c) => c.sessionId),
  );

  const resumable = rows.filter((r) => paired.has(String(r.id)));
  const skipped = rows.length - resumable.length;

  logger.info(
    { total: rows.length, resumable: resumable.length, skipped },
    "resuming sessions after restart",
  );

  // Anything marked live but lacking credentials is stale state, not a session. Say so in
  // the database rather than leaving a row that claims to be connected forever.
  if (skipped) {
    const staleIds = rows.filter((r) => !paired.has(String(r.id))).map((r) => r.id);
    for (const id of staleIds) {
      await db
        .update(whatsappSessions)
        .set({ status: "disconnected", updatedAt: new Date() })
        .where(eq(whatsappSessions.id, id))
        .catch(() => {});
    }
  }

  let index = 0;
  const worker = async () => {
    while (index < resumable.length) {
      const row = resumable[index++]!;
      try {
        await engine.connect(row.id);
        logger.info({ sessionId: row.id }, "resumed");
      } catch (err) {
        // One bad session must not stop the rest from coming back.
        logger.error({ sessionId: row.id, err: String(err) }, "resume failed");
      }
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, resumable.length) }, worker));
  logger.info("resume complete");
}
