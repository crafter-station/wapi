import type { MiddlewareHandler } from "hono";
import { eq, and, isNull } from "drizzle-orm";
import { accounts, personalAccessTokens, whatsappSessions, type Db } from "@wapi/db";
import { hashToken } from "@wapi/core";
import { failFramework } from "@wapi/contracts";

/**
 * Two credential types, one verification path.
 *
 * PLAN.md §3 splits them by scope, matching WasenderAPI:
 *   - Personal Access Token — account-scoped. Session CRUD, proxy_url, regenerate-key.
 *   - Session API Key      — per-session, issued on connect, dies with the session.
 *
 * `GET /api/status` and `GET /api/user` take no session id *because the key is the selector*,
 * which only works if a session key resolves to exactly one session. That is enforced by the
 * unique index on `api_key_hash`.
 *
 * Both are hashed on the way in and looked up by hash, so authentication never decrypts and
 * a database dump yields no usable credential. Neither goes near Clerk — see §3 for why.
 */

export type AuthContext =
  | { kind: "pat"; accountId: number }
  | { kind: "session"; accountId: number; sessionId: number };

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
    db: Db;
  }
}

/** `Authorization: Bearer <token>`. Their docs also show "Bearer token <key>" in one place. */
function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(?:token\s+)?(.+)$/i.exec(header.trim());
  return m?.[1]?.trim() || null;
}

/**
 * Resolve a bearer token to an account, and to a session when it is a session key.
 *
 * Order matters only for cost, not correctness: the two hashes live in different tables with
 * unique indexes, so a token can never match both.
 */
export async function resolveToken(db: Db, token: string): Promise<AuthContext | null> {
  const hash = hashToken(token);

  const [session] = await db
    .select({ id: whatsappSessions.id, accountId: whatsappSessions.accountId })
    .from(whatsappSessions)
    .where(eq(whatsappSessions.apiKeyHash, hash))
    .limit(1);
  if (session) return { kind: "session", accountId: session.accountId, sessionId: session.id };

  const [pat] = await db
    .select({ accountId: personalAccessTokens.accountId })
    .from(personalAccessTokens)
    .where(and(eq(personalAccessTokens.tokenHash, hash), isNull(personalAccessTokens.revokedAt)))
    .limit(1);
  if (pat) {
    // Fire-and-forget: last_used_at is operational metadata, not worth blocking the request.
    void db
      .update(personalAccessTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(personalAccessTokens.tokenHash, hash))
      .catch(() => {});
    return { kind: "pat", accountId: pat.accountId };
  }

  return null;
}

/**
 * Authentication.
 *
 * The two failure strings are theirs verbatim — "API key is required" when the header is
 * absent, "Invalid API key" when it does not resolve. Both use the framework envelope with
 * `message`, because in Laravel these come from middleware rather than a controller
 * (PLAN.md §1.4).
 */
export const authenticate = (db: Db): MiddlewareHandler => async (c, next) => {
  const token = extractBearer(c.req.header("Authorization"));
  if (!token) return c.json(failFramework("API key is required"), 401);

  const auth = await resolveToken(db, token);
  if (!auth) return c.json(failFramework("Invalid API key"), 401);

  c.set("auth", auth);
  c.set("db", db);
  await next();
};

/**
 * Guard for account-level operations.
 *
 * Session CRUD, `proxy_url` and regenerate-key are account-level actions, and their docs are
 * explicit that these need the Personal Access Token rather than the session key — see the
 * proxy guide, which calls this out directly.
 */
export const requirePat: MiddlewareHandler = async (c, next) => {
  const auth = c.get("auth");
  if (auth.kind !== "pat") {
    return c.json(
      failFramework("This endpoint requires a Personal Access Token, not a session API key."),
      403,
    );
  }
  await next();
};

/** Guard for endpoints whose subject is the session the key belongs to. */
export const requireSessionKey: MiddlewareHandler = async (c, next) => {
  const auth = c.get("auth");
  if (auth.kind !== "session") {
    return c.json(failFramework("This endpoint requires a session API key."), 403);
  }
  await next();
};

/** Ensure an account row exists for a Clerk user. Used by the dashboard, not the public API. */
export async function ensureAccount(db: Db, clerkUserId: string): Promise<number> {
  const [existing] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.clerkUserId, clerkUserId))
    .limit(1);
  if (existing) return existing.id;
  const [created] = await db.insert(accounts).values({ clerkUserId }).returning({ id: accounts.id });
  return created!.id;
}
