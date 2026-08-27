import Link from "next/link";
import { AppNav } from "@/components/app-nav";
import { AuditRow } from "@/components/audit-row";
import { Empty, Pager } from "@/components/pager";
import { listAuditLogs, listSessions } from "@/lib/data";

export const dynamic = "force-dynamic";

const PER_PAGE = 50;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; session?: string; status?: string }>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const sessionId = sp.session ? Number(sp.session) : undefined;
  const status = sp.status === "errors" ? ("errors" as const) : undefined;

  const [{ rows, total }, sessions] = await Promise.all([
    listAuditLogs(page, PER_PAGE, {
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(status === undefined ? {} : { status }),
    }),
    listSessions(),
  ]);

  // Filters live in the URL so a filtered view can be linked, reloaded and gone back from.
  const href = (next: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    const merged = { session: sp.session, status: sp.status, ...next };
    for (const [k, v] of Object.entries(merged)) if (v) q.set(k, v);
    const s = q.toString();
    return `/audit${s ? `?${s}` : ""}`;
  };

  const chip = (label: string, target: string, on: boolean) => (
    <Link
      key={label}
      href={target}
      className={
        "rounded-[var(--radius)] border px-3 py-1.5 text-[0.8rem] transition-colors " +
        (on
          ? "border-[var(--foreground)] text-[var(--foreground)]"
          : "border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]")
      }
    >
      {label}
    </Link>
  );

  return (
    <>
      <AppNav active="audit" />
      <main className="shell py-12">
        <header>
          <p className="kicker">Audit</p>
          <h1 className="title mt-3">
            Every call, <em>and what we answered.</em>
          </h1>
          <p className="lede mt-5 max-w-[640px]">
            One row per API request: which credential acted, what came in, what went out, and how
            long it took. Credentials are never stored — only which kind was used.
          </p>
        </header>

        <div className="mt-8 flex flex-wrap gap-2">
          {chip("All", href({ session: undefined, status: undefined, page: undefined }), !sessionId && !status)}
          {chip("Errors only", href({ status: status ? undefined : "errors", page: undefined }), !!status)}
          {sessions.map((s) =>
            chip(
              s.name,
              href({ session: sessionId === s.id ? undefined : String(s.id), page: undefined }),
              sessionId === s.id,
            ),
          )}
        </div>

        {total === 0 ? (
          <Empty
            title="Nothing recorded yet"
            hint="Every call to the API is logged here. Requests made before this feature shipped are not — the trail starts now."
          />
        ) : (
          <>
            <div className="mt-6 grid gap-px overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--border)]">
              {rows.map((r) => (
                <AuditRow key={r.id} row={r} />
              ))}
            </div>
            <Pager basePath="/audit" page={page} perPage={PER_PAGE} total={total} />
            <p className="mt-6 text-[0.8rem] leading-[1.7] text-[var(--muted-foreground)]">
              Bodies are dropped after 7 days and rows after 90. Request and response bodies carry
              message text and recipient numbers, so a deployment that would rather not keep them
              can set <code className="code">AUDIT_BODIES=off</code> and retain the metadata trail
              only.
            </p>
          </>
        )}
      </main>
    </>
  );
}
