import Link from "next/link";
import { AppNav } from "@/components/app-nav";
import { AuditDetail } from "@/components/audit-detail";
import { AuditFilters, type FilterField } from "@/components/audit-filters";
import { AuditRow } from "@/components/audit-row";
import { Empty, Pager } from "@/components/pager";
import { type AuditFilter, auditFilterOptions, getAuditLog, listAuditLogs, listSessions } from "@/lib/data";

export const dynamic = "force-dynamic";

const PER_PAGE = 50;

type Params = {
  code?: string;
  credential?: string;
  ip?: string;
  method?: string;
  page?: string;
  route?: string;
  selected?: string;
  session?: string;
  status?: string;
  ua?: string;
};

/**
 * The audit trail.
 *
 * A list and a detail sidebar, both rendered on the server, with every filter and the selection in
 * the query string. That last part is what makes the whole page work: the sidebar is not client
 * state, it is `?selected=<id>` — so the panel keeps the build-time highlighter for bodies, a
 * narrowed view can be linked and reloaded, and the browser's back button steps through selections
 * the way it should.
 */
export default async function AuditPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const selectedId = sp.selected ? Number(sp.selected) : undefined;

  const filter: AuditFilter = {
    ...(sp.session ? { sessionId: Number(sp.session) } : {}),
    ...(sp.status === "errors" ? { status: "errors" as const } : {}),
    ...(sp.code && Number(sp.code) ? { code: Number(sp.code) } : {}),
    ...(sp.method ? { method: sp.method } : {}),
    ...(sp.route ? { route: sp.route } : {}),
    ...(sp.ip ? { ip: sp.ip } : {}),
    ...(sp.credential ? { credential: sp.credential } : {}),
    ...(sp.ua ? { userAgent: sp.ua } : {}),
  };

  const [{ rows, total }, sessions, options, selected] = await Promise.all([
    listAuditLogs(page, PER_PAGE, filter),
    listSessions(),
    auditFilterOptions(),
    // Fetched by id rather than found in `rows`: a permalinked selection may sit on another page,
    // and it is account-scoped either way, so a stray id cannot reach somebody else's row.
    selectedId ? getAuditLog(selectedId) : Promise.resolve(null),
  ]);

  /** A row's href: the current query string with `selected` swapped, so filters survive a click. */
  const rowHref = (id: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "selected") q.set(k, String(v));
    q.set("selected", String(id));
    return `/audit?${q.toString()}`;
  };

  const closeHref = () => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "selected") q.set(k, String(v));
    const s = q.toString();
    return `/audit${s ? `?${s}` : ""}`;
  };

  const fields: FilterField[] = [
    {
      key: "route",
      label: "Endpoint",
      placeholder: "/api/send-message",
      // The pattern, so one badge covers every call to an endpoint rather than one group's id.
      short: (v) => (v.length > 26 ? `…${v.slice(-25)}` : v),
      suggestions: options.routes,
    },
    { key: "ip", label: "IP", placeholder: "203.0.113 matches the subnet", suggestions: options.ips },
    { key: "method", label: "Method", placeholder: "POST", suggestions: options.methods },
    {
      key: "credential",
      label: "Credential",
      placeholder: "session, pat or none",
      suggestions: ["session", "pat", "none"],
    },
    { key: "code", label: "Status", placeholder: "429" },
    {
      key: "ua",
      label: "User agent",
      placeholder: "curl, node, wapi-cli…",
      short: (v) => (v.length > 18 ? `${v.slice(0, 17)}…` : v),
    },
    {
      key: "session",
      label: "Session",
      placeholder: sessions[0] ? `${sessions[0].id}` : "session id",
      // Names are ambiguous — two sessions may share one — so the value is the id, shown by name.
      short: (v) => sessions.find((s) => String(s.id) === v)?.name ?? `#${v}`,
      suggestions: sessions.map((s) => String(s.id)),
    },
  ];

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
            One row per API request: which credential acted, from where, what came in, what went
            out, and how long it took. Credentials are never stored — only which kind was used.
          </p>
        </header>

        <AuditFilters
          fields={fields}
          toggles={[{ active: sp.status === "errors", key: "status", label: "Errors only", value: "errors" }]}
        />

        {total === 0 ? (
          <Empty
            hint="Every call to the API is logged here. If you have filters on, try clearing them — otherwise the trail simply starts at the first request after this shipped."
            title="Nothing matches"
          />
        ) : (
          <div
            className={
              "mt-6 " +
              // The list narrows rather than the panel overlaying it, so the row you picked stays
              // visible beside what it opened.
              (selected ? "grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_420px]" : "")
            }
          >
            <div>
              <div className="grid gap-px overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--border)]">
                {rows.map((r) => (
                  <AuditRow href={rowHref(r.id)} key={r.id} row={r} selected={r.id === selectedId} />
                ))}
              </div>
              <Pager basePath="/audit" page={page} perPage={PER_PAGE} total={total} />
            </div>

            {selected ? (
              <aside
                /*
                 * Sticky, so the panel stays put while the list scrolls under it — the list is 50
                 * rows and the panel is the thing being read. Its own scroll is capped to the
                 * viewport because a response body can be long.
                 */
                className="sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-5"
              >
                <div className="flex items-baseline justify-between gap-4">
                  <p className="code text-[0.8rem] text-[var(--muted-foreground)]">
                    entry #{selected.id}
                  </p>
                  <div className="flex items-center gap-3 text-[0.8rem]">
                    <Link
                      className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                      href={`/audit/${selected.id}`}
                      // The permalink, for sending to somebody. The panel is for reading here.
                      title="Open this entry on its own page"
                    >
                      Permalink
                    </Link>
                    <Link
                      aria-label="Close the detail panel"
                      className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                      href={closeHref()}
                      scroll={false}
                    >
                      ×
                    </Link>
                  </div>
                </div>
                <h2 className="code mt-2 text-[0.95rem] break-all">
                  {selected.method} {selected.route ?? selected.path}
                </h2>
                <div className="mt-4">
                  <AuditDetail compact row={selected} />
                </div>
              </aside>
            ) : null}
          </div>
        )}

        {total > 0 ? (
          <p className="mt-6 text-[0.8rem] leading-[1.7] text-[var(--muted-foreground)]">
            Bodies are dropped after 7 days and rows after 90. Request and response bodies carry
            message text and recipient numbers, so a deployment that would rather not keep them can
            set <code className="code">AUDIT_BODIES=off</code> and retain the metadata trail only.
          </p>
        ) : null}
      </main>
    </>
  );
}
