import { notFound } from "next/navigation";
import { Empty, Pager } from "@/components/pager";
import { sessionApiKey } from "@/lib/data";
import { ApiError, groupsPage } from "@/lib/wapi-api";

export const dynamic = "force-dynamic";

const PER_PAGE = 50;

export default async function GroupsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id } = await params;
  const { page: raw } = await searchParams;
  const page = Math.max(1, Number(raw ?? 1) || 1);

  const key = await sessionApiKey(Number(id));
  if (!key) notFound();

  let result: Awaited<ReturnType<typeof groupsPage>> | null = null;
  let failure: string | null = null;
  try {
    result = await groupsPage(key, page, PER_PAGE);
  } catch (err) {
    failure =
      err instanceof ApiError && err.status === 409
        ? "The session is not connected. Connect it and try again."
        : err instanceof ApiError
          ? err.message
          : "The API did not respond.";
  }

  if (failure) return <Empty title="Could not load groups" hint={failure} />;
  const { items, pagination } = result!;
  if (pagination.total === 0) {
    return <Empty title="This number is not in any groups" />;
  }

  return (
    <div className="mt-8">
      {/*
        Read-only on purpose. Creating groups and adding or removing participants exist in the
        API, but they act on real people in a real chat and a misclick is not undoable — so they
        are exercised by the integration suite rather than by a button here.
      */}
      <div className="grid gap-px overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--border)]">
        {items.map((g) => {
          const admins = (g.participants ?? []).filter((p) => p.isAdmin).length;
          return (
            <div key={g.jid} className="bg-[var(--card)] p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <p className="font-[580]">{g.name}</p>
                <p className="code text-[0.8rem] text-[var(--muted-foreground)]">{g.jid}</p>
              </div>
              <p className="mt-1.5 text-[0.85rem] text-[var(--muted-foreground)]">
                {(g.participants ?? []).length} participants
                {admins ? ` · ${admins} admin${admins === 1 ? "" : "s"}` : ""}
                {g.creation
                  ? ` · created ${new Date(g.creation * 1000).toISOString().slice(0, 10)}`
                  : ""}
              </p>
              {g.desc ? (
                <p className="mt-2 line-clamp-2 text-[0.85rem] leading-[1.6] text-[var(--muted-foreground)]">
                  {g.desc}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <Pager
        basePath={`/sessions/${id}/groups`}
        page={pagination.page}
        perPage={pagination.limit}
        total={pagination.total}
      />
    </div>
  );
}
