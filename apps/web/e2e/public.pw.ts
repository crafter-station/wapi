import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * What a signed-out visitor can reach: the landing page and the whole documentation tree.
 *
 * Deliberately assertions about behaviour rather than screenshots. A snapshot would fail on every
 * copy change and pass on a broken copy button, which is the wrong way round.
 *
 * The docs checks run over *every* page rather than a representative one. When the docs were a
 * single page that distinction did not exist; now that they are a tree, the failures worth
 * catching are per-page — one guide that overflows on a phone, one that throws during hydration —
 * and a spot check on the index would find none of them.
 */

/**
 * Every docs URL, read off the content directory.
 *
 * Derived rather than listed, so a page added without a test is impossible. The mapping mirrors
 * the loader's: `index.mdx` is the directory itself, anything else is its filename.
 */
function docsUrls(): string[] {
  // ES module scope: `__dirname` does not exist, and Playwright loads these as modules.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "content", "docs");
  const urls: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path, `${prefix}/${entry}`);
      else if (entry === "index.mdx") urls.push(prefix || "/docs");
      else if (entry.endsWith(".mdx")) urls.push(`${prefix}/${entry.replace(/\.mdx$/, "")}`);
    }
  };
  walk(root, "/docs");
  return urls;
}

const DOCS_URLS = docsUrls();

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

test.describe("the demo video", () => {
  test("shows a poster and only fetches the film when asked", async ({ page }) => {
    const videoRequests: string[] = [];
    page.on("request", (r) => {
      if (/\.(mp4|webm)(\?|$)/.test(r.url())) videoRequests.push(r.url());
    });

    await page.goto("/");
    const play = page.getByRole("button", { name: /play the demo/i });
    await expect(play).toBeVisible();

    /**
     * Nothing is fetched until somebody presses play, which is the whole reason this is a poster
     * and not an autoplaying loop: the landing page costs 40 KB for a reader who never watches,
     * rather than 1.2 MB. It also means the page has no motion until motion is asked for, which is
     * this site's only concession to prefers-reduced-motion.
     */
    expect(videoRequests).toEqual([]);

    await play.click();
    await expect(page.locator("video")).toBeVisible();
  });
});

test.describe("the docs site", () => {
  test("has pages to test at all", () => {
    // A glob that silently returns nothing would make every loop below vacuously pass.
    expect(DOCS_URLS.length).toBeGreaterThan(15);
    expect(DOCS_URLS).toContain("/docs");
  });

  for (const url of DOCS_URLS) {
    test(`${url} renders for a signed-out reader`, async ({ page }) => {
      const errors = collectConsoleErrors(page);
      const response = await page.goto(url);

      expect(response?.status()).toBe(200);
      /**
       * The docs are public in `proxy.ts`. The matcher there was `"/docs"` — an exact match — so
       * when the docs became a tree every page below the root redirected to Clerk while the index
       * kept working. Asserting per page is what makes that visible.
       */
      expect(page.url()).not.toContain("sign-in");
      await expect(page.locator("main")).toBeVisible();
      expect(errors).toEqual([]);
    });

    test(`${url} does not scroll sideways on a phone`, async ({ browser }) => {
      const page = await browser.newPage({ viewport: { height: 844, width: 390 } });
      await page.goto(url);

      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      // Wide code blocks and tables are supposed to scroll inside their own container, not drag
      // the page. The generated command table is four columns of paths, so it is the likeliest
      // offender and it is on one of these pages.
      expect(overflows).toBe(false);
      await page.close();
    });
  }

  test("survives a dark-mode reader, and so does its code", async ({ browser }) => {
    const page = await browser.newPage({ colorScheme: "dark" });
    const errors = collectConsoleErrors(page);
    await page.goto("/docs/quickstart");

    const background = await page
      .locator("body")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    // A transparent body means the page inherits whatever is behind it, which is how a dark-mode
    // page ends up with black text on a black ground.
    expect(background).not.toBe("rgba(0, 0, 0, 0)");

    /**
     * Code colour, specifically.
     *
     * Fumadocs emits dual-theme shiki output but ships no rule that consumes `--shiki-dark`,
     * because it expects a `.dark` class this site does not have — so without the swap in
     * `docs.css` every snippet renders in light colours on a dark ground. It is legible enough in
     * a screenshot to be missed and unreadable in practice, which is exactly what a test is for.
     */
    const token = page.locator("pre .shiki span, .shiki span").first();
    await expect(token).toBeVisible();
    const colour = await token.evaluate((el) => getComputedStyle(el).color);
    const dark = await token.evaluate((el) =>
      getComputedStyle(el).getPropertyValue("--shiki-dark").trim(),
    );
    // The variable has to exist, and the rendered colour has to be the dark one rather than the
    // light one sitting beside it.
    expect(dark).not.toBe("");
    expect(colour).not.toBe("rgb(36, 41, 46)");

    expect(errors).toEqual([]);
    await page.close();
  });

  test("every code block offers a copy button, and it copies", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/docs/quickstart");

    /**
     * The component behind this changed — these are Fumadocs' code blocks now, not the site's own
     * — so the test follows the behaviour rather than the implementation. It exists because that
     * button had never once been clicked before somebody wrote a test for it.
     */
    const copyButtons = page.getByRole("button", { name: /copy/i });
    expect(await copyButtons.count()).toBeGreaterThan(0);

    await copyButtons.first().click();
    await expect
      .poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).length)
      .toBeGreaterThan(0);
  });

  test("links follow the site's convention, not Fumadocs'", async ({ page }) => {
    await page.goto("/docs/guides/webhooks");

    /**
     * Fumadocs underlines every anchor on the page — its rule has no `.prose` ancestor, so it
     * catches the sidebar and the table of contents too, in a 1.5px primary-coloured underline at
     * font-weight 500. Nothing else on this site shouts like that, and no other check can see it:
     * it typechecks, builds, and passes every guard while looking wrong.
     */
    const sidebarLink = page.locator("#nd-sidebar a").first();
    await expect(sidebarLink).toBeVisible();
    expect(
      await sidebarLink.evaluate((el) => getComputedStyle(el).textDecorationLine),
    ).toBe("none");

    // The table of contents is navigation too.
    const tocLink = page.locator("#nd-toc a").first();
    if (await tocLink.count()) {
      expect(await tocLink.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("none");
    }

    /**
     * Body prose keeps an underline — that is this site's convention — but a hairline one.
     *
     * Compared as strings rather than parsed: an element the rule does not reach computes
     * `auto`, and `parseFloat("auto")` is NaN, which silently satisfies neither `<=` nor `>`.
     * `1.5px` is Fumadocs' weight and the only value this needs to exclude.
     */
    const bodyLink = page.locator(".prose p a").first();
    await expect(bodyLink).toBeVisible();
    const body = await bodyLink.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        decoration: s.textDecorationLine,
        thickness: s.textDecorationThickness,
        weight: s.fontWeight,
      };
    });
    expect(body.decoration).toBe("underline");
    expect(body.thickness).not.toBe("1.5px");
    // Fumadocs sets 500; the surrounding prose is 400, and a link should not be bolder than it.
    expect(body.weight).not.toBe("500");
  });

  test("search finds a page by its prose", async ({ page }) => {
    // The index is built from the same page tree the sidebar renders. If they disagree, a page is
    // reachable and unfindable, or findable and gone.
    const res = await page.request.get("/api/search?query=webhook");
    expect(res.status()).toBe(200);
    const results = (await res.json()) as { url: string }[];
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.url.includes("/docs/guides/webhooks"))).toBe(true);
  });

  test("llms.txt lists the tree", async ({ page }) => {
    const res = await page.request.get("/llms.txt");
    expect(res.status()).toBe(200);
    const text = await res.text();
    // Generated from the page tree, so it should name pages rather than being a stub.
    expect(text).toContain("/docs/guides/sending-messages");
    expect(text).toContain("/docs/sandbox");
  });
});
