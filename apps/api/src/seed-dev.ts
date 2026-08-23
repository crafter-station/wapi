/**
 * Local development seed: one account and one Personal Access Token.
 *
 * Not wired into the API. Clerk creates real accounts; this exists so the surface can be
 * exercised with curl before the dashboard lands.
 *
 * Run: bun run --cwd apps/api seed
 */
import { createDb, accounts, personalAccessTokens } from "@wapi/db";
import { generatePat, hashToken } from "@wapi/core";

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const { db, close } = createDb(url);
const clerkUserId = process.env["SEED_CLERK_USER"] ?? "user_local_dev";

const [account] = await db
  .insert(accounts)
  .values({ clerkUserId })
  .onConflictDoUpdate({ target: accounts.clerkUserId, set: { plan: "pro" } })
  .returning();

const pat = generatePat();
await db
  .insert(personalAccessTokens)
  .values({ accountId: account!.id, name: "local dev", tokenHash: hashToken(pat) });

console.log(`ACCOUNT_ID=${account!.id}`);
console.log(`PAT=${pat}`);
await close();
