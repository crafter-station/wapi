import Link from "next/link";
import { notFound } from "next/navigation";
import { AppNav } from "@/components/app-nav";
import { CodeBlock } from "@/components/code";
import { getAuditLog } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * One audit entry in full.
 *
 * Bodies go through `CodeBlock`, the same component the documentation uses — same highlighter,
 * same theme, same copy button. Reading a stored request should look like reading an example of
 * one, and copying it out to reproduce a call is the obvious next thing after finding it.
 */
const pretty = (value: string): string => {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    // Already a description like "[redacted] (image/png, 4021 bytes)".
    return value;
  }
};

export default async function AuditDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = await getAuditLog(Number(id));
  if (!row) notFound();

  const facts: [string, string][] = [
    ["Endpoint", `${row.method} ${row.route ?? row.path}`],
    ["Path", row.path],
    ["Status", String(row.status)],
    ["Duration", row.durationMs != null ? `${row.durationMs}ms` : "—"],
    ["Credential", row.credentialKind ?? "none — the request was rejected"],
    ["Session", row.sessionId ? `#${row.sessionId}` : "—"],
    ["IP", row.ip ?? "—"],
    // Null unless a proxy supplies it; we never infer location locally.
    ["Country", row.country ?? "not supplied by the proxy"],
    ["User agent", row.userAgent ?? "—"],
    ["When", `${row.createdAt.toISOString().replace("T", " ").slice(0, 19)} UTC`],
  ];

  return (
    <>
      <AppNav active="audit" />
      <main className="shell py-12">
        <Link
          href="/audit"
          className="text-[0.85rem] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          ← Audit
        </Link>

        <header className="mt-4">
          <h1 className="title">
            <span className="code">{row.method}</span> {row.route ?? row.path}
          </h1>
          <p className="code mt-2 text-[var(--muted-foreground)]">
            entry #{row.id} · {row.status} · {row.durationMs}ms
          </p>
        </header>

        <dl className="card mt-8 grid gap-x-8 gap-y-2.5 p-6 text-[0.875rem] sm:grid-cols-2">
          {facts.map(([k, v]) => (
            <div key={k} className="flex gap-3">
              <dt className="w-[92px] shrink-0 text-[var(--muted-foreground)]">{k}</dt>
              <dd className="code min-w-0 break-all">{v}</dd>
            </div>
          ))}
        </dl>

        {row.error ? (
          <p className="mt-6 text-[0.9rem] text-[var(--destructive)]">{row.error}</p>
        ) : null}

        <div className="mt-8 space-y-4">
          <CodeBlock
            label="Request headers"
            lang="json"
            code={pretty(JSON.stringify(row.requestHeaders ?? {}))}
          />
          {row.requestBody ? (
            <CodeBlock label="Request body" lang="json" code={pretty(row.requestBody)} />
          ) : null}
          {row.responseBody ? (
            <CodeBlock label="Response body" lang="json" code={pretty(row.responseBody)} />
          ) : null}
        </div>

        {!row.requestBody && !row.responseBody ? (
          /* Two very different reasons, and the difference matters when reading an old row. */
          <p className="mt-4 text-[0.85rem] leading-[1.7] text-[var(--muted-foreground)]">
            No bodies recorded. Either retention dropped them after seven days, or this deployment
            runs with <code className="code">AUDIT_BODIES=off</code> and keeps metadata only.
          </p>
        ) : null}

        <p className="mt-8 text-[0.8rem] leading-[1.7] text-[var(--muted-foreground)]">
          Headers are allow-listed and credentials are never stored — <code className="code">
          Authorization</code> is dropped rather than masked, and secrets inside bodies are
          replaced before the row is written.
        </p>
      </main>
    </>
  );
}
