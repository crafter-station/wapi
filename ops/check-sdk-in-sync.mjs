#!/usr/bin/env node
/**
 * Fail if the SDK has drifted from the API.
 *
 * Two independent checks, because there are two ways to drift and only one of them is
 * mechanical:
 *
 * 1. **Generated types are stale.** Regenerating must be a no-op. If a route or response schema
 *    changed and nobody re-ran the generator, `src/types.gen.ts` no longer describes the API and
 *    every consumer is typed against a fiction.
 *
 * 2. **An operation has no method.** Types being current does not mean the hand-written surface
 *    covers them — a new endpoint would generate types nobody can call. This check parses the
 *    resource files for the paths they hit and compares that against the OpenAPI document.
 *
 * The second is the one worth having. The first would be caught eventually by a type error; the
 * second is silent, and "we shipped an endpoint but forgot the SDK" is exactly the failure this
 * repository keeps hitting with lists that must agree but live in different files.
 *
 * **Run with bun, not node**: `bun ops/check-sdk-in-sync.mjs`. The contracts package uses
 * NodeNext `./thing.js` specifiers that point at `.ts` sources — a deliberate choice so the Node
 * consumers work — and only bun resolves those without a build step.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SDK = "sdk/typescript";
const GENERATED = join(SDK, "src/types.gen.ts");

let failures = 0;
const fail = (message) => {
  console.error(`  FAIL  ${message}`);
  failures += 1;
};

// ---------------------------------------------------------------- 1. generated types are current
const before = readFileSync(GENERATED, "utf8");
execFileSync("bun", ["run", "--cwd", SDK, "generate"], { stdio: "pipe" });
const after = readFileSync(GENERATED, "utf8");

if (before !== after) {
  fail(
    `${GENERATED} is stale — regenerating changed it.\n` +
      "        Run: bun run --cwd sdk/typescript generate",
  );
} else {
  console.log("  ok    generated types match the OpenAPI document");
}

// ------------------------------------------------------------- 2. every operation has a method
/**
 * The paths the hand-written client actually calls.
 *
 * Read out of the source rather than by importing it, because importing would need a live
 * transport and every method to be invoked. A template literal like
 * `/api/groups/${encodeURIComponent(jid)}/metadata` is normalised back to the OpenAPI form by
 * replacing every interpolation with a single `{}` placeholder — the same normalisation applied
 * to the spec side, so the two are comparable without caring what the parameter is named.
 */
const normalise = (path) => path.replace(/\$\{[^}]*\}/g, "{}").replace(/\{[^}]*\}/g, "{}");

const resourceDir = join(SDK, "src/resources");
const sources = [
  ...readdirSync(resourceDir).map((f) => readFileSync(join(resourceDir, f), "utf8")),
  readFileSync(join(SDK, "src/index.ts"), "utf8"),
].join("\n");

const called = new Set();
// Matches the string or template literal in `request<T>("VERB", <path>` calls.
for (const m of sources.matchAll(/request<[^>]*>\(\s*"(\w+)",\s*[`"]([^`"]+)[`"]/g)) {
  called.add(`${m[1]} ${normalise(m[2])}`);
}

const { buildOpenApiDocument } = await import("../packages/contracts/src/openapi.ts");
const doc = buildOpenApiDocument("https://x");

const missing = [];
for (const [path, methods] of Object.entries(doc.paths)) {
  for (const method of Object.keys(methods)) {
    const key = `${method.toUpperCase()} ${normalise(path)}`;
    if (!called.has(key)) missing.push(`${key}  (${methods[method].operationId})`);
  }
}

if (missing.length) {
  fail(
    `the TypeScript SDK does not implement ${missing.length} operation(s):\n` +
      missing.map((m) => `          ${m}`).join("\n"),
  );
} else {
  console.log(`  ok    all ${Object.values(doc.paths).flatMap(Object.keys).length} operations have a method`);
}

if (failures) {
  console.error(`\nsdk drift check failed (${failures})`);
  process.exit(1);
}
console.log("\nok — the SDK is in sync with the API");
