import Link from "next/link";

/**
 * Server-rendered pagination.
 *
 * The page lives in the URL rather than in component state, so a page of results is a thing you
 * can link to, reload, and go back from. Client-side paging would also mean filtering only what
 * happens to be loaded, which looks correct on a small account and quietly lies on a real one.
 */
export function Pager({
  page,
  total,
  perPage,
  basePath,
}: {
  page: number;
  total: number;
  perPage: number;
  basePath: string;
}) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (total === 0) return null;

  const from = (page - 1) * perPage + 1;
  const to = Math.min(total, page * perPage);
  const link = (p: number) => `${basePath}?page=${p}`;

  return (
    <div className="mt-5 flex items-center justify-between gap-4 text-[0.85rem]">
      <span className="text-[var(--muted-foreground)]">
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-1">
        {page > 1 ? (
          <Link href={link(page - 1)} className="btn btn-ghost !px-3 !py-1.5">
            Previous
          </Link>
        ) : (
          <span className="btn btn-ghost !px-3 !py-1.5 opacity-40">Previous</span>
        )}
        <span className="px-3 text-[var(--muted-foreground)]">
          {page} / {pages}
        </span>
        {page < pages ? (
          <Link href={link(page + 1)} className="btn btn-ghost !px-3 !py-1.5">
            Next
          </Link>
        ) : (
          <span className="btn btn-ghost !px-3 !py-1.5 opacity-40">Next</span>
        )}
      </div>
    </div>
  );
}

/** Shared empty state, so "nothing here" always reads the same way. */
export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mt-8 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-10 text-center">
      <p className="font-[580]">{title}</p>
      {hint ? (
        <p className="mx-auto mt-2 max-w-[420px] text-[0.875rem] leading-[1.7] text-[var(--muted-foreground)]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
