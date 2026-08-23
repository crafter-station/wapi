/**
 * wapi public REST API — the WasenderAPI-compatible surface.
 *
 * Deliberately not Next.js: this process exists to emit byte-exact envelopes and headers
 * under load, and to accept raw binary uploads. See PLAN.md §2.
 */
import { Hono } from "hono";
import { ROUTES, fail, failFramework } from "@wapi/contracts";
import { rateLimitHeaders } from "./middleware/rate-limit.ts";
import { notImplemented } from "./not-implemented.ts";

const app = new Hono();

app.use("*", rateLimitHeaders);

/**
 * Internal liveness probe. Not part of the WasenderAPI surface, so it lives outside /api
 * where it cannot collide with a real route.
 */
app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "wapi-api",
    routes: ROUTES.length,
    commit: process.env["GIT_COMMIT"] ?? "dev",
  }),
);

/**
 * Register the 29 Tier-1 routes from the generated contract.
 *
 * Every route exists from day one so the surface is complete and testable; handlers are
 * filled in per PLAN.md §8 and each unimplemented one answers with a clearly-marked 501
 * rather than a plausible-looking lie.
 */
for (const route of ROUTES) {
  // Contract paths use `{param}`; Hono uses `:param`.
  const path = route.path.replace(/\{(\w+)\}/g, ":$1");
  const method = route.method.toLowerCase() as "get" | "post" | "put" | "delete";
  app[method](path, notImplemented(route));
}

/** Unknown route. Laravel's router raises a framework-level 404, so it uses `message`. */
app.notFound((c) => c.json(failFramework("The requested endpoint does not exist."), 404));

app.onError((err, c) => {
  console.error({ err: err.message, path: c.req.path }, "unhandled error");
  return c.json(fail("An unexpected error occurred."), 500);
});

const port = Number(process.env["PORT"] ?? 3001);
console.log(`wapi-api listening on :${port} — ${ROUTES.length} routes registered`);

export default { port, fetch: app.fetch };
