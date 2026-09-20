import Link from "next/link";
import type { AuditLog } from "@wapi/db";

/**
 * One line in the audit list.
 *
 * A link, still — but now to `?selected=<id>` on the list itself rather than to a separate page.
 * The reason the first version linked out at all was that expanding in place needed client state,
 * which would have forced bodies to render as plain text: the highlighter runs at build time on the
 * server, so a client-rendered panel cannot use it.
 *
 * Selecting through the query string keeps both. The panel is still a server component with full
 * highlighting, the row is still a plain link that middle-clicks and opens in a new tab, and the
 * filters stay in the URL beside it. `/audit/<id>` remains as a permalink for sending to somebody.
 */
const tone = (status: number) => (status >= 400 ? "var(--destructive)" : "var(--muted-foreground)");

export function AuditRow({
  href,
  row,
  selected,
}: {
  href: string;
  row: AuditLog;
  selected: boolean;
}) {
  return (
    <Link
      className={
        "flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-[0.875rem] transition-colors " +
        (selected ? "bg-[var(--muted)]" : "bg-[var(--card)] hover:bg-[var(--muted)]")
      }
      href={href}
      // Scrolling to the top on every row click would throw away the reader's place in the list.
      scroll={false}
    >
      {/*
        A left rule on the selected row rather than a background alone: the hover state is the same
        wash, so without it the row under the cursor and the row being shown look identical.
      */}
      <span
        aria-hidden
        className="-ml-4 mr-0 h-5 w-[2px] shrink-0"
        style={{ background: selected ? "var(--foreground)" : "transparent" }}
      />
      <span className="code w-[52px] shrink-0 font-[560]">{row.method}</span>
      {/* The pattern, not the concrete path: a hundred group ids read as one endpoint. */}
      <span className="code min-w-[180px] flex-1 truncate">{row.route ?? row.path}</span>
      <span className="code w-[40px] shrink-0" style={{ color: tone(row.status) }}>
        {row.status}
      </span>
      <span className="w-[60px] shrink-0 text-right text-[var(--muted-foreground)]">
        {row.durationMs != null ? `${row.durationMs}ms` : ""}
      </span>
      {/* Which credential acted — the audit question. The token itself is never stored. */}
      <span className="w-[62px] shrink-0 text-[var(--muted-foreground)]">
        {row.credentialKind ?? "none"}
      </span>
      {/*
        The address, which is the column this list was missing. Hidden below `lg` rather than
        wrapped: on a narrow screen it pushes the time onto a second line and turns a scannable
        list into a stack of paragraphs. It is always in the panel.
      */}
      <span className="code hidden w-[120px] shrink-0 truncate text-[var(--muted-foreground)] lg:inline">
        {row.ip ?? "—"}
      </span>
      <span className="code shrink-0 text-[0.8rem] text-[var(--muted-foreground)]">
        {row.createdAt.toISOString().slice(11, 19)}
      </span>
    </Link>
  );
}
