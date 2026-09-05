import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Next 16 renamed middleware to `proxy`. This file must be `src/proxy.ts`.
 *
 * With it named `middleware.ts` the build still reported "Proxy (Middleware)", so it looked
 * wired — but Clerk could not detect it and every `auth()` call threw
 * "auth() was called but Clerk can't detect usage of clerkMiddleware()". Clerk's own error
 * text lists `proxy.(ts|js)` first, which is the tell.
 *
 * Everything except the landing page requires a signed-in user.
 *
 * Clerk guards humans only. Machine credentials — Personal Access Tokens and session API
 * keys — are minted here but verified locally in `apps/api` against hashed Postgres rows,
 * never through Clerk (PLAN.md §3).
 */
/**
 * `/api/webhook-sink` is public because it is a *receiver*: the webhook worker POSTs to it
 * with no browser session. It is not unauthenticated — the route verifies the delivery
 * signature against a known session secret and rejects anything else. Leaving it behind Clerk
 * produced a 307 redirect that the worker silently treated as a failed delivery.
 */
const isPublic = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhook-sink",
  /**
   * The CLI device flow. Unauthenticated by necessity — a terminal has no Clerk session, and
   * obtaining one is the point of the exchange. `start` only creates a pending request; `poll`
   * requires the high-entropy token the CLI kept, compared by hash. The *approval* step is the
   * `/cli` page, which is protected like everything else.
   */
  "/api/cli/(.*)",
  // Documentation is public; requiring sign-in to read a getting-started guide is absurd.
  "/docs",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublic(req)) await auth.protect();
});

/**
 * Static assets skip the middleware entirely.
 *
 * `webmanifest` was missing from this list, so `/site.webmanifest` fell through to
 * `auth.protect()` and 307'd to Clerk's sign-in page — the same failure already recorded above
 * for `/api/webhook-sink`, and just as quiet: the manifest is fetched by the browser rather
 * than by a person, so nothing surfaces except a PWA install prompt that never appears.
 *
 * The others are here because they are the assets most likely to be added next — fonts, a
 * robots.txt, a modern image format — and each would fail exactly the same silent way.
 * Everything listed lives in `public/`, which Next serves publicly by definition, so excluding
 * them widens nothing that was ever protected.
 */
export const config = {
  matcher: [
    "/((?!_next|[^?]*\.(?:ico|png|svg|jpg|webp|avif|css|js|txt|woff|woff2|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
