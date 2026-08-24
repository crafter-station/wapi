"use client";

import { useState } from "react";
import { CopyButton } from "./copy-button";

/**
 * Tabbed code samples.
 *
 * Tabs rather than stacked blocks because most readers want exactly one language, and scrolling
 * past three they do not use is friction.
 *
 * `html` is pre-highlighted at build time by `Code`; `code` is the plain source, kept because
 * that is what belongs on the clipboard — a reader pasting a snippet should get the snippet,
 * not markup.
 */
export function CodeTabs({
  tabs,
}: {
  tabs: { label: string; code: string; html: string }[];
}) {
  const [active, setActive] = useState(0);
  const current = tabs[active]!;

  return (
    <div className="not-prose terminal my-5">
      <div className="terminal-bar scroll-slim gap-1 overflow-x-auto">
        {tabs.map((t, i) => (
          <button
            key={t.label}
            type="button"
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
        <CopyButton text={current.code} className="ml-auto" />
      </div>
      <div className="terminal-body">
        {/* Highlighted at build time from source we author; no user input reaches this. */}
        <div className="code" dangerouslySetInnerHTML={{ __html: current.html }} />
      </div>
    </div>
  );
}
