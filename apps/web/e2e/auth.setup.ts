import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, test as setup } from "@playwright/test";
import { STORAGE_STATE, TEST_EMAIL } from "./credentials";

/**
 * Sign in once, and let every dashboard spec reuse the session.
 *
 * Signing in per test would be slow and would hammer a real Clerk instance with identical
 * requests. This runs as a Playwright *dependency* project, so it happens once and hands its
 * cookies to the dashboard specs through `storageState`. A failure here also reads as a failure
 * to sign in, rather than every dashboard test breaking at once.
 *
 * **By sign-in ticket, not by password, and not through the form.** Three things rule the others
 * out, each found the hard way:
 *
 *   - This app has no `/sign-in` route, so `auth.protect()` redirects to Clerk's hosted Account
 *     Portal on another origin. Driving that form works until Clerk challenges the sign-in as
 *     coming from an unrecognised device, which every fresh browser is.
 *   - Password sign-in returns `needs_second_factor` on this instance, and `clerk.signIn` does
 *     not support multi-factor. It returns without signing in and without throwing, which looks
 *     exactly like a working setup until the first protected page redirects.
 *   - The ticket strategy mints a short-lived sign-in token through Clerk's backend API, so it
 *     bypasses factors by design. It needs `CLERK_SECRET_KEY`, which this suite already requires.
 *
 * A consequence worth having: the test account needs no password, so there is no second
 * credential to store anywhere.
 */
setup("sign in", async ({ page }) => {
  await clerkSetup();

  await page.goto("/");
  // Clerk loads asynchronously and signing in before it is ready silently does nothing.
  await page.waitForFunction(
    () => (window as unknown as { Clerk?: { loaded?: boolean } }).Clerk?.loaded === true,
    null,
    { timeout: 30_000 },
  );

  await clerk.signIn({ emailAddress: TEST_EMAIL, page });

  // `signIn` settles the session asynchronously and navigates on its own; navigating on top of
  // that aborts the request. Wait for the session to exist before going anywhere.
  await page.waitForFunction(
    () => Boolean((window as unknown as { Clerk?: { session?: unknown } }).Clerk?.session),
    null,
    { timeout: 30_000 },
  );

  /**
   * Let Clerk's own post-sign-in navigation finish first.
   *
   * `signIn` redirects by itself, and a `goto` issued on top of that is cancelled —
   * `net::ERR_ABORTED`, which reads like a server problem and is not one.
   */
  await page.waitForLoadState("networkidle");

  // Reaching a protected page is the only proof that matters. The heading is "Linked numbers." —
  // "Sessions" is the kicker above it, not the heading.
  /**
   * Retry the first navigation once.
   *
   * `signIn` performs its own redirect, and a `goto` landing on top of it is cancelled with
   * `net::ERR_ABORTED` — which reads like a server fault and is not one. The session is already
   * live at this point; only the navigation lost a race.
   */
  await page.goto("/sessions", { waitUntil: "domcontentloaded" }).catch(async () => {
    await page.waitForTimeout(1000);
    await page.goto("/sessions", { waitUntil: "domcontentloaded" });
  });

  await expect(page.getByRole("heading", { name: /linked/i }).first()).toBeVisible();

  await page.context().storageState({ path: STORAGE_STATE });
});
