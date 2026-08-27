"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Workspace navigation for one session.
 *
 * Only tabs that exist are listed — a nav that links to a page you haven't built yet teaches
 * people the product is broken. New sections get added here as they land.
 *
 * Active state comes from the pathname rather than a prop, so a page cannot render the wrong
 * tab as selected by forgetting to pass one.
 */
const TABS = [
  { href: "", label: "Overview" },
  /** Sandbox only — the page 404s for a real session, so the tab must not offer it one. */
  { href: "/sandbox", label: "Sandbox", sandboxOnly: true },
  { href: "/messages", label: "Messages" },
  { href: "/contacts", label: "Contacts" },
  { href: "/groups", label: "Groups" },
  { href: "/webhooks", label: "Webhooks" },
  { href: "/doctor", label: "Doctor" },
  { href: "/settings", label: "Settings" },
] as const;

export function SessionTabs({ id, sandbox = false }: { id: number; sandbox?: boolean }) {
  const pathname = usePathname();
  const base = `/sessions/${id}`;

  return (
    <nav className="scroll-slim mt-8 flex gap-1 overflow-x-auto border-b border-[var(--border)]">
      {TABS.filter((t) => sandbox || !("sandboxOnly" in t && t.sandboxOnly)).map((t) => {
        const href = `${base}${t.href}`;
        // Exact match for the index, prefix for the rest, so /settings does not light up
        // Overview as well.
        const active = t.href === "" ? pathname === base : pathname.startsWith(href);
        return (
          <Link
            key={t.label}
            href={href}
            className={
              "-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-[0.875rem] font-[520] transition-colors " +
              (active
                ? "border-[var(--foreground)] text-[var(--foreground)]"
                : "border-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)]")
            }
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
