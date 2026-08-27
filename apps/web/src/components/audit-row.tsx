"use client";

import { useState } from "react";
import type { AuditLog } from "@wapi/db";

/**
 * One audit entry, expandable.
 *
 * Collapsed by default because the useful scan is "what happened, in what order, and did it
 * work" — a wall of headers and bodies buries that. The detail is one click away for the row
 * that turns out to matter.
 */
const tone = (status: number) =>
  status >= 500
    ? "var(--destructive)"
    : status >= 400
      ? "var(--destructive)"
      : "var(--muted-foreground)";

function Pretty({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  let shown = value;
  try {
    shown = JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    /* already a description like "[redacted] (image/png, 4021 bytes)" */
  }
  return (
    <div className="mt-3">
      <p className="kicker">{label}</p>
      <pre className="code mt-1.5 max-h-[280px] overflow-auto whitespace-pre-wrap text-[0.75rem]">
        {shown}
      </pre>
    </div>
  );
}

export function AuditRow({ row }: { row: AuditLog }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="bg-[var(--card)]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left text-[0.875rem] hover:bg-[var(--muted)]"
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
        <span className="w-[70px] shrink-0 text-[var(--muted-foreground)]">
          {/* Which credential acted — the audit question. The token itself is never stored. */}
          {row.credentialKind ?? "none"}
        </span>
        <span className="code shrink-0 text-[0.8rem] text-[var(--muted-foreground)]">
          {row.createdAt.toISOString().slice(11, 19)}
        </span>
      </button>

      {open ? (
        <div className="border-t border-[var(--border)] px-4 py-3">
          <dl className="grid gap-x-6 gap-y-1.5 text-[0.8rem] sm:grid-cols-2">
            {[
              ["Path", row.path],
              ["Session", row.sessionId ? `#${row.sessionId}` : "—"],
              ["IP", row.ip ?? "—"],
              ["Country", row.country ?? "not supplied by the proxy"],
              ["User agent", row.userAgent ?? "—"],
              ["When", row.createdAt.toISOString().replace("T", " ").slice(0, 19)],
            ].map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <dt className="shrink-0 text-[var(--muted-foreground)]">{k}</dt>
                <dd className="code min-w-0 truncate">{v}</dd>
              </div>
            ))}
          </dl>

          {row.error ? (
            <p className="mt-3 text-[0.85rem] text-[var(--destructive)]">{row.error}</p>
          ) : null}

          <Pretty label="Headers" value={JSON.stringify(row.requestHeaders ?? {})} />
          <Pretty label="Request" value={row.requestBody} />
          <Pretty label="Response" value={row.responseBody} />

          {!row.requestBody && !row.responseBody ? (
            /* Two very different reasons, and the difference matters when reading old rows. */
            <p className="mt-3 text-[0.8rem] text-[var(--muted-foreground)]">
              No bodies recorded — either dropped by retention after 7 days, or body capture is
              turned off for this deployment.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
