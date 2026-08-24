"use client";

import { useState } from "react";

/**
 * Tabbed code samples.
 *
 * Documentation examples are only useful if they are copyable, so every block has a copy
 * button. Tabs rather than stacked blocks because most readers want exactly one language and
 * scrolling past four they do not use is friction.
 *
 * `html` is pre-highlighted at build time by `Code`; `code` is the plain source, kept because
 * that is what belongs on the clipboard.
 */
export function CodeTabs({
  tabs,
}: {
  tabs: { label: string; code: string; html: string }[];
}) {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const current = tabs[active]!;

  return (
    <div className="not-prose terminal my-5">
      <div className="terminal-bar gap-1 overflow-x-auto">
        {tabs.map((t, i) => (
          <button
            key={t.label}
            onClick={() => setActive(i)}
            className={
              "rounded px-2 py-1 whitespace-nowrap transition-colors " +
              (i === active
                ? "bg-[var(--muted)] text-[var(--foreground)]"
                : "hover:text-[var(--foreground)]")
            }
          >
            {t.label}
          </button>
        ))}
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(current.code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }}
          className="ml-auto rounded px-2 py-1 whitespace-nowrap hover:text-[var(--foreground)]"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <div className="terminal-body">
        {/* Highlighted at build time from source we author; no user input reaches this. */}
        <div className="code" dangerouslySetInnerHTML={{ __html: current.html }} />
      </div>
    </div>
  );
}
