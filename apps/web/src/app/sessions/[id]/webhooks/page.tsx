import { Empty, Pager } from "@/components/pager";
import { DispatchList } from "@/components/dispatch-list";
import { getSession, listDispatches } from "@/lib/data";

export const dynamic = "force-dynamic";

const PER_PAGE = 50;

export default async function WebhooksPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id } = await params;
  const { page: raw } = await searchParams;
  const page = Math.max(1, Number(raw ?? 1) || 1);
  const sessionId = Number(id);

  const [session, { rows, total }] = await Promise.all([
    getSession(sessionId),
    listDispatches(sessionId, page, PER_PAGE),
  ]);

  if (!session?.webhookEnabled || !session.webhookUrl) {
    return (
      <Empty
        title="Webhooks are not configured"
        hint="Set a delivery URL under Settings and enable delivery. Every attempt then appears here with its status, timing and payload."
      />
    );
  }

  if (total === 0) {
    return (
      <Empty
        title="No deliveries yet"
        hint={`Nothing has been sent to ${session.webhookUrl} yet. Attempts appear here as events occur — note that a session subscribed to specific events only records those.`}
      />
    );
  }

  return (
    <div className="mt-8">
      <p className="text-[0.85rem] text-[var(--muted-foreground)]">
        Delivering to <code className="code">{session.webhookUrl}</code>
        {session.webhookHmac ? " · signed with HMAC-SHA256" : " · shared-secret signature"}
      </p>
      {/* Live: the worker announces each outcome, so this updates without a refresh. */}
      <DispatchList sessionId={sessionId} initial={rows} />
      <Pager
        basePath={`/sessions/${id}/webhooks`}
        page={page}
        perPage={PER_PAGE}
        total={total}
      />
    </div>
  );
}
