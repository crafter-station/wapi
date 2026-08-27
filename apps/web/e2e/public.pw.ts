import { expect, test } from "@playwright/test";

/**
 * The two pages a signed-out visitor can reach.
 *
 * Deliberately assertions about behaviour rather than screenshots. A snapshot of this docs page
 * would fail on every copy change and pass on a broken copy button, which is the wrong way round.
 */

/**
 * Nothing in this app should be writing to the console in normal operation, so anything that
 * appears is either a React warning worth fixing or an exception that did not reach the page.
 * Hydration mismatches in particular are invisible in a screenshot and fatal to interactivity.
 */
function collectConsoleErrors(page: import("@playwright/test").Page) {
  const errors: string[] = [];
  const record = (text: string) => {
    /**
     * The dev server's own noise, not the app's.
     *
     * These tests run against `next dev`, which opens an HMR WebSocket that Playwright's browser
     * cannot complete. Filtering by substring rather than dropping console checks entirely: the
     * point of watching the console is hydration mismatches, which are invisible in a screenshot
     * and fatal to interactivity, and a blanket ignore would throw those away too.
     */
    if (text.includes("_next/hmr") || text.includes("WebSocket")) return;
    errors.push(text);
  };
  page.on("console", (m) => {
    if (m.type() === "error") record(m.text());
  });
  page.on("pageerror", (e) => record(String(e)));
  return errors;
}

test.describe("the landing page", () => {
  test("renders, and does not redirect a signed-out visitor away", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const response = await page.goto("/");

    expect(response?.status()).toBe(200);
    // `/` is public in proxy.ts. A regression there sends visitors to Clerk, which is the kind of
    // thing that is obvious in production and invisible everywhere else.
    expect(page.url()).not.toContain("sign-in");
    await expect(page.locator("body")).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("the docs page", () => {
  test("renders its endpoint reference", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto("/docs");

    await expect(page).toHaveTitle(/wapi/i);
    // The page exists to document endpoints; if none rendered, it built but is useless.
    await expect(page.getByText("/api/send-message").first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("every code block offers a copy button, and it copies", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/docs");

    const copyButtons = page.getByRole("button", { name: /copy/i });
    // Built in this repo and never once clicked before this test existed.
    expect(await copyButtons.count()).toBeGreaterThan(0);

    await copyButtons.first().click();
    /**
     * Wait for the button to say so before reading the clipboard.
     *
     * `writeText` is awaited inside the click handler, so reading immediately after the click
     * races it and returns an empty string. Waiting on the label is also the better assertion:
     * it is the confirmation a person actually looks for, and the component has a `failed` state
     * that this would catch.
     */
    await expect(copyButtons.first()).toHaveText("copied");
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard.length).toBeGreaterThan(0);
  });

  test("survives a dark-mode viewer", async ({ browser }) => {
    // The theme is driven by prefers-color-scheme, so it has a whole second set of colours that
    // nothing else exercises.
    const page = await browser.newPage({ colorScheme: "dark" });
    const errors = collectConsoleErrors(page);
    await page.goto("/docs");

    await expect(page.locator("body")).toBeVisible();
    const background = await page
      .locator("body")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    // A transparent body means the page inherits whatever is behind it, which is how a dark-mode
    // page ends up with black text on a black ground.
    expect(background).not.toBe("rgba(0, 0, 0, 0)");
    expect(errors).toEqual([]);
    await page.close();
  });

  test("does not scroll sideways on a phone", async ({ browser }) => {
    const page = await browser.newPage({ viewport: { height: 844, width: 390 } });
    await page.goto("/docs");

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    // Wide code blocks are supposed to scroll inside their own container, not drag the page.
    expect(overflows).toBe(false);
    await page.close();
  });
});
