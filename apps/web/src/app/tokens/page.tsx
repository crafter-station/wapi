import Link from "next/link";
import { listTokens } from "@/lib/data";
import { revokeTokenAction } from "@/lib/actions";
import { TokenForm } from "@/components/token-form";
import { AppNav } from "@/components/app-nav";

export const dynamic = "force-dynamic";

export default async function TokensPage() {
  const tokens = await listTokens();

  return (
    <>
      <AppNav active="tokens" />
      <main className="shell space-y-8 py-12">
      <div>
        <p className="kicker">Personal access tokens</p>
        <h1 className="title mt-3">Account-level <em>credentials.</em></h1>
        <p className="mt-4 max-w-[620px] text-[0.9rem] leading-[1.7] text-[var(--muted-foreground)]">
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
      </main>
    </>
  );
}
