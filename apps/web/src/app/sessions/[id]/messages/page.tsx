import { Empty, Pager } from "@/components/pager";
import { listMessages } from "@/lib/data";

export const dynamic = "force-dynamic";

const PER_PAGE = 50;

/** Their lifecycle words. `/info` reports WhatsApp's numeric ack instead — see AGENTS.md. */
const TONE: Record<string, string> = {
  delivered: "var(--foreground)",
  failed: "var(--destructive)",
  in_progress: "var(--muted-foreground)",
  read: "var(--foreground)",
  sent: "var(--foreground)",
};

export default async function MessagesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id } = await params;
  const { page: raw } = await searchParams;
  const page = Math.max(1, Number(raw ?? 1) || 1);

  const { rows, total } = await listMessages(Number(id), page, PER_PAGE);
  if (total === 0) {
    return (
      <Empty
        title="No messages logged"
        hint="Outbound messages are recorded when message logging is on for this session. Inbound messages arrive through webhooks."
      />
    );
  }

  return (
    <div className="mt-8">
      <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
        <table className="w-full text-left text-[0.875rem]">
          <thead className="border-b border-[var(--border)] text-[var(--muted-foreground)]">
            <tr>
              <th className="px-4 py-2.5 font-[520]">msgId</th>
              <th className="px-4 py-2.5 font-[520]">To</th>
              <th className="px-4 py-2.5 font-[520]">Content</th>
              <th className="px-4 py-2.5 font-[520]">Status</th>
              <th className="px-4 py-2.5 font-[520]">Sent</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const text =
                (m.content?.["text"] as string | undefined) ??
                (m.content?.["caption"] as string | undefined) ??
                (m.content ? Object.keys(m.content)[0] : null);
              return (
                <tr key={m.msgId} className="border-b border-[var(--border)] last:border-0">
                  {/* Our own sequence, not WhatsApp's id — this is what `replyTo` takes. */}
                  <td className="code px-4 py-2.5">{m.msgId}</td>
                  <td className="code max-w-[200px] truncate px-4 py-2.5 text-[var(--muted-foreground)]">
                    {m.remoteJid}
                  </td>
                  <td className="max-w-[320px] truncate px-4 py-2.5">
                    {text ?? <span className="text-[var(--muted-foreground)]">—</span>}
                  </td>
                  <td className="px-4 py-2.5" style={{ color: TONE[m.status] ?? "inherit" }}>
                    {m.status}
                    {m.failedReason ? (
                      <span className="block text-[0.75rem] text-[var(--muted-foreground)]">
                        {m.failedReason}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 text-[var(--muted-foreground)]">
                    {m.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pager
        basePath={`/sessions/${id}/messages`}
        page={page}
        perPage={PER_PAGE}
        total={total}
      />
    </div>
  );
}
