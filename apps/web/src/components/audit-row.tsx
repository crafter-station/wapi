import Link from "next/link";
import type { AuditLog } from "@wapi/db";

/**
 * One line in the audit list.
 *
 * A link rather than an expander, which is a deliberate change from the first version. Expanding
 * in place needed client state, and that forced the JSON to render as plain text — highlighting
 * it would have meant running the highlighter over every body on the page, up to 150 blocks per
 * render, to show the one row someone actually cares about.
 *
 * Linking fixes both: the detail page highlights exactly one row with the same component the
 * documentation uses, and an audit entry becomes something you can send to someone. For a trail
 * whose whole purpose is answering "what happened here", a permalink is the more useful
 * primitive anyway.
 */
const tone = (status: number) =>
  status >= 400 ? "var(--destructive)" : "var(--muted-foreground)";

export function AuditRow({ row }: { row: AuditLog }) {
  return (
    <Link
      href={`/audit/${row.id}`}
      className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-[var(--card)] px-4 py-3 text-[0.875rem] transition-colors hover:bg-[var(--muted)]"
    >
      <span className="code w-[52px] shrink-0 font-[560]">{row.method}</span>
      {/* The pattern, not the concrete path: a hundred group ids read as one endpoint. */}
      <span className="code min-w-[200px] flex-1 truncate">{row.route ?? row.path}</span>
      <span className="code w-[40px] shrink-0" style={{ color: tone(row.status) }}>
        {row.status}
      </span>
      <span className="w-[64px] shrink-0 text-right text-[var(--muted-foreground)]">
        {row.durationMs != null ? `${row.durationMs}ms` : ""}
      </span>
      {/* Which credential acted — the audit question. The token itself is never stored. */}
      <span className="w-[70px] shrink-0 text-[var(--muted-foreground)]">
        {row.credentialKind ?? "none"}
      </span>
      <span className="code shrink-0 text-[0.8rem] text-[var(--muted-foreground)]">
        {row.createdAt.toISOString().slice(11, 19)}
      </span>
    </Link>
  );
}
