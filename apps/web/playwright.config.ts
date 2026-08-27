import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests for the dashboard.
 *
 * Until this existed, no page in this app had ever been rendered in a browser by anything but a
 * person — typecheck proved the TypeScript was sound and `next build` proved the routes compile,
 * but neither can tell you a button does nothing or a page throws on paint.
 *
 * **Scope, stated honestly.** Only `/` and `/docs` are public (see `proxy.ts`); everything else
 * is behind `auth.protect()`. Covering the signed-in dashboard needs Clerk test credentials,
 * which CI does not have, so those pages remain unrendered here. That is a real gap, not a
 * decision — `apps/web/e2e/README.md` says what would close it.
 *
 * The Clerk publishable key below is a syntactically valid dummy: it is base64 of a domain and
 * only its shape is checked at build time. That is what lets this run with no secrets at all.
 */
const PORT = 3210;

export default defineConfig({
  testDir: "./e2e",
  /**
   * `.pw.ts`, not `.spec.ts`.
   *
   * Bun's test runner globs `*.spec.*` as well as `*.test.*`, so a Playwright spec sitting in the
   * workspace made `bun test` try to run it — and fail, since `@playwright/test` cannot run under
   * Bun. Two runners sharing one naming convention is a trap; this takes them apart.
   */
  testMatch: "**/*.pw.ts",
  // Fail the run rather than pass silently if somebody commits a focused test.
  forbidOnly: Boolean(process.env["CI"]),
  fullyParallel: true,
  reporter: process.env["CI"] ? "github" : "list",
  retries: process.env["CI"] ? 1 : 0,
  use: {
    /**
     * `localhost`, not `127.0.0.1`.
     *
     * Next 16 treats dev resources requested from another host as cross-origin and blocks them,
     * including the HMR socket — and with that blocked the page never hydrates. Every client
     * component was inert: tabs did not switch, the copy button did nothing. Nothing was wrong
     * with the app (production hydrates fine, checked), and a suite that only ever saw dead
     * buttons would have been quietly worthless.
     */
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    /**
     * The dev server, deliberately — and this is a real limitation, not a shortcut.
     *
     * `next.config.ts` sets `output: "standalone"`, so `next start` refuses to serve the build
     * and answers 400 to everything; the standalone server it points to instead is what the
     * Dockerfile runs, and on Windows its request worker dies with an unlogged socket hang up
     * while the identical build serves fine on the Linux host. Chasing a host-specific packaging
     * quirk would buy nothing these tests are for.
     *
     * So: **these tests do not exercise the production packaging.** That is covered by the Docker
     * build and by `next build` in CI. What they do cover is whether the components render and
     * work in a browser, which is what nothing covered before.
     */
    command: `bunx next dev --webpack --port ${PORT}`,
    env: {
      /**
       * Clerk credentials are NOT set here, deliberately.
       *
       * A real browser makes `clerkMiddleware` run a handshake, and completing it needs a valid
       * *secret* key even on a public route — a fabricated one returns 400 for every page. The
       * first version of this suite "passed" two tests against that JSON error page, which is
       * the failure mode worth naming: an error page trivially has no horizontal scroll.
       *
       * So the keys come from `apps/web/.env.local`, which Next loads itself and git ignores.
       * Populate it with `clerk env pull --file apps/web/.env.local` and add the
       * `NEXT_PUBLIC_`-prefixed publishable key — see `e2e/README.md`. Listing them here would
       * override that file, and hardcoding a secret would put one in the repository.
       */
      // `/docs` is prerendered and `/` never queries, so no database is reached. A real URL here
      // would be worse, not better: it would let a test quietly depend on somebody's data.
      DATABASE_URL: "postgres://placeholder/placeholder",
      PORT: String(PORT),
    },
    reuseExistingServer: !process.env["CI"],
    // A cold build plus start. Generous because the first CI run compiles from nothing.
    timeout: 180_000,
    url: `http://localhost:${PORT}/docs`,
  },
});
