/**
 * Seed the minimum an empty database needs to answer an authenticated request: one account and
 * one Personal Access Token, whose value is printed to stdout.
 *
 * This exists so the CI job is not a wall of inlined SQL. Everything the sandbox suite needs
 * beyond this — a session, a number, a pairing — it creates for itself through the public API,
 * which is the point: if the seed had to know about sessions, the sandbox would not be provable
 * from the outside.
 *
 * Prints only the token, so the caller can do `PAT=$(bun ops/seed-ci.ts)`.
 */
import { createDb, accounts, personalAccessTokens } from "@wapi/db";
import { generatePat, hashToken } from "@wapi/core";

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const { db, close } = createDb(url);

/**
 * A Clerk user id that no Clerk instance will ever issue. The column is NOT NULL and uniquely
 * indexed, so it needs *a* value; making it obviously synthetic means a real one appearing in a
 * CI database later would stand out rather than blend in.
 */
const [account] = await db
  .insert(accounts)
  .values({ clerkUserId: "user_ci_seed", sessionQuota: 100 })
  // Idempotent so a second run against the same database mints another token rather than
  // failing on the unique index — CI gets a fresh database, but a local rehearsal does not.
  .onConflictDoUpdate({ target: accounts.clerkUserId, set: { sessionQuota: 100 } })
  .returning();

const pat = generatePat();
await db.insert(personalAccessTokens).values({
  accountId: account!.id,
  name: "ci",
  tokenHash: hashToken(pat),
});

await close();
console.log(pat);
