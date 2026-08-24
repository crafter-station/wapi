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
  // Documentation is public; requiring sign-in to read a getting-started guide is absurd.
  "/docs",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublic(req)) await auth.protect();
});

export const config = {
  matcher: ["/((?!_next|[^?]*\.(?:ico|png|svg|jpg|css|js)).*)", "/(api|trpc)(.*)"],
};
