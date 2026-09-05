/**
 * wapi public REST API — the WasenderAPI-compatible surface.
 *
 * Deliberately not Next.js: this process exists to emit byte-exact envelopes and headers
 * under load, and to accept raw binary uploads. See PLAN.md §2.
 */
import { Hono } from "hono";
import {
  buildOpenApiDocument,
  EXTENSION_ROUTES,
  fail,
  failFramework,
  ROUTES,
} from "@wapi/contracts";
import { createDb } from "@wapi/db";
import { auditRequests } from "./middleware/audit.ts";
import { rateLimitHeaders } from "./middleware/rate-limit.ts";
import { authenticate, requirePat } from "./middleware/auth.ts";
import { operatorRoutes } from "./routes/operator.ts";
import { sandboxRoutes } from "./routes/sandbox.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { connectionRoutes } from "./routes/connection.ts";
import { messageRoutes } from "./routes/messages.ts";
import { messageReadRoutes } from "./routes/message-reads.ts";
import { contactGroupRoutes } from "./routes/contacts-groups.ts";
import { mediaRoutes, mediaServeRoutes } from "./routes/media.ts";
import { notImplemented } from "./not-implemented.ts";

const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const { db } = createDb(DATABASE_URL);

const app = new Hono();
app.use("*", rateLimitHeaders);

/**
 * Audit before authentication, so a rejected request is recorded too.
 *
 * Hono runs `app.use` in registration order and this one wraps the rest of the chain, which is
 * what lets it read `auth` in its `finally` — set later by `authenticate` — and still see the
 * status of a 401 that never reached a handler. A sweep of failed credentials is exactly the
 * thing an audit trail exists to show.
 */
app.use("/api/*", auditRequests(db));

/** Internal liveness probe — outside /api so it cannot collide with a real route. */
app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "wapi-api",
    // The cloned surface and our own additions are counted separately: "46 routes" is a claim
    // about fidelity, and folding extensions into it would quietly make that claim false.
    routes: ROUTES.length,
    extensions: EXTENSION_ROUTES.length,
    commit: process.env["GIT_COMMIT"] ?? "dev",
    /**
     * Whether object storage is configured at all.
     *
     * `/api/upload` returns 503 without it, which is correct but indistinguishable from an outage
     * — so a caller cannot tell "this deployment has no storage" from "storage is down right
     * now". The fidelity suite reads this to skip the upload envelope rather than fail on a
     * deployment that was never going to serve one.
     */
    storage: Boolean(process.env["UPLOADX_URL"] && process.env["UPLOADX_TOKEN"]),
  }),
);

/**
 * Implemented routes, mounted before the 501 fallbacks so they win.
 *
 * Session CRUD is account-level and therefore Personal-Access-Token only — their proxy guide
 * is explicit that "updating a session's core configuration is an account-level action, you
 * must authenticate this request using your Personal Access Token, not the Session API Key".
 */
const IMPLEMENTED = new Set([
  "GET /api/whatsapp-sessions",
  "POST /api/whatsapp-sessions",
  "GET /api/whatsapp-sessions/{whatsappSession}",
  "PUT /api/whatsapp-sessions/{whatsappSession}",
  "DELETE /api/whatsapp-sessions/{whatsappSession}",
  "POST /api/whatsapp-sessions/{whatsappSession}/regenerate-key",
  "POST /api/whatsapp-sessions/{whatsappSession}/connect",
  "POST /api/whatsapp-sessions/{whatsappSession}/disconnect",
  "POST /api/whatsapp-sessions/{whatsappSession}/restart",
  "GET /api/whatsapp-sessions/{whatsappSession}/qrcode",
  "GET /api/status",
  "GET /api/user",
  "POST /api/send-message",
  "GET /api/whatsapp-sessions/{whatsappSession}/message-logs",
  "GET /api/messages/{msgId}/info",
  "POST /api/messages/read",
  "GET /api/contacts",
  "GET /api/contacts/{contactPhoneNumber}",
  "GET /api/whatsapp-sessions/{whatsappSession}/session-logs",
  "GET /api/fetch-username/{contact_identifier}",
  "POST /api/send-presence-update",
  "PUT /api/messages/{msgId}",
  "DELETE /api/messages/{msgId}",
  "POST /api/messages/{message}/resend",
  "POST /api/groups/{groupId}/leave",
  "PUT /api/groups/{groupId}/participants/update",
  "GET /api/groups/{groupJid}/invite-link",
  "GET /api/groups/{groupJid}/picture",
  "PUT /api/groups/{groupJid}/settings",
  "POST /api/groups/invite/accept",
  "GET /api/groups/invite/{inviteCode}",
  "PUT /api/contacts",
  "POST /api/contacts/{contactPhoneNumber}/block",
  "POST /api/contacts/{contactPhoneNumber}/unblock",
  "GET /api/contacts/{contactPhoneNumber}/picture",
  "GET /api/on-whatsapp/{contact_identifier}",
  "GET /api/lid-from-pn/{pn}",
  "GET /api/pn-from-lid/{lid}",
  "GET /api/groups",
  "POST /api/groups",
  "GET /api/groups/{groupJid}/metadata",
  "GET /api/groups/{groupJid}/participants",
  "POST /api/groups/{groupJid}/participants/add",
  "POST /api/groups/{groupJid}/participants/remove",
  "POST /api/upload",
  "POST /api/decrypt-media",
]);

/**
 * Machine-readable spec and the reference UI.
 *
 * Both are generated from the same `ROUTES` the handlers validate against, so the docs cannot
 * drift from the implementation — which is precisely the failure mode of the hand-edited docs
 * CMS the original uses (PLAN.md §1). Public and unauthenticated: a spec you need a key to
 * read is not documentation.
 */
const PUBLIC_URL = process.env["PUBLIC_URL"] ?? "https://api.wapi.crafter.run";

app.get("/openapi.json", (c) => c.json(buildOpenApiDocument(PUBLIC_URL)));

app.get("/docs", (c) =>
  c.html(`<!doctype html>
<html><head>
  <title>wapi — API reference</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head><body>
  <div id="app"></div>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  <script>
    Scalar.createApiReference('#app', {
      url: '/openapi.json',
      theme: 'default',
      darkMode: true,
      hideDownloadButton: false,
    })
  </script>
</body></html>`),
);

/**
 * Middleware first, routes second.
 *
 * Hono applies `app.use` only to routes registered *after* it, so mounting a router before
 * its middleware silently leaves handlers unauthenticated — `c.get("auth")` is undefined and
 * the request 500s. Registration order here is load-bearing, not stylistic.
 */

/**
 * Derived from the contract, not hand-maintained.
 *
 * This was nineteen `app.use` lines, and adding a route without adding its line left the handler
 * unauthenticated: `c.get("auth")` came back undefined and the first request 500'd. Nothing failed
 * until someone called it. That happened twice while cloning the last batch of endpoints, and the
 * comment above it — warning that registration order is load-bearing — was already there.
 *
 * Now every route in `ROUTES` and `EXTENSION_ROUTES` is mounted from its own declared `scope`, so
 * a new route cannot arrive unauthenticated: it has no scope, `contracts:generate` refuses to
 * emit it, and CI fails before anyone runs the server.
 *
 * `requirePat` is applied where the scope says `pat`. Session-scoped routes get `authenticate`
 * only, because each handler asserts its own kind with the *controller* envelope — moving that
 * into middleware would silently change ~15 routes from `error` to `message`, which is a wire
 * change and belongs in its own decision, not smuggled in with this one.
 */
const mounted = new Set<string>();
for (const route of [...ROUTES, ...EXTENSION_ROUTES]) {
  // `{param}` in the contract, `:param` in Hono.
  const path = route.path.replace(/\{(\w+)\}/g, ":$1");
  // Deduped: several paths carry two methods — `/api/contacts` is GET and PUT, `/api/messages/:id`
  // is PUT and DELETE — and mounting twice would authenticate twice, doubling a database lookup on
  // every request to them.
  const key = `${path} ${route.scope}`;
  if (mounted.has(key)) continue;
  mounted.add(key);

  if (route.scope === "pat") app.use(path, authenticate(db), requirePat);
  else app.use(path, authenticate(db));
}

// /media/* is deliberately unauthenticated: it is the public link `upload` hands out, and
// it only ever redirects to a short-lived signed URL.

app.route("/api", sessionRoutes(db));
app.route("/api", operatorRoutes(db));
app.route("/api", sandboxRoutes(db));
app.route("/api", connectionRoutes(db));
app.route("/api", messageRoutes(db));
app.route("/api", messageReadRoutes(db));
app.route("/api", contactGroupRoutes(db));
app.route("/api", mediaRoutes(db));
// Root-level, matching their `/media/<uuid>` public links.
app.route("/", mediaServeRoutes());

/**
 * The remaining Tier-1 routes, registered from the generated contract so the surface is
 * complete and measurable. Each answers with a marked 501 until its handler lands
 * (PLAN.md §8), which is honest in a way a stubbed 200 would not be.
 */
for (const route of ROUTES) {
  if (IMPLEMENTED.has(`${route.method} ${route.path}`)) continue;
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
console.log(
  `wapi-api listening on :${port} — ${ROUTES.length} routes (${IMPLEMENTED.size} live, ${ROUTES.length - IMPLEMENTED.size} pending)`,
);

export default { port, fetch: app.fetch };
