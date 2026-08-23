"use client";

import { useActionState } from "react";
import { createTokenAction, type TokenState } from "@/lib/actions";

/**
 * Minting a PAT is the one action whose result must reach the page: the plaintext exists for
 * exactly one render. Only its hash is stored, deliberately unlike the session API key, which
 * their API returns on every GET and therefore has to stay recoverable.
 */
export function TokenForm() {
  const [state, action, pending] = useActionState<TokenState, FormData>(createTokenAction, null);

  return (
    <div className="space-y-4">
      <form action={action} className="flex gap-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-5">
        <input
          name="name"
          placeholder="Token name"
          className="flex-1 rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 py-2 text-sm"
        />
        <button
          disabled={pending}
          className="rounded-[var(--radius)] bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create"}
        </button>
      </form>

      {state?.error && <p className="text-sm text-[var(--destructive)]">{state.error}</p>}

      {state?.token && (
        <div className="space-y-2 rounded-[var(--radius)] border border-[var(--foreground)] p-4">
          <p className="eyebrow">Copy this now — it is not shown again</p>
          <code className="block overflow-x-auto font-mono text-xs">{state.token}</code>
        </div>
      )}
    </div>
  );
}
