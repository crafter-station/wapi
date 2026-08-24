#!/usr/bin/env node
/**
 * Fail if a workspace manifest is missing from the Dockerfile's deps stage.
 *
 * `bun install --frozen-lockfile` validates the lockfile against the WHOLE workspace, so any
 * image whose deps stage lacks a package.json reads as drift and refuses to install. That
 * exact failure shipped four times: when packages/db and packages/baileys-auth arrived, again
 * for packages/core, again for apps/web (where the *gateway* image failed over a manifest it
 * does not use), and again for compat.
 *
 * The first version of this check hard-coded `packages/*` and `apps/*`, so `compat` at the
 * repo root was invisible to it and the deploy broke anyway. The workspace list is now derived
 * from package.json, which is the only source that cannot drift from reality.
 *
 * Run: node ops/check-dockerfile-manifests.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");

/** Minimal glob support: the only patterns used are `dir/*` and a bare directory name. */
function expand(pattern) {
  if (!pattern.includes("*")) return [pattern];
  const [base] = pattern.split("/*");
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .map((name) => join(base, name).replaceAll("\\", "/"))
    .filter((p) => statSync(p).isDirectory());
}

const workspaces = (pkg.workspaces ?? []).flatMap(expand);
const missing = [];

for (const dir of workspaces) {
  const manifest = `${dir}/package.json`;
  if (!existsSync(manifest)) continue;
  if (!dockerfile.includes(`COPY ${manifest}`)) missing.push(manifest);
}

if (missing.length) {
  for (const m of missing) {
    console.error(`::error::${m} is a workspace but is not copied into the Dockerfile deps stage`);
  }
  console.error(
    `\n${missing.length} manifest(s) missing. Add a COPY line to the deps stage, or the ` +
      `frozen install will fail at deploy time rather than here.`,
  );
  process.exit(1);
}

console.log(`ok — all ${workspaces.length} workspace manifests are in the deps stage`);
