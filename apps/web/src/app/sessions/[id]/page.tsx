import Link from "next/link";
import { notFound } from "next/navigation";
import { decryptSecret } from "@wapi/core";
import { CodeBlock } from "@/components/code";
import { LiveSession } from "@/components/live-session";
import { RegenerateKey } from "@/components/regenerate-key";
import { RevealKey } from "@/components/reveal-key";
import { getSession } from "@/lib/data";

export const dynamic = "force-dynamic";

const API = "https://api.wapi.crafter.run";

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(Number(id));
  if (!session) notFound();

  // The one place a session key is decrypted. Stored AES-256-GCM rather than in the clear,
  // because their API returns it on every GET so hash-only storage is not an option.
  let apiKey: string | null = null;
  try {
    apiKey = session.apiKeyEncrypted ? decryptSecret(session.apiKeyEncrypted) : null;
  } catch {
    apiKey = null;
  }

  const examples = [
    {
      label: "Send a message",
      code: `curl -X POST ${API}/api/send-message \\
  -H "Authorization: Bearer $KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"to":"${session.phoneNumber}","text":"hello"}'`,
    },
    {
      label: "List groups",
      code: `curl ${API}/api/groups \\
  -H "Authorization: Bearer $KEY"`,
    },
    {
      label: "Send to a group",
      code: `curl -X POST ${API}/api/send-message \\
  -H "Authorization: Bearer $KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"to":"1203633...@g.us","text":"hello team"}'`,
    },
  ];

  return (
    <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-8">
            <section>
              <p className="kicker">Session API key</p>
              <p className="mt-2 max-w-[560px] text-[0.875rem] leading-[1.7] text-[var(--muted-foreground)]">
                Use this for messaging, contacts and groups. It identifies the session, which is
                why those endpoints carry no session id. Account-level actions — creating or
                deleting sessions, setting a proxy — need a Personal Access Token instead.
              </p>
              <div className="mt-4">
                <RevealKey value={apiKey} />
              </div>
              <div className="mt-3">
                <RegenerateKey id={session.id} />
              </div>
            </section>

            <section>
              <p className="kicker">Try it</p>
              <div className="mt-4 space-y-4">
                {examples.map((e) => (
                  <CodeBlock key={e.label} label={e.label} lang="bash" code={e.code} />
                ))}
              </div>
              <p className="mt-4 text-[0.85rem] text-[var(--muted-foreground)]">
                Set <code className="code">KEY</code> to the value above.{" "}
                <Link href="/docs" className="underline underline-offset-2">
                  Full guide →
                </Link>
              </p>
            </section>
          </div>

          <aside className="space-y-8">
            <LiveSession id={session.id} initialStatus={session.status} />

            <section className="card p-5">
              <p className="kicker">Configuration</p>
              <dl className="mt-4 space-y-3 text-[0.85rem]">
                {[
                  ["Account protection", session.accountProtection ? "on — 1 send / 5s" : "off"],
                  ["Message logging", session.logMessages ? "on" : "off"],
                  ["Webhook", session.webhookEnabled ? (session.webhookUrl ?? "on") : "off"],
                  ["Proxy", session.proxyUrl ?? "none"],
                  [
                    "Last event",
                    session.lastEventAt
                      ? session.lastEventAt.toISOString().slice(0, 16).replace("T", " ")
                      : "never",
                  ],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between gap-4">
                    <dt className="text-[var(--muted-foreground)]">{k}</dt>
                    <dd className="code truncate text-right">{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
      </aside>
    </div>
  );
}
