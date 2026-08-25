import { notFound } from "next/navigation";
import { SettingsForm } from "@/components/settings-form";
import { getSession, WEBHOOK_EVENTS } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The layout already resolved and authorised this session; re-reading here keeps the page
  // self-contained rather than depending on a value the layout cannot pass down.
  const session = await getSession(Number(id));
  if (!session) notFound();

  return (
    <SettingsForm
      events={WEBHOOK_EVENTS}
      session={{
        accountProtection: session.accountProtection,
        alwaysOnline: session.alwaysOnline,
        autoRejectCalls: session.autoRejectCalls,
        id: session.id,
        ignoreBroadcasts: session.ignoreBroadcasts,
        ignoreChannels: session.ignoreChannels,
        ignoreGroups: session.ignoreGroups,
        logMessages: session.logMessages,
        proxyUrl: session.proxyUrl,
        readIncomingMessages: session.readIncomingMessages,
        webhookEnabled: session.webhookEnabled,
        webhookEvents: session.webhookEvents ?? [],
        webhookHmac: session.webhookHmac,
        webhookUrl: session.webhookUrl,
      }}
    />
  );
}
