import { EXTENSION_ROUTES, ROUTES, tagFor } from "@wapi/contracts";

const API = process.env["NEXT_PUBLIC_API_URL"] ?? "https://api.wapi.crafter.run";

/** Every operation, indexed by id, so a page can render one from its frontmatter. */
type Route = (typeof ROUTES)[number] | (typeof EXTENSION_ROUTES)[number];
const BY_ID = new Map<string, Route>(
  [...ROUTES, ...EXTENSION_ROUTES].map((r) => [r.operationId, r] as [string, Route]),
);

/**
 * "Operations covered", rendered from the page's own frontmatter.
 *
 * The list is not written in the page body: it comes from the same `operations:` field that
 * `ops/check-docs-in-sync.mjs` reads, so what a page claims to cover and what the guard checks it
 * covers are one string. Writing them separately is how a page ends up advertising an endpoint it
 * no longer documents.
 *
 * Each row deep-links into the generated reference rather than restating the schema. That split is
 * deliberate: the guides carry the reasoning, the reference carries the fields, and neither has to
 * be kept in sync with the other by hand.
 */
export function Operations({ ids }: { ids: string[] }) {
  const rows = ids.map((id) => [id, BY_ID.get(id)] as const).filter(([, r]) => r !== undefined);
  if (!rows.length) return null;

  return (
    <div className="not-prose mt-12 border-t border-[var(--color-fd-border)] pt-6">
      <p className="kicker mb-3">Operations covered</p>
      <ul className="space-y-1">
        {rows.map(([id, route]) => (
          <li key={id} className="text-[0.85rem]">
            <a
              className="flex flex-wrap items-baseline gap-x-3 hover:underline"
              href={`${API}/docs#tag/${tagFor(route!.path).toLowerCase()}/${id}`}
              rel="noreferrer"
              target="_blank"
            >
              <code className="shrink-0 font-mono text-[var(--color-fd-muted-foreground)]">
                {route!.method}
              </code>
              <code className="font-mono">{route!.path}</code>
              <span className="text-[var(--color-fd-muted-foreground)]">
                {route!.scope === "pat" ? "PAT" : "session key"}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
