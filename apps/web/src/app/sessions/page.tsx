import Link from "next/link";
import { listSessions } from "@/lib/data";
import { createSessionAction } from "@/lib/actions";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";

export default async function SessionsPage() {
  const sessions = await listSessions();

  return (
    <div className="space-y-10">
      <div className="flex items-end justify-between">
        <div>
          <p className="eyebrow">Sessions</p>
          <h1 className="mt-1 text-2xl">Linked numbers</h1>
        </div>
        <Link href="/tokens" className="text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
          Access tokens →
        </Link>
      </div>

      {sessions.length === 0 ? (
        <p className="text-sm text-[var(--muted-foreground)]">
          No sessions yet. Create one below, then scan its QR with WhatsApp.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-4 bg-[var(--card)] p-4">
              <div className="min-w-0">
                <Link href={`/sessions/${s.id}`} className="font-medium hover:underline">
                  {s.name}
                </Link>
                <p className="truncate font-mono text-xs text-[var(--muted-foreground)]">
                  {s.phoneNumber} · id {s.id}
                  {s.lid ? ` · ${s.lid}` : ""}
                </p>
              </div>
              <StatusBadge status={s.status} />
            </li>
          ))}
        </ul>
      )}

      <form
        action={createSessionAction}
        className="space-y-4 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-5"
      >
        <p className="eyebrow">New session</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <input
            name="name"
            placeholder="Name"
            required
            className="rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 py-2 text-sm"
          />
          <input
            name="phone_number"
            placeholder="+51922471582"
            required
            className="rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 py-2 font-mono text-sm"
          />
        </div>
        <label className="flex items-start gap-2 text-sm text-[var(--muted-foreground)]">
          <input type="checkbox" name="account_protection" className="mt-1" />
          <span>
            Account protection — paces sends to one every five seconds. Slower, but it is the
            phone number this protects, and a banned number cannot be redeployed.
          </span>
        </label>
        <button
          type="submit"
          className="rounded-[var(--radius)] bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)]"
        >
          Create
        </button>
      </form>
    </div>
  );
}
