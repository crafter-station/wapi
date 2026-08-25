import { notFound } from "next/navigation";
import { Empty, Pager } from "@/components/pager";
import { sessionApiKey } from "@/lib/data";
import { ApiError, contactsPage } from "@/lib/wapi-api";

export const dynamic = "force-dynamic";

const PER_PAGE = 50;

export default async function ContactsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id } = await params;
  const { page: raw } = await searchParams;
  const page = Math.max(1, Number(raw ?? 1) || 1);

  // The layout already authorised this session; a missing key means it has none, not that
  // someone else's session was requested.
  const key = await sessionApiKey(Number(id));
  if (!key) notFound();

  /**
   * Read through our own API rather than the contacts table.
   *
   * This is the dogfooding half of the data-path decision: if `/api/contacts` regresses, this
   * page regresses with it, which is the only way a fidelity bug surfaces to us before it
   * surfaces to someone integrating.
   */
  let result: Awaited<ReturnType<typeof contactsPage>> | null = null;
  let failure: string | null = null;
  try {
    result = await contactsPage(key, page, PER_PAGE);
  } catch (err) {
    failure =
      err instanceof ApiError && err.status === 409
        ? "The session is not connected. Connect it and try again."
        : err instanceof ApiError
          ? err.message
          : "The API did not respond.";
  }

  if (failure) return <Empty title="Could not load contacts" hint={failure} />;
  const { items, pagination } = result!;
  if (pagination.total === 0) {
    return (
      <Empty
        title="No contacts yet"
        hint="Contacts are learned from message traffic rather than fetched in bulk — they appear as this number exchanges messages."
      />
    );
  }

  return (
    <div className="mt-8">
      <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
        <table className="w-full text-left text-[0.875rem]">
          <thead className="border-b border-[var(--border)] text-[var(--muted-foreground)]">
            <tr>
              <th className="px-4 py-2.5 font-[520]">Name</th>
              <th className="px-4 py-2.5 font-[520]">Number</th>
              <th className="px-4 py-2.5 font-[520]">Identity</th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.jid} className="border-b border-[var(--border)] last:border-0">
                <td className="max-w-[240px] truncate px-4 py-2.5">
                  {c.name ?? c.notify ?? <span className="text-[var(--muted-foreground)]">—</span>}
                </td>
                <td className="code px-4 py-2.5 text-[var(--muted-foreground)]">
                  {c.phoneNumber ?? "—"}
                </td>
                {/* LID is the canonical identity; the phone number is an attribute that may not
                    be known. Showing the jid keeps that visible rather than implying a number. */}
                <td className="code max-w-[280px] truncate px-4 py-2.5 text-[var(--muted-foreground)]">
                  {c.jid}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager
        basePath={`/sessions/${id}/contacts`}
        page={pagination.page}
        perPage={pagination.limit}
        total={pagination.total}
      />
    </div>
  );
}
