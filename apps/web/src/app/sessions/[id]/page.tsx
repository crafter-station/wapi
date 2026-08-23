import Link from "next/link";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/data";
import { connectAction, deleteSessionAction } from "@/lib/actions";
import { LiveSession } from "@/components/live-session";
import { decryptSecret } from "@wapi/core";

export const dynamic = "force-dynamic";

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(Number(id));
  if (!session) notFound();

  // The one place the session key is decrypted. Stored AES-256-GCM rather than in the clear,
  // because their API returns it on every GET so hash-only storage is not an option.
  let apiKey: string | null = null;
  try {
    apiKey = session.apiKeyEncrypted ? decryptSecret(session.apiKeyEncrypted) : null;
  } catch {
    apiKey = null;
  }

  return (
    <div className="space-y-8">
      <div>
        <Link href="/sessions" className="text-sm text-[var(--muted-foreground)] hover:underline">
          ← Sessions
        </Link>
        <h1 className="mt-2 text-2xl">{session.name}</h1>
        <p className="font-mono text-xs text-[var(--muted-foreground)]">
          {session.phoneNumber} · id {session.id}
          {session.lid ? ` · ${session.lid}` : ""}
        </p>
      </div>

      <LiveSession id={session.id} initialStatus={session.status} />

      <div className="flex gap-3">
        <form action={connectAction}>
          <input type="hidden" name="id" value={session.id} />
          <button className="rounded-[var(--radius)] bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)]">
            Connect
          </button>
        </form>
        <form action={deleteSessionAction}>
          <input type="hidden" name="id" value={session.id} />
          <button className="rounded-[var(--radius)] border border-[var(--destructive)] px-4 py-2 text-sm text-[var(--destructive)]">
            Delete
          </button>
        </form>
      </div>

      <section className="space-y-3">
        <p className="eyebrow">Session API key</p>
        <p className="text-sm text-[var(--muted-foreground)]">
          Use this for messaging, contacts and groups. It identifies the session, which is why
          those endpoints carry no session id. Account-level actions need a Personal Access
          Token instead.
        </p>
        <code className="block overflow-x-auto rounded-[var(--radius)] bg-[var(--muted)] p-3 font-mono text-xs">
          {apiKey ?? "unavailable"}
        </code>
        <details className="text-sm">
          <summary className="cursor-pointer text-[var(--muted-foreground)]">Send a message</summary>
          <pre className="mt-2 overflow-x-auto rounded-[var(--radius)] bg-[var(--muted)] p-3 font-mono text-xs">
{`curl -X POST https://api.wapi.crafter.run/api/send-message \
  -H "Authorization: Bearer ${apiKey ?? "<key>"}" \
  -H 'Content-Type: application/json' \
  -d '{"to":"${session.phoneNumber}","text":"hello"}'`}
          </pre>
        </details>
      </section>
    </div>
  );
}
