import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Everything except the landing page requires a signed-in user.
 *
 * Clerk guards humans only. Machine credentials — Personal Access Tokens and session API
 * keys — are minted here but verified locally in `apps/api` against hashed Postgres rows,
 * never through Clerk (PLAN.md §3).
 */
const isPublic = createRouteMatcher(["/", "/sign-in(.*)", "/sign-up(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublic(req)) await auth.protect();
});

export const config = {
  matcher: ["/((?!_next|[^?]*\.(?:ico|png|svg|jpg|css|js)).*)", "/(api|trpc)(.*)"],
};
