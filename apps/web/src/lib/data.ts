import "server-only";
import { auth } from "@clerk/nextjs/server";
import { eq, and, desc, isNull } from "drizzle-orm";
import {
  createDb,
  accounts,
  whatsappSessions,
  personalAccessTokens,
  type WhatsappSession,
} from "@wapi/db";
import { generateApiKey, generatePat, generateWebhookSecret, hashToken, encryptSecret } from "@wapi/core";

/**
 * Dashboard data access.
 *
 * The dashboard reads Postgres directly rather than calling the public API. It is the same
 * application, and going through HTTP would mean minting a credential for ourselves just to
 * read our own rows. The public API stays the boundary for *clients*, not for this app.
 *
 * Every query is scoped by the Clerk user's account. There is no code path here that reads a
 * session without first resolving `accountId` from the signed-in user.
 */

let dbSingleton: ReturnType<typeof createDb> | null = null;
function db() {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set");
  dbSingleton ??= createDb(url, { max: 4 });
  return dbSingleton.db;
}

/** Resolve (and lazily create) the account row for the signed-in Clerk user. */
export async function currentAccountId(): Promise<number> {
  const { userId } = await auth();
  if (!userId) throw new Error("not signed in");

  const [existing] = await db()
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.clerkUserId, userId))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db()
    .insert(accounts)
    .values({ clerkUserId: userId })
    .onConflictDoUpdate({ target: accounts.clerkUserId, set: { plan: "pro" } })
    .returning({ id: accounts.id });
  return created!.id;
}

export async function listSessions(): Promise<WhatsappSession[]> {
  const accountId = await currentAccountId();
  return db()
    .select()
    .from(whatsappSessions)
    .where(eq(whatsappSessions.accountId, accountId))
    .orderBy(desc(whatsappSessions.createdAt));
}

export async function getSession(id: number): Promise<WhatsappSession | null> {
  const accountId = await currentAccountId();
  const [row] = await db()
    .select()
    .from(whatsappSessions)
    .where(and(eq(whatsappSessions.id, id), eq(whatsappSessions.accountId, accountId)))
    .limit(1);
  return row ?? null;
}

export async function createSession(input: {
  name: string;
  phoneNumber: string;
  accountProtection: boolean;
}): Promise<WhatsappSession> {
  const accountId = await currentAccountId();
  const apiKey = generateApiKey();
  const [row] = await db()
    .insert(whatsappSessions)
    .values({
      accountId,
      name: input.name,
      phoneNumber: input.phoneNumber,
      accountProtection: input.accountProtection,
      webhookSecret: generateWebhookSecret(),
      // Hashed for lookup, encrypted so the detail view can show it (PLAN.md §1).
      apiKeyHash: hashToken(apiKey),
      apiKeyEncrypted: encryptSecret(apiKey),
      status: "disconnected",
    })
    .returning();
  return row!;
}

export async function deleteSession(id: number): Promise<void> {
  const accountId = await currentAccountId();
  await db()
    .delete(whatsappSessions)
    .where(and(eq(whatsappSessions.id, id), eq(whatsappSessions.accountId, accountId)));
}

export async function listTokens() {
  const accountId = await currentAccountId();
  return db()
    .select({
      id: personalAccessTokens.id,
      name: personalAccessTokens.name,
      lastUsedAt: personalAccessTokens.lastUsedAt,
      createdAt: personalAccessTokens.createdAt,
    })
    .from(personalAccessTokens)
    .where(
      and(eq(personalAccessTokens.accountId, accountId), isNull(personalAccessTokens.revokedAt)),
    )
    .orderBy(desc(personalAccessTokens.createdAt));
}

/**
 * Mint a Personal Access Token.
 *
 * The plaintext is returned exactly once and never stored — only its hash is. That differs
 * deliberately from the session API key, which their API returns on every GET and so must be
 * recoverable. Nothing forces a PAT to be readable twice, so it isn't.
 */
export async function createToken(name: string): Promise<string> {
  const accountId = await currentAccountId();
  const token = generatePat();
  await db()
    .insert(personalAccessTokens)
    .values({ accountId, name, tokenHash: hashToken(token) });
  return token;
}

export async function revokeToken(id: number): Promise<void> {
  const accountId = await currentAccountId();
  await db()
    .update(personalAccessTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(personalAccessTokens.id, id), eq(personalAccessTokens.accountId, accountId)));
}
