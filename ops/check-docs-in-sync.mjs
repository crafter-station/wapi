/**
 * Does the documentation cover every API operation?
 *
 * The CLI guard asks this of `apps/cli/src/coverage.ts`; this asks it of the docs site. Each MDX
 * page declares the operations it documents in its frontmatter, and the page renders that same
 * list — so what a page claims and what this checks are one string rather than two that drift.
 *
 * Three directions, because a one-way check rots:
 *
 *   1. Every operation in `ROUTES + EXTENSION_ROUTES` is claimed by some page. A new endpoint
 *      makes CI red until somebody writes about it. This is the whole point: the reference
 *      already lists every endpoint automatically, so it is the *prose* that silently falls
 *      behind, and nothing else would notice.
 *   2. Every operation id a page claims still exists in the contract. A renamed operation
 *      therefore breaks the build instead of leaving a page advertising an endpoint that is gone
 *      and a dead deep-link into the reference.
 *   3. No operation is claimed by two pages. Not fatal, but it means two pages are each half
 *      documenting something, which is how a reader ends up with neither half.
 *
 * What it cannot check is whether the prose about an operation is *correct*, or even present —
 * only that a page has taken responsibility for it. That is the same limit the CLI guard has, and
 * the same answer applies: this is the cheap question, asked on every push.
 *
 * Run with bun, not node — it imports TypeScript sources.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXTENSION_ROUTES, ROUTES } from "../packages/contracts/src/index.ts";

const CONTENT = "apps/web/content/docs";

let failed = false;
const fail = (headline, lines = []) => {
  failed = true;
  console.error(`  FAIL  ${headline}`);
  for (const line of lines) console.error(`          ${line}`);
};

/** Every `.mdx` under the content directory, at any depth. */
const pages = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (entry.endsWith(".mdx")) pages.push(path);
  }
};
walk(CONTENT);

if (!pages.length) {
  fail(`No MDX pages found under ${CONTENT}. The content directory moved, or the build is empty.`);
  process.exit(1);
}

/**
 * The `operations:` list out of a page's frontmatter.
 *
 * Parsed rather than imported because this runs without Next, and a YAML dependency for one list
 * of strings would be more machinery than the job needs. The shape is fixed by
 * `source.config.ts`, so it is a list of `  - id` lines under `operations:` and nothing else; a
 * page written any other way fails the schema at build time, before it reaches this script.
 */
const operationsOf = (file) => {
  const text = readFileSync(file, "utf8");
  const frontmatter = text.split("---")[1] ?? "";
  const lines = frontmatter.split("\n");
  const start = lines.findIndex((l) => l.trim() === "operations:");
  if (start === -1) return [];

  const ids = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^\s+-\s+(\S+)\s*$/.exec(line);
    if (!match) break;
    ids.push(match[1]);
  }
  return ids;
};

const claimed = new Map();
for (const page of pages) {
  for (const id of operationsOf(page)) {
    if (!claimed.has(id)) claimed.set(id, []);
    claimed.get(id).push(page.replace(/\\/g, "/"));
  }
}

const all = [...ROUTES, ...EXTENSION_ROUTES];
const known = new Set(all.map((r) => r.operationId));

// 1. Every operation is documented somewhere.
const undocumented = all.filter((r) => !claimed.has(r.operationId));
if (undocumented.length) {
  fail(
    `${undocumented.length} operation(s) are documented by no page:`,
    undocumented.map((r) => `${r.method} ${r.path}  (${r.operationId})`),
  );
}

// 2. Every claimed id still exists.
const unknown = [...claimed].filter(([id]) => !known.has(id));
if (unknown.length) {
  fail(
    `${unknown.length} claimed operation(s) are not in the contract:`,
    unknown.map(([id, where]) => `${id} — claimed by ${where.join(", ")}`),
  );
}

// 3. Nothing is claimed twice.
const duplicated = [...claimed].filter(([, where]) => where.length > 1);
if (duplicated.length) {
  fail(
    `${duplicated.length} operation(s) are claimed by more than one page:`,
    duplicated.map(([id, where]) => `${id} — ${where.join(", ")}`),
  );
}

if (!failed) {
  console.log(`  ok    ${pages.length} pages document all ${all.length} operations`);
}

console.log(failed ? "\ndocs coverage check failed" : "\nok — the docs cover the API");
process.exit(failed ? 1 : 0);
