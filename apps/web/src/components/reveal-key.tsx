"use client";

import { useState } from "react";

/**
 * A secret that is masked until asked for.
 *
 * The key has to be readable — their API returns it on every GET, which is why it is stored
 * reversibly at all. But rendering it unmasked means it is on screen during every screen share
 * and in every screenshot of this page, so revealing is a deliberate act.
 */
export function RevealKey({ value }: { value: string | null }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!value) {
    return (
      <p className="text-[0.875rem] text-[var(--muted-foreground)]">
        Unavailable — regenerate the key to issue a new one.
      </p>
    );
  }

  const masked = `${value.slice(0, 6)}${"•".repeat(28)}${value.slice(-4)}`;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <code className="code min-w-0 flex-1 truncate rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] px-3 py-2">
        {shown ? value : masked}
      </code>
      <button onClick={() => setShown((s) => !s)} className="btn btn-ghost py-2 text-[0.8rem]">
        {shown ? "Hide" : "Reveal"}
      </button>
      <button
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
        className="btn btn-ghost py-2 text-[0.8rem]"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
