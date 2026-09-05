import { EXTENSION_ROUTES, ROUTES } from "@wapi/contracts";
import { COVERAGE } from "@wapi/cli/coverage";

/**
 * The CLI's whole surface, generated.
 *
 * Every row comes from `COVERAGE` — the table `ops/check-cli-in-sync.mjs` already checks in both
 * directions — joined against the route contract for the method, path and credential. Writing this
 * list by hand would make it the fourth place the 57 operations are enumerated, and the only one
 * nothing verifies. Generated, it cannot describe a command that does not exist, and a new
 * endpoint appears here the moment it is covered.
 */
export function CommandTable() {
  type Route = (typeof ROUTES)[number] | (typeof EXTENSION_ROUTES)[number];
  const byId = new Map<string, Route>(
    [...ROUTES, ...EXTENSION_ROUTES].map((r) => [r.operationId, r] as [string, Route]),
  );

  const rows = Object.entries(COVERAGE)
    .map(([command, operationId]) => ({ command, route: byId.get(operationId) }))
    .filter((r) => r.route !== undefined)
    .sort((a, b) => a.command.localeCompare(b.command));

  return (
    <div className="not-prose my-6 overflow-x-auto">
      <table className="w-full border-collapse text-[0.85rem]">
        <thead>
          <tr className="border-b border-[var(--color-fd-border)] text-left">
            <th className="py-2 pr-4 font-[580]">Command</th>
            <th className="py-2 pr-4 font-[580]">Method</th>
            <th className="py-2 pr-4 font-[580]">Path</th>
            <th className="py-2 font-[580]">Credential</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ command, route }) => (
            <tr className="border-b border-[var(--color-fd-border)]/60" key={command}>
              <td className="py-1.5 pr-4 font-mono whitespace-nowrap">wapi {command}</td>
              <td className="py-1.5 pr-4 font-mono text-[var(--color-fd-muted-foreground)]">
                {route!.method}
              </td>
              <td className="py-1.5 pr-4 font-mono">{route!.path}</td>
              <td className="py-1.5 whitespace-nowrap text-[var(--color-fd-muted-foreground)]">
                {route!.scope === "pat" ? "PAT" : "session key"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-[0.8rem] text-[var(--color-fd-muted-foreground)]">
        {rows.length} commands, generated from the CLI&rsquo;s coverage table.
      </p>
    </div>
  );
}
