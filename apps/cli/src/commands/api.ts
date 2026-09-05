import { ROUTES, EXTENSION_ROUTES } from "@wapi/contracts";
import type { Command } from "commander";
import { accountClient, context, sessionClient } from "../client.ts";
import { EXIT, fail, info, warn } from "../output.ts";

/**
 * `wapi api <METHOD> <path>` — the escape hatch.
 *
 * For endpoints that ship before their command does, and for one-off calls nobody should have to
 * write a command for. It deliberately **does not** count towards command coverage: if it did,
 * the coverage guard would pass on day one and forever, and there would be no pressure to build
 * the ergonomic surface this exists to complement.
 *
 * The useful part is that it picks the right credential. Every route declares whether it wants a
 * PAT or a session key, so the CLI reads that rather than guessing — which matters because
 * guessing wrong produces a `403` that reads like a permissions problem and is really a
 * configuration one.
 */
export function registerApi(program: Command): void {
  program
    .command("api")
    .argument("<method>", "GET, POST, PUT or DELETE")
    .argument("<path>", "e.g. /api/status")
    .description("Call any endpoint directly, with the right credential attached")
    .option("-d, --data <json>", "request body as JSON")
    .option("--as <kind>", "force a credential: pat or session")
    .action(async (method: string, rawPath: string, opts: { as?: string; data?: string }) => {
      const ctx = context(program.opts());
      const verb = method.toUpperCase();
      const path = unmangle(rawPath);
      if (!["GET", "POST", "PUT", "DELETE"].includes(verb)) {
        fail(`Unsupported method: ${method}`, EXIT.usage);
      }

      let body: unknown;
      if (opts.data) {
        try {
          body = JSON.parse(opts.data);
        } catch {
          fail("--data is not valid JSON.", EXIT.usage);
        }
      }

      const scope = opts.as ?? scopeFor(verb, path);
      if (scope !== "pat" && scope !== "session") {
        fail(`--as must be pat or session, not ${scope}`, EXIT.usage);
      }

      const client = scope === "pat" ? accountClient(ctx) : await sessionClient(ctx);
      // Reaching into the SDK's transport on purpose: this command exists to bypass the typed
      // surface, and wrapping it in one would defeat the point.
      const transport = (client as unknown as { http: { request: (m: string, p: string, o?: unknown) => Promise<unknown> } }).http;

      const res = await transport.request(verb, path, body === undefined ? undefined : { body });
      info(JSON.stringify(res, null, 2));
    });
}

/**
 * Undo MSYS path conversion.
 *
 * Git Bash and MSYS2 rewrite an argument that looks like a Unix path into a Windows one before the
 * program ever sees it, so `wapi api GET /api/status` arrives as
 * `C:/Program Files/Git/api/status`. The documented fix is for the user to set
 * `MSYS_NO_PATHCONV=1`, which is not a thing anybody should have to discover from a URL parse
 * error — and this repo is developed on Windows, so it is the first thing that happens there.
 *
 * The recovery is narrow on purpose: only when the argument does not already start with `/` and
 * contains `/api/`, take from `/api/` onward. A correctly-typed path is untouched.
 */
function unmangle(path: string): string {
  if (path.startsWith("/")) return path;
  const at = path.indexOf("/api/");
  if (at === -1) return path;
  const recovered = path.slice(at);
  warn(`Your shell rewrote the path. Using ${recovered} — set MSYS_NO_PATHCONV=1 to stop that.`);
  return recovered;
}

/**
 * Match a path against the declared routes to find its credential scope.
 *
 * Matching is on shape, not string equality, because a real call carries values where the
 * contract carries `{placeholders}`. An unknown path falls back to `session`: most of the surface
 * is session-scoped, and being wrong there produces a clear `403` rather than a confusing one.
 */
function scopeFor(method: string, path: string): "pat" | "session" {
  const clean = path.split("?")[0] ?? path;
  const parts = clean.split("/").filter(Boolean);

  for (const route of [...ROUTES, ...EXTENSION_ROUTES]) {
    if (route.method !== method) continue;
    const shape = route.path.split("/").filter(Boolean);
    if (shape.length !== parts.length) continue;

    const matches = shape.every(
      (segment, i) => segment.startsWith("{") || segment === parts[i],
    );
    if (matches) return route.scope;
  }
  return "session";
}
