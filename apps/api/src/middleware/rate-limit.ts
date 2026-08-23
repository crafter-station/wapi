import type { MiddlewareHandler } from "hono";

/**
 * Emits the three `X-RateLimit-*` headers on every response.
 *
 * Per PLAN.md §1, the *shape* is real and the *numbers* are nominal: there is no one to
 * abuse this instance, so enforcement would be cost without benefit. Their SDKs care that
 * the headers exist and that a 429 carries `retry_after`; they do not care whether the
 * limit reads 256 or 10000.
 *
 * The one limiter that IS enforced for real is `account_protection`'s 1-per-5s send pacing,
 * which lives in the gateway — it protects the phone number, not the server.
 */
const LIMIT = 10_000;
const WINDOW_SECONDS = 60;

export const rateLimitHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("X-RateLimit-Limit", String(LIMIT));
  c.header("X-RateLimit-Remaining", String(LIMIT - 1));
  c.header("X-RateLimit-Reset", String(Math.floor(Date.now() / 1000) + WINDOW_SECONDS));
};
