"use client";

import { useState } from "react";

/**
 * Copy-to-clipboard control.
 *
 * One implementation shared by the tabbed and single code blocks, so a reader never finds a
 * snippet they cannot copy — that inconsistency is precisely what this replaced.
 *
 * `navigator.clipboard` is unavailable on insecure origins and can be refused by permissions
 * policy, so the failure is surfaced rather than swallowed: a button that silently does nothing
 * is worse than one that admits it.
 */
export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  return (
    <button
      type="button"
      aria-label="Copy code"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("copied");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 1600);
      }}
      className={
        "rounded px-2 py-1 whitespace-nowrap transition-colors hover:text-[var(--foreground)] " +
        (className ?? "")
      }
    >
      {state === "copied" ? "copied" : state === "failed" ? "press ⌘C" : "copy"}
    </button>
  );
}
