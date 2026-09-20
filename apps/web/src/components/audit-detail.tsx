import Link from "next/link";
import type { AuditLog } from "@wapi/db";
import { CodeBlock } from "@/components/code";

/**
 * One audit entry in full.
 *
 * A server component, shared by the sidebar on `/audit` and the permalink at `/audit/<id>`, so the
 * two cannot drift into showing different things about the same row. Bodies go through `CodeBlock`,
 * the same component the documentation uses — same highlighter, same theme, same copy button.
 * Reading a stored request should look like reading an example of one, and copying it out to
 * reproduce a call is the obvious next thing after finding it.
 *
 * Keeping this on the server is also what makes the sidebar possible at all: the highlighter runs
 * at build time, so a client-rendered panel would have had to show bodies as plain text.
 */
const pretty = (value: string): string => {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    // Already a description like "[redacted] (image/png, 4021 bytes)".
    return value;
  }
};

/**
 * A fact, and where clicking it leads.
 *
 * The identifying ones — endpoint, address, credential — double as filters, because the question
 * after "what is this row?" is almost always "what else did this do?". Making them links saves
 * copying a value out and typing it back into a badge.
 */
type Fact = { filter?: string; label: string; value: string };

export function AuditDetail({ compact = false, row }: { compact?: boolean; row: AuditLog }) {
  const facts: Fact[] = [
    {
      ...(row.route ? { filter: `/audit?route=${encodeURIComponent(row.route)}` } : {}),
      label: "Endpoint",
      value: `${row.method} ${row.route ?? row.path}`,
    },
    { label: "Path", value: row.path },
    { filter: `/audit?code=${row.status}`, label: "Status", value: String(row.status) },
    { label: "Duration", value: row.durationMs != null ? `${row.durationMs}ms` : "—" },
    {
      ...(row.credentialKind ? { filter: `/audit?credential=${row.credentialKind}` } : {}),
      label: "Credential",
      value: row.credentialKind ?? "none — the request was rejected",
    },
    {
      ...(row.sessionId ? { filter: `/audit?session=${row.sessionId}` } : {}),
      label: "Session",
      value: row.sessionId ? `#${row.sessionId}` : "—",
    },
    {
      ...(row.ip ? { filter: `/audit?ip=${encodeURIComponent(row.ip)}` } : {}),
      label: "IP",
      value: row.ip ?? "—",
    },
    // Null unless a proxy supplies it; we never infer location locally.
    { label: "Country", value: row.country ?? "not supplied by the proxy" },
    {
      ...(row.userAgent ? { filter: `/audit?ua=${encodeURIComponent(row.userAgent)}` } : {}),
      label: "User agent",
      value: row.userAgent ?? "—",
    },
    { label: "When", value: `${row.createdAt.toISOString().replace("T", " ").slice(0, 19)} UTC` },
  ];

  return (
    <>
      <dl
        className={
          "grid gap-x-8 gap-y-2.5 text-[0.85rem] " +
          (compact ? "grid-cols-1" : "card p-6 sm:grid-cols-2")
        }
      >
        {facts.map((f) => (
          <div className="flex gap-3" key={f.label}>
            <dt className="w-[86px] shrink-0 text-[var(--muted-foreground)]">{f.label}</dt>
            <dd className="code min-w-0 break-all">
              {f.filter ? (
                <Link
                  className="underline decoration-[var(--border)] underline-offset-2 hover:decoration-[var(--foreground)]"
                  href={f.filter}
                  title={`Show every row with this ${f.label.toLowerCase()}`}
                >
                  {f.value}
                </Link>
              ) : (
                f.value
              )}
            </dd>
          </div>
        ))}
      </dl>

      {row.error ? (
        <p className="mt-5 text-[0.85rem] text-[var(--destructive)]">{row.error}</p>
      ) : null}

      <div className={compact ? "mt-5 space-y-3" : "mt-8 space-y-4"}>
        <CodeBlock
          code={pretty(JSON.stringify(row.requestHeaders ?? {}))}
          label="Request headers"
          lang="json"
        />
        {row.requestBody ? (
          <CodeBlock code={pretty(row.requestBody)} label="Request body" lang="json" />
        ) : null}
        {row.responseBody ? (
          <CodeBlock code={pretty(row.responseBody)} label="Response body" lang="json" />
        ) : null}
      </div>

      {!row.requestBody && !row.responseBody ? (
        /* Two very different reasons, and the difference matters when reading an old row. */
        <p className="mt-4 text-[0.8rem] leading-[1.7] text-[var(--muted-foreground)]">
          No bodies recorded. Either retention dropped them after seven days, or this deployment
          runs with <code className="code">AUDIT_BODIES=off</code> and keeps metadata only.
        </p>
      ) : null}
    </>
  );
}
