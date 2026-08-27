import { expect, test } from "@playwright/test";

/**
 * The signed-in dashboard, rendered.
 *
 * Every page here was previously covered only by typecheck and `next build` — which prove the
 * TypeScript is sound and the routes compile, and say nothing about a component that throws when
 * it meets real data. These run against a real, empty database, so they also exercise the empty
 * states, which are the paths a new user sees first and the ones least likely to be opened by
 * hand.
 *
 * The suite builds its own fixture: it creates a **sandbox** session through the UI. That needs
 * no phone and no QR, which is the only reason walking the whole session workspace is possible
 * in an automated browser at all.
 */

/** Console noise that is the dev server's, not the app's — see `public.pw.ts` for the reasoning. */
function watchConsole(page: import("@playwright/test").Page) {
  const errors: string[] = [];
  const keep = (text: string) => {
    if (text.includes("_next/hmr") || text.includes("WebSocket")) return;
    errors.push(text);
  };
  page.on("console", (m) => m.type() === "error" && keep(m.text()));
  page.on("pageerror", (e) => keep(String(e)));
  return errors;
}

test.describe("account pages", () => {
  for (const [name, path, heading] of [
    ["sessions", "/sessions", /linked/i],
    ["tokens", "/tokens", /credentials/i],
    ["audit", "/audit", /every call/i],
  ] as const) {
    test(`${name} renders for a signed-in user`, async ({ page }) => {
      const errors = watchConsole(page);
      const response = await page.goto(path);

      expect(response?.status()).toBe(200);
      // Signed out, `auth.protect()` would have sent us to Clerk instead.
      expect(page.url()).not.toContain("accounts.dev");
      await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
      expect(errors).toEqual([]);
    });
  }
});

test.describe("a session workspace", () => {
  /**
   * One sandbox, created through the UI and reused by every tab below.
   *
   * `test.describe.serial` because these share it: creating one per tab would be slower and would
   * hit the per-account cap for no benefit.
   */
  test.describe.configure({ mode: "serial" });

  let sessionUrl = "";

  test("a sandbox can be created from the sessions page", async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto("/sessions");

    /**
     * This page carries two create forms and both name their input `name`; the sandbox one is
     * second. Picking the first would have submitted the *real session* form, which asks for a
     * phone number.
     */
    await page.locator('input[name="name"]').last().fill("E2E sandbox");
    await page.getByRole("button", { name: "Create sandbox" }).click();

    // The action redirects straight to the new session, so the URL is the reliable handle.
    await page.waitForURL(/\/sessions\/\d+$/);
    sessionUrl = new URL(page.url()).pathname;

    await expect(page.getByText("E2E sandbox").first()).toBeVisible();
    // Derived, and in the unassigned +999 range so it cannot route anywhere.
    await expect(page.getByText(/\+999/).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("the overview renders, and offers to connect", async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto(sessionUrl);

    await expect(page.getByRole("button", { name: /^connect$/i })).toBeVisible();
    // The badge is the thing that stops somebody believing a fake number is real.
    await expect(page.getByText(/sandbox/i).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  for (const tab of ["messages", "contacts", "groups", "webhooks", "doctor", "settings"] as const) {
    test(`the ${tab} tab renders`, async ({ page }) => {
      const errors = watchConsole(page);
      const response = await page.goto(`${sessionUrl}/${tab}`);

      expect(response?.status()).toBe(200);
      // Disconnected sessions show an empty state rather than throwing — that is the assertion.
      await expect(page.locator("main")).toBeVisible();
      expect(errors).toEqual([]);
    });
  }

  test("the sandbox tab explains itself before the session is connected", async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto(`${sessionUrl}/sandbox`);

    // The empty state a new user meets first, and the one least likely to be opened by hand.
    await expect(page.getByText(/not connected yet/i)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("the sandbox tab pairs, shows the directory and receives a message", async ({ page }) => {
    /**
     * Needs Redis, and the reason is worth stating: nothing writes `connected` to Postgres except
     * the webhook worker, reacting to the gateway's status event over `wapi:events`. The
     * dashboard's own Connect button talks to the gateway directly and persists nothing. So with
     * no Redis the gateway pairs the sandbox perfectly and the dashboard shows "disconnected"
     * forever — which is also true in production if Redis or the worker is down.
     */
    test.skip(!process.env["REDIS_URL"], "session status reaches Postgres only via Redis + the webhook worker");

    const errors = watchConsole(page);

    await page.goto(sessionUrl);
    await page.getByRole("button", { name: /^connect$/i }).click();

    /**
     * The fake pairs itself a few seconds later, so this waits rather than scanning anything.
     * That wait is the point: it is the same `need_scan → connected` transition a real session
     * makes, which is why the sandbox is a rehearsal and not a shortcut.
     *
     * Reloading rather than waiting in place, because the lifecycle buttons are server-rendered.
     * The status badge does update live over SSE, but that rides on Redis, which this suite does
     * not run — so the honest thing to assert is what a reloading user would see.
     */
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole("button", { name: /disconnect/i })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 45_000 });

    await page.goto(`${sessionUrl}/sandbox`);
    // The derived directory: five invented contacts, always the same.
    await expect(page.getByText("Ada").first()).toBeVisible({ timeout: 15_000 });

    await page.getByRole("textbox", { name: /message/i }).fill("hello from the browser");
    await page.getByRole("button", { name: /receive/i }).click();

    // The message appears in the thread, attributed to the contact who "sent" it.
    await expect(page.getByText("hello from the browser")).toBeVisible({ timeout: 15_000 });
    expect(errors).toEqual([]);
  });
});
