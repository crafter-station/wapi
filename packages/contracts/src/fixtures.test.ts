import { expect, test, describe } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTES } from "./generated/routes.ts";

/**
 * Golden fixtures — PLAN.md §9, verification layer 2.
 *
 * The mirrored spec carries 68 real response examples. They are the only ground truth we have
 * for the interface without a live WasenderAPI account, and until now nothing asserted
 * against them. These tests exist to catch the failure mode strict fidelity is most exposed
 * to: silent drift, where our shape stops matching theirs and nothing notices.
 *
 * The mirror is gitignored (their prose is copyrighted), so in CI these skip rather than fail.
 * A skipped suite is honest; a green tick on tests that never ran is not.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(HERE, "../../../docs/wasenderapi/structured/endpoints.json");
const AVAILABLE = existsSync(SPEC);

type Fixture = { title: string | null; json: string | null };
type Entry = {
  slug: string;
  method: string;
  path: string;
  parameters: { name: string; type: string; required: boolean }[];
  responses: Fixture[];
};

const spec: Entry[] = AVAILABLE ? JSON.parse(readFileSync(SPEC, "utf8")) : [];
const parsed = spec.flatMap((e) =>
  (e.responses ?? []).flatMap((r) => {
    if (!r.json) return [];
    try {
      return [{ entry: e, title: r.title ?? "", body: JSON.parse(r.json) as Record<string, unknown> }];
    } catch {
      // A few fixtures embed `// comments` in their JSON and are not parseable. Skipping them
      // is correct — they are documentation prose, not machine-checkable examples.
      return [];
    }
  }),
);

const d = AVAILABLE ? describe : describe.skip;

d("golden fixtures — envelope invariants", () => {
  test("the mirror is present and parses", () => {
    expect(spec.length).toBeGreaterThan(50);
    expect(parsed.length).toBeGreaterThan(40);
  });

  /**
   * The rule that cost the most to discover: controller failures use `error`, framework
   * failures use `message`, and no fixture mixes them. If a future fixture refresh breaks
   * this, our envelope split in `envelope.ts` is wrong and should be revisited.
   */
  test("no failure fixture carries both `error` and `message`", () => {
    const both = parsed.filter(
      (p) => p.body["success"] === false && "error" in p.body && "message" in p.body,
    );
    expect(both.map((b) => `${b.entry.slug}:${b.title}`)).toEqual([]);
  });

  test("every per-endpoint failure uses `error`, never `message`", () => {
    const failures = parsed.filter((p) => p.body["success"] === false);
    const withMessage = failures.filter((f) => "message" in f.body);
    expect(withMessage.map((f) => f.entry.slug)).toEqual([]);
    expect(failures.length).toBeGreaterThan(10);
  });

  test("successes are `success: true` plus exactly one payload carrier", () => {
    const CARRIERS = ["data", "api_key", "publicUrl", "message"];
    const odd: string[] = [];
    for (const p of parsed) {
      if (p.body["success"] !== true) continue;
      const found = CARRIERS.filter((k) => k in p.body);
      // Zero carriers is legitimate for the 204-style empty responses.
      if (found.length > 1) odd.push(`${p.entry.slug}: ${found.join("+")}`);
    }
    expect(odd).toEqual([]);
  });

  test("the paginator has twelve keys and omits Laravel's `links`", () => {
    const pages = parsed.filter(
      (p) => typeof p.body["data"] === "object" && p.body["data"] && "current_page" in (p.body["data"] as object),
    );
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) {
      const keys = Object.keys(p.body["data"] as object).sort();
      expect(keys).toEqual(
        [
          "current_page",
          "data",
          "first_page_url",
          "from",
          "last_page",
          "last_page_url",
          "next_page_url",
          "path",
          "per_page",
          "prev_page_url",
          "to",
          "total",
        ].sort(),
      );
    }
  });

  test("throttle fixtures omit `success` entirely", () => {
    const throttles = parsed.filter((p) => "retry_after" in p.body);
    for (const t of throttles) expect("success" in t.body).toBe(false);
  });
});

d("golden fixtures — the generated surface still matches the spec", () => {
  test("every Tier-1 route exists in the mirrored spec", () => {
    const specRoutes = new Set(spec.map((e) => `${e.method} ${e.path}`));
    const missing = ROUTES.filter((r) => !specRoutes.has(`${r.method} ${r.path}`));
    expect(missing.map((m) => `${m.method} ${m.path}`)).toEqual([]);
  });

  test("send-message is still documented as one path with many variants", () => {
    const variants = spec.filter((e) => e.path === "/api/send-message");
    expect(variants.length).toBeGreaterThan(10);
    expect(ROUTES.filter((r) => r.path === "/api/send-message").length).toBe(1);
  });

  /**
   * Guards the assumption behind the whole `msgId` design: their examples show an integer
   * id well above any per-session counter, alongside WhatsApp's own string key.
   */
  test("msgId fixtures are integers, not WhatsApp key strings", () => {
    const withMsgId = parsed
      .map((p) => (p.body["data"] as Record<string, unknown> | undefined)?.["msgId"])
      .filter((v) => v !== undefined);
    expect(withMsgId.length).toBeGreaterThan(0);
    for (const v of withMsgId) {
      expect(typeof v).toBe("number");
      expect(v as number).toBeGreaterThanOrEqual(100000);
    }
  });
});
