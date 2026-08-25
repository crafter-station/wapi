"use client";

import { useActionState, useState } from "react";
import { regenerateKeyAction, type RegenerateState } from "@/lib/actions";
import { CopyButton } from "./copy-button";

/**
 * Issue a new session API key.
 *
 * Two-step by design. This is not undoable and it breaks every deployed client using the old
 * key the instant it runs, so the consequence is stated before the button that causes it
 * exists — not in a toast afterwards.
 *
 * The new key is shown once here because the page behind it is already rendering the stored
 * value; there is no secret being newly exposed, only a fresh one surfaced where the old one
 * was.
 */
export function RegenerateKey({ id }: { id: number }) {
  const [armed, setArmed] = useState(false);
  const [state, action, pending] = useActionState<RegenerateState, FormData>(
    regenerateKeyAction,
    null,
  );

  if (state?.key) {
    return (
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] p-4">
        <p className="text-[0.85rem] font-[580]">New key issued. The previous one no longer works.</p>
        <div className="mt-2 flex items-center gap-2">
          <code className="code min-w-0 flex-1 truncate">{state.key}</code>
          <CopyButton text={state.key} />
        </div>
      </div>
    );
  }

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        className="text-[0.85rem] text-[var(--muted-foreground)] underline underline-offset-2 hover:text-[var(--foreground)]"
      >
        Regenerate key
      </button>
    );
  }

  return (
    <form action={action} className="rounded-[var(--radius)] border border-[var(--destructive)] p-4">
      <input type="hidden" name="id" value={id} />
      <p className="text-[0.85rem] leading-[1.7]">
        <strong>This takes effect immediately.</strong> Anything using the current key — a
        deployed app, a script, a webhook consumer — starts getting <code className="code">401</code>{" "}
        until you update it.
      </p>
      {state?.error ? (
        <p className="mt-2 text-[0.85rem] text-[var(--destructive)]">{state.error}</p>
      ) : null}
      <div className="mt-3 flex gap-2">
        <button className="btn btn-ghost text-[var(--destructive)]" disabled={pending}>
          {pending ? "Regenerating…" : "Yes, regenerate"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setArmed(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
