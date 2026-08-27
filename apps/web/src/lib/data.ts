import "server-only";
import { auth } from "@clerk/nextjs/server";
import { and, count, desc, eq, gte, isNull } from "drizzle-orm";
import {
  accounts,
  auditLogs,
  createDb,
  doctorRuns,
  messages,
  personalAccessTokens,
  webhookDispatches,
  whatsappSessions,
  type AuditLog,
  type DoctorRun,
  type Message,
  type WebhookDispatch,
  type WhatsappSession,
} from "@wapi/db";
import {
  decryptSecret,
  encryptSecret,
  generateApiKey,
  generatePat,
  generateWebhookSecret,
  hashToken,
} from "@wapi/core";

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

/**
 * The webhook events a session can subscribe to.
 *
 * Derived from what the worker actually emits (`apps/webhook-worker/src/events.ts`) rather
 * than from the upstream documentation, because a checkbox for an event we never publish is a
 * setting that silently does nothing.
 *
 * An empty selection means *everything*, which is their semantic and is surfaced in the UI —
 * it reads as "no events" otherwise, which is the opposite of what it does.
 */
export const WEBHOOK_EVENTS = [
  "messages.upsert",
  "messages.received",
  "messages-personal.received",
  "messages.update",
  "messages.delete",
  "messages.reaction",
  "message-receipt.update",
  "message.sent",
  "session.status",
  "chats.upsert",
  "chats.update",
  "chats.delete",
  "contacts.upsert",
  "contacts.update",
  "groups.upsert",
  "groups.update",
  "group-participants.update",
  "call",
] as const;

export type SessionSettings = {
  webhookUrl: string | null;
  webhookEnabled: boolean;
  webhookHmac: boolean;
  webhookEvents: string[];
  proxyUrl: string | null;
  accountProtection: boolean;
  logMessages: boolean;
  readIncomingMessages: boolean;
  autoRejectCalls: boolean;
  alwaysOnline: boolean;
  ignoreGroups: boolean;
  ignoreChannels: boolean;
  ignoreBroadcasts: boolean;
};

/** Scoped by account like every other write here; an id from a form is never trusted. */
export async function updateSessionSettings(
  id: number,
  settings: SessionSettings,
): Promise<void> {
  const accountId = await currentAccountId();
  await db()
    .update(whatsappSessions)
    .set({ ...settings, updatedAt: new Date() })
    .where(and(eq(whatsappSessions.id, id), eq(whatsappSessions.accountId, accountId)));
}

/**
 * Issue a new API key, invalidating the old one immediately.
 *
 * Both columns move together: `apiKeyHash` is what authentication looks up, `apiKeyEncrypted`
 * is what the detail view can decrypt and show. Writing one without the other would leave the
 * session either unauthenticatable or displaying a key that no longer works.
 */
export async function regenerateSessionKey(id: number): Promise<string | null> {
  const accountId = await currentAccountId();
  const apiKey = generateApiKey();
  const [row] = await db()
    .update(whatsappSessions)
    .set({
      apiKeyEncrypted: encryptSecret(apiKey),
      apiKeyHash: hashToken(apiKey),
      updatedAt: new Date(),
    })
    .where(and(eq(whatsappSessions.id, id), eq(whatsappSessions.accountId, accountId)))
    .returning({ id: whatsappSessions.id });
  return row ? apiKey : null;
}

/** The decrypted session key, account-scoped. The only reason the dashboard can call our API. */
export async function sessionApiKey(id: number): Promise<string | null> {
  const session = await getSession(id);
  if (!session?.apiKeyEncrypted) return null;
  try {
    return decryptSecret(session.apiKeyEncrypted);
  } catch {
    return null;
  }
}

/**
 * The message log.
 *
 * Read straight from Postgres rather than through `GET /api/whatsapp-sessions/{id}/message-logs`,
 * which is PAT-authenticated by the upstream design. Using it here would mean the web app held
 * an account-level credential purely to read its own rows.
 */
export async function listMessages(
  sessionId: number,
  page: number,
  perPage = 50,
): Promise<{ rows: Message[]; total: number }> {
  if (!(await getSession(sessionId))) return { rows: [], total: 0 };
  const [tally] = await db()
    .select({ n: count() })
    .from(messages)
    .where(eq(messages.sessionId, sessionId));
  const rows = await db()
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(desc(messages.msgId))
    .limit(perPage)
    .offset((page - 1) * perPage);
  return { rows, total: tally?.n ?? 0 };
}

/** Outbound webhook attempts, newest first. Health lives here; payloads live on the row. */
export async function listDispatches(
  sessionId: number,
  page: number,
  perPage = 50,
): Promise<{ rows: WebhookDispatch[]; total: number }> {
  if (!(await getSession(sessionId))) return { rows: [], total: 0 };
  const [tally] = await db()
    .select({ n: count() })
    .from(webhookDispatches)
    .where(eq(webhookDispatches.sessionId, sessionId));
  const rows = await db()
    .select()
    .from(webhookDispatches)
    .where(eq(webhookDispatches.sessionId, sessionId))
    .orderBy(desc(webhookDispatches.lastAttemptAt))
    .limit(perPage)
    .offset((page - 1) * perPage);
  return { rows, total: tally?.n ?? 0 };
}

/** The last doctor verdict per session, for the health column on the sessions list. */
export async function latestDoctorRuns(): Promise<Map<number, DoctorRun>> {
  const accountId = await currentAccountId();
  const rows = await db()
    .select({ run: doctorRuns })
    .from(doctorRuns)
    .innerJoin(whatsappSessions, eq(whatsappSessions.id, doctorRuns.sessionId))
    .where(eq(whatsappSessions.accountId, accountId));
  return new Map(rows.map((r) => [r.run.sessionId, r.run]));
}

export async function getDoctorRun(sessionId: number): Promise<DoctorRun | null> {
  if (!(await getSession(sessionId))) return null;
  const [row] = await db().select().from(doctorRuns).where(eq(doctorRuns.sessionId, sessionId));
  return row ?? null;
}

/**
 * The audit trail, account-scoped.
 *
 * Top-level rather than under a session because it is not session-scoped data: calls made with a
 * Personal Access Token — creating a session, rotating a key — belong to the account and have no
 * session at all. Filing them under a session would hide exactly the actions most worth auditing.
 */
export async function listAuditLogs(
  page: number,
  perPage = 50,
  filter: { sessionId?: number; status?: "errors" } = {},
): Promise<{ rows: AuditLog[]; total: number }> {
  const accountId = await currentAccountId();
  const where = [eq(auditLogs.accountId, accountId)];
  if (filter.sessionId !== undefined) where.push(eq(auditLogs.sessionId, filter.sessionId));
  // 4xx and 5xx together: "what went wrong" rarely means one or the other.
  if (filter.status === "errors") where.push(gte(auditLogs.status, 400));

  const [tally] = await db()
    .select({ n: count() })
    .from(auditLogs)
    .where(and(...where));
  const rows = await db()
    .select()
    .from(auditLogs)
    .where(and(...where))
    .orderBy(desc(auditLogs.id))
    .limit(perPage)
    .offset((page - 1) * perPage);
  return { rows, total: tally?.n ?? 0 };
}

/** One audit entry, account-scoped so an id from the URL cannot reach another account's row. */
export async function getAuditLog(id: number): Promise<AuditLog | null> {
  const accountId = await currentAccountId();
  const [row] = await db()
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.id, id), eq(auditLogs.accountId, accountId)))
    .limit(1);
  return row ?? null;
}
