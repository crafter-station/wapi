/**
 * Does the CLI have a command for every API operation?
 *
 * The SDK guard answers this for three client libraries by grepping each one for an operation's
 * URL, because SDK methods contain the URL literally. CLI commands do not — they call SDK
 * methods — so the mapping is declared in `apps/cli/src/coverage.ts` and checked here.
 *
 * Two directions, because a table that only had to be a superset would rot in both:
 *
 *   1. Every operation in `ROUTES + EXTENSION_ROUTES` is claimed by some command. This is the
 *      point: a new endpoint makes CI red until somebody gives it a command.
 *   2. Every command path in the table resolves in the real command tree, and every operation id
 *      exists in the contract. A rename or a typo therefore breaks the build instead of quietly
 *      un-covering an operation while still looking complete.
 *
 * What it deliberately cannot check is whether `groups leave` really calls
 * `POST /api/groups/{id}/leave`; that needs running the command, which is `compat/cli.test.ts`.
 * This is the cheap question, asked on every push.
 *
 * Run with bun, not node — it imports TypeScript sources.
 */
import { ROUTES, EXTENSION_ROUTES } from "../packages/contracts/src/index.ts";
import { COVERAGE } from "../apps/cli/src/coverage.ts";
import { buildProgram } from "../apps/cli/src/program.ts";

let failed = false;
const fail = (headline, lines = []) => {
  failed = true;
  console.error(`  FAIL  ${headline}`);
  for (const line of lines) console.error(`          ${line}`);
};

const operations = new Map([...ROUTES, ...EXTENSION_ROUTES].map((r) => [r.operationId, r]));

/** Every command path the built tree actually offers, as space-separated names. */
function commandPaths(command, prefix = []) {
  const paths = [];
  for (const child of command.commands) {
    const here = [...prefix, child.name()];
    // A group like `wapi sessions` is not itself a command that does anything; only leaves count.
    if (child.commands.length) paths.push(...commandPaths(child, here));
    else paths.push(here.join(" "));
  }
  return paths;
}

const available = new Set(commandPaths(buildProgram()));

// 1. Every operation has a command.
const claimed = new Set(Object.values(COVERAGE));
const uncovered = [...operations.keys()].filter((id) => !claimed.has(id));
if (uncovered.length) {
  fail(
    `the CLI has no command for ${uncovered.length} operation(s):`,
    uncovered.map((id) => {
      const r = operations.get(id);
      return `${r.method} ${r.path.replace(/\{[^}]+\}/g, "{}")}  (${id})`;
    }),
  );
} else {
  console.log(`  ok    all ${operations.size} operations have a command`);
}

// 2a. Every declared command path exists.
const missingCommands = Object.keys(COVERAGE).filter((path) => !available.has(path));
if (missingCommands.length) {
  fail(
    `${missingCommands.length} declared command(s) do not exist — renamed, or a typo:`,
    missingCommands,
  );
}

// 2b. Every declared operation id exists.
const unknownOps = Object.entries(COVERAGE).filter(([, id]) => !operations.has(id));
if (unknownOps.length) {
  fail(
    `${unknownOps.length} declared operation(s) are not in the contract:`,
    unknownOps.map(([path, id]) => `${path} -> ${id}`),
  );
}

if (!missingCommands.length && !unknownOps.length) {
  console.log(`  ok    all ${Object.keys(COVERAGE).length} declared commands resolve`);
}

/**
 * `wapi api` must never be declared. If the escape hatch counted as coverage the first check
 * above would pass forever, which is the failure mode this whole guard exists to prevent.
 */
if (Object.keys(COVERAGE).some((path) => path === "api" || path.startsWith("api "))) {
  fail("`wapi api` is declared as covering an operation — it is an escape hatch, not coverage.");
}

console.log(failed ? "\ncli command check failed" : "\nok — the CLI covers the API");
process.exit(failed ? 1 : 0);
