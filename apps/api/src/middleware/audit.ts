import type { MiddlewareHandler } from "hono";
import { auditLogs, type Db } from "@wapi/db";
import { clientIp, redactHeaders, redactPayload } from "@wapi/core";
import { ROUTES, EXTENSION_ROUTES } from "@wapi/contracts";

/**
 * Audit trail for every API request.
 *
 * Records who called what, with which credential, what we answered and how long it took —
 * after redaction. `packages/core/src/redact.ts` is the part that matters: `Authorization`
 * carries a full WhatsApp credential and the session routes return `api_key` in plaintext, so
 * an unredacted trail would be a table of live keys.
 *
 * Three properties this has to have, in order of how badly getting them wrong would hurt:
 *
 * 1. **It cannot leak.** Redaction is pure and unit-tested; nothing here reconstructs a body
 *    from the original after redacting it.
 * 2. **It cannot fail a request.** The write is fire-and-forget and its errors are swallowed to
 *    the log. A send that succeeded must not report failure because an audit insert deadlocked.
 * 3. **It cannot slow the hot path.** The insert is not awaited before the response is returned.
 *
 * The cost of (2) is stated plainly: audit rows are best-effort. If Postgres is down the request
 * still succeeds and no row is written, and an in-flight write is lost if the process is
 * replaced mid-request. That is the right trade for a messaging API — no send should fail
 * because bookkeeping did — but it means this is an operational record, not a
 * compliance-grade ledger.
 *
 * **Bodies carry message content.** A `send-message` request holds the message text and the
 * recipient's number; a contacts response holds part of an address book. Redaction removes
 * credentials, not information, so `AUDIT_BODIES=off` drops request and response bodies
 * entirely and keeps the metadata trail. Retention nulls bodies after 7 days regardless.
 */

/** Bodies are recorded unless explicitly turned off. */
const RECORD_BODIES = process.env["AUDIT_BODIES"] !== "off";

/** Concrete path → the route pattern, so rows group by endpoint rather than by group id. */
const PATTERNS: { regex: RegExp; route: string }[] = [...ROUTES, ...EXTENSION_ROUTES].map((r) => ({
  // `{param}` matches one path segment. Escaping first keeps a literal dot from matching anything.
  regex: new RegExp(
    `^${r.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{\w+\\\}/g, "[^/]+")}$`,
  ),
  route: r.path,
}));

const patternFor = (path: string): string | null =>
  PATTERNS.find((p) => p.regex.test(path))?.route ?? null;

/**
 * Bodies are read from clones.
 *
 * `c.req.text()` consumes the stream, so reading the request here without cloning would leave
 * the handler with nothing — the same trap the webhook docs warn about. Hono caches the parsed
 * body, but relying on that would make this middleware depend on an implementation detail of
 * something it wraps.
 */
async function safeText(res: Response, limit: number): Promise<string | null> {
  const length = Number(res.headers.get("content-length") ?? 0);
  // Never buffer a large response just to describe it; the size alone is the useful fact.
  if (length > limit * 8) return `[not recorded] (${length} bytes)`;
  try {
    return await res.clone().text();
  } catch {
    return null;
  }
}

export function auditRequests(db: Db): MiddlewareHandler {
  return async (c, next) => {
    const started = Date.now();

    // Read the request body before the handler consumes it.
    let requestRaw: string | null = null;
    const declared = Number(c.req.header("content-length") ?? 0);
    if (!RECORD_BODIES) {
      requestRaw = null;
    } else if (declared > 0 && declared < 1_000_000) {
      requestRaw = await c.req.raw.clone().text().catch(() => null);
    } else if (declared >= 1_000_000) {
      requestRaw = null; // a 16 MB upload; the header record carries its size
    }

    let thrown: unknown = null;
    try {
      await next();
    } catch (err) {
      thrown = err;
      throw err;
    } finally {
      const durationMs = Date.now() - started;
      const res = c.res;
      /**
       * `auth` is set by the authenticate middleware, which runs *after* this one for the
       * routes it guards — so it is read here, in `finally`, once the chain has run. On a 401
       * it is absent, which is itself the useful record.
       */
      const auth = c.get("auth") as
        | { kind: "pat" | "session"; accountId: number; sessionId?: number }
        | undefined;

      const row = {
        accountId: auth?.accountId ?? null,
        country: c.req.header("cf-ipcountry") ?? null,
        createdAt: new Date(),
        credentialKind: auth?.kind ?? null,
        durationMs,
        error: thrown instanceof Error ? thrown.message.slice(0, 500) : null,
        ip: clientIp(c.req.raw.headers),
        method: c.req.method,
        path: c.req.path,
        requestBody: RECORD_BODIES
          ? redactPayload(requestRaw, c.req.header("content-type") ?? null)
          : null,
        requestHeaders: redactHeaders(c.req.raw.headers),
        responseBody:
          RECORD_BODIES && res
            ? redactPayload(await safeText(res, 4096), res.headers.get("content-type"))
            : null,
        route: patternFor(c.req.path),
        sessionId: auth?.sessionId ?? null,
        status: thrown ? 500 : (res?.status ?? 0),
        userAgent: c.req.header("user-agent")?.slice(0, 300) ?? null,
      };

      // Deliberately not awaited: see (2) and (3) above.
      void db
        .insert(auditLogs)
        .values(row)
        .catch((err: unknown) => {
          console.error({ err: String(err), path: row.path }, "audit insert failed");
        });
    }
  };
}
