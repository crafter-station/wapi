import { eq } from "drizzle-orm";
import { createDb, cliAuthRequests } from "@wapi/db";
import { decryptSecret, hashToken } from "@wapi/core";

/**
 * `POST /api/cli/poll` — collect the token once somebody has approved.
 *
 * **Unauthenticated by necessity and safe by construction**: the poll token *is* the credential,
 * it is high entropy, and it is compared by hash like every other credential here.
 *
 * Three outcomes, and they are deliberately distinguishable — a CLI that cannot tell "not yet"
 * from "expired" either gives up too early or waits forever:
 *
 *   - `pending`  — nobody has approved yet. Keep polling.
 *   - `expired`  — the ten minutes elapsed, or the row is gone. Start again.
 *   - the token  — approved. Returned exactly once; the row is deleted in the same breath, so a
 *     second poll with the same token reports `expired` rather than handing it out again.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const url = process.env["DATABASE_URL"];
  if (!url) return Response.json({ error: "Not configured." }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { poll_token?: string };
  if (typeof body.poll_token !== "string" || !body.poll_token) {
    return Response.json({ error: "poll_token is required." }, { status: 400 });
  }

  const { db, close } = createDb(url, { max: 2 });
  try {
    const [row] = await db
      .select()
      .from(cliAuthRequests)
      .where(eq(cliAuthRequests.pollTokenHash, hashToken(body.poll_token)))
      .limit(1);

    // A token that never existed and one that was already spent are the same answer on purpose:
    // neither should tell a guesser they are close.
    if (!row) return Response.json({ status: "expired" });
    if (row.expiresAt.getTime() < Date.now()) {
      await db.delete(cliAuthRequests).where(eq(cliAuthRequests.id, row.id));
      return Response.json({ status: "expired" });
    }
    if (!row.approvedAt || !row.tokenEncrypted) return Response.json({ status: "pending" });

    const token = decryptSecret(row.tokenEncrypted);
    /**
     * Delete before returning, not after. If the response is lost in flight the user simply logs
     * in again; if the row survived a successful collection, the same token could be handed to
     * whoever asked next.
     */
    await db.delete(cliAuthRequests).where(eq(cliAuthRequests.id, row.id));

    return Response.json({ status: "approved", token });
  } finally {
    await close();
  }
}
