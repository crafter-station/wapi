#!/usr/bin/env node
/**
 * Typecheck every workspace that has a tsconfig.
 *
 * The root `typecheck` script used to be `tsc --build`, which fails immediately: there is no
 * root tsconfig.json, only tsconfig.base.json, and `--build` wants a solution file. So the
 * documented command was broken while CI stayed green — CI carried its own hardcoded loop over
 * eight project paths and never ran the root script.
 *
 * Two lists that must agree but are written in different files is the same drift the Dockerfile
 * manifest check exists to prevent, and it had already started: the CI list omitted `apps/web`.
 * The list is now derived from the workspace globs in package.json, which is the only source
 * that cannot disagree with reality, and CI runs this script rather than a copy of it.
 *
 * Run: node ops/typecheck.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** Minimal glob support: the only patterns used are `dir/*` and a bare directory name. */
function expand(pattern) {
  if (!pattern.includes("*")) return [pattern];
  const [base] = pattern.split("/*");
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .map((name) => join(base, name).replaceAll("\\", "/"))
    .filter((p) => statSync(p).isDirectory());
}

const projects = (pkg.workspaces ?? [])
  .flatMap(expand)
  .filter((dir) => existsSync(join(dir, "tsconfig.json")))
  .sort();

if (projects.length === 0) {
  console.error("no workspaces with a tsconfig.json — check package.json `workspaces`");
  process.exit(1);
}

/**
 * Resolve the local tsc once rather than per project; `npx` would re-resolve every time.
 *
 * The shim's extension depends on the installer, not just the platform: npm writes `tsc.cmd`
 * on Windows and bun writes `tsc.exe`. Probing beats assuming — hardcoding `.cmd` made this
 * script report "typescript is not installed" on a machine where it plainly was.
 */
const binDir = join(root, "node_modules", ".bin");
const tsc = ["tsc", "tsc.cmd", "tsc.exe", "tsc.bunx"]
  .map((name) => join(binDir, name))
  .find(existsSync);
if (!tsc) {
  console.error("typescript is not installed — run `bun install` first");
  process.exit(1);
}

const failed = [];
for (const project of projects) {
  process.stdout.write(`  ${project} … `);
  const result = spawnSync(tsc, ["--noEmit", "-p", join(project, "tsconfig.json")], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status === 0) {
    console.log("ok");
  } else {
    console.log("FAILED");
    if (output) console.log(output.split("\n").map((l) => `      ${l}`).join("\n"));
    failed.push(project);
  }
}

if (failed.length) {
  console.error(`\ntypecheck failed in ${failed.length}: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`\nok — ${projects.length} projects typecheck`);
