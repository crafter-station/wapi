/**
 * Does the web image's build stage copy everything the web build imports?
 *
 * This exists because CI never builds the Docker image, so a whole class of failure reaches the
 * deploy untested. Adding `@wapi/cli/coverage` to a docs component typechecked, built, passed
 * every guard and passed CI — then failed in Dokploy with `Can't resolve '@wapi/cli/coverage'`,
 * because `web-builder` copies `packages` and `apps/web` and nothing else. The dependency was
 * real and the image simply did not contain it.
 *
 * The check is deliberately narrow: it compares the `@wapi/*` packages imported anywhere under
 * `apps/web/src` against the paths the `web-builder` stage copies. It cannot tell you the image
 * builds — only that this specific, silent, deploy-time-only failure is not present.
 *
 * Run with bun or node; it reads files and parses nothing exotic.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let failed = false;
const fail = (headline, lines = []) => {
  failed = true;
  console.error(`  FAIL  ${headline}`);
  for (const line of lines) console.error(`          ${line}`);
};

/** Every `@wapi/x` package imported under a directory. */
const importsUnder = (dir) => {
  const found = new Set();
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const path = join(d, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (/\.tsx?$/.test(entry)) {
        const text = readFileSync(path, "utf8");
        for (const m of text.matchAll(/from "(@wapi\/[^"/]+)/g)) found.add(m[1]);
      }
    }
  };
  walk(dir);
  return found;
};

/** Where each `@wapi/*` workspace lives, by reading the manifests the root declares. */
const workspaceDirs = () => {
  const root = JSON.parse(readFileSync("package.json", "utf8"));
  const dirs = new Map();
  for (const pattern of root.workspaces ?? []) {
    const base = pattern.replace(/\/\*$/, "");
    const candidates = pattern.endsWith("/*")
      ? readdirSync(base).map((n) => join(base, n))
      : [pattern];
    for (const dir of candidates) {
      const manifest = join(dir, "package.json");
      if (!existsSync(manifest)) continue;
      const name = JSON.parse(readFileSync(manifest, "utf8")).name;
      if (typeof name === "string") dirs.set(name, dir.replaceAll("\\", "/"));
    }
  }
  return dirs;
};

/** The paths a named Dockerfile stage copies in from the build context. */
const copiedBy = (stage) => {
  const dockerfile = readFileSync("Dockerfile", "utf8");
  const after = dockerfile.split(`AS ${stage}`)[1];
  if (after === undefined) {
    fail(`Dockerfile has no stage named ${stage} — this guard is looking at the wrong thing.`);
    return [];
  }
  const body = after.split("\nFROM ")[0];
  return [...body.matchAll(/^COPY (?:--from=\S+ )?(\S+)/gm)]
    .map((m) => m[1])
    .filter((p) => !p.startsWith("/app"));
};

const dirs = workspaceDirs();
const copied = copiedBy("web-builder");
const missing = [];

for (const name of [...importsUnder("apps/web/src")].sort()) {
  const dir = dirs.get(name);
  if (!dir) {
    missing.push(`${name} — imported but no workspace declares that name`);
    continue;
  }
  const present = copied.some((c) => dir === c || dir.startsWith(`${c.replace(/\/$/, "")}/`));
  if (!present) missing.push(`${name} (${dir}) — imported by apps/web but not copied`);
}

if (missing.length) {
  fail(`${missing.length} workspace import(s) the web image would not contain:`, [
    ...missing,
    "",
    "web-builder copies: " + copied.join(" "),
    "Add the missing directory to the web-builder stage in Dockerfile.",
  ]);
} else {
  console.log(`  ok    every workspace apps/web imports is copied into web-builder`);
}

console.log(failed ? "\ndocker copy check failed" : "\nok — the web image contains what it imports");
process.exit(failed ? 1 : 0);
