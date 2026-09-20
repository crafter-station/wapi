import Link from "next/link";
import { notFound } from "next/navigation";
import { AppNav } from "@/components/app-nav";
import { AuditDetail } from "@/components/audit-detail";
import { getAuditLog } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * One audit entry, on its own page.
 *
 * The body of this is `AuditDetail`, shared with the sidebar on `/audit`, so the two cannot drift
 * into describing the same row differently. This page exists for the thing a sidebar cannot be:
 * a link you can send to somebody.
 */
export default async function AuditDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = await getAuditLog(Number(id));
  if (!row) notFound();

  return (
    <>
      <AppNav active="audit" />
      <main className="shell py-12">
        <Link
          className="text-[0.85rem] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          href="/audit"
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

        <div className="mt-8">
          <AuditDetail row={row} />
        </div>

        <p className="mt-8 text-[0.8rem] leading-[1.7] text-[var(--muted-foreground)]">
          Headers are allow-listed and credentials are never stored — <code className="code">
          Authorization</code> is dropped rather than masked, and secrets inside bodies are
          replaced before the row is written.
        </p>
      </main>
    </>
  );
}
