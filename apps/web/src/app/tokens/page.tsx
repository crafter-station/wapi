import Link from "next/link";
import { listTokens } from "@/lib/data";
import { revokeTokenAction } from "@/lib/actions";
import { TokenForm } from "@/components/token-form";

export const dynamic = "force-dynamic";

export default async function TokensPage() {
  const tokens = await listTokens();

  return (
    <div className="space-y-8">
      <div>
        <Link href="/sessions" className="text-sm text-[var(--muted-foreground)] hover:underline">
          ← Sessions
        </Link>
        <p className="eyebrow mt-2">Personal access tokens</p>
        <h1 className="mt-1 text-2xl">Account-level credentials</h1>
        <p className="mt-2 max-w-xl text-sm text-[var(--muted-foreground)]">
          Required for creating, updating and deleting sessions, and for setting a proxy. Only
          the hash is stored, so the value is shown once when created and never again.
        </p>
      </div>

      {tokens.length > 0 && (
        <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center justify-between bg-[var(--card)] p-4">
              <div>
                <p className="text-sm font-medium">{t.name}</p>
                <p className="font-mono text-xs text-[var(--muted-foreground)]">
                  created {t.createdAt.toISOString().slice(0, 10)} · last used{" "}
                  {t.lastUsedAt ? t.lastUsedAt.toISOString().slice(0, 16).replace("T", " ") : "never"}
                </p>
              </div>
              <form action={revokeTokenAction}>
                <input type="hidden" name="id" value={t.id} />
                <button className="text-sm text-[var(--destructive)]">Revoke</button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <TokenForm />
    </div>
  );
}
