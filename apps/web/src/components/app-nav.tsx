import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { GithubLink } from "./github-link";

const API = "https://api.wapi.crafter.run";

/**
 * Dashboard chrome.
 *
 * Deliberately quieter than the landing nav: inside the product the content is the point, so
 * this is one hairline rule, a wordmark, three destinations and the account button.
 */
export function AppNav({
  active,
}: {
  active?: "sessions" | "tokens" | "audit" | "docs";
}) {
  const link = (href: string, key: string, label: string) => (
    <Link
      key={key}
      href={href}
      className={
        active === key
          ? "text-[var(--foreground)] font-[560]"
          : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
      }
    >
      {label}
    </Link>
  );

  return (
    <nav className="rule">
      {/*
        The destinations scroll rather than wrap or overflow.

        This nav is on every dashboard page and used to be one non-wrapping row: at 390px its
        content measured 740px, so every page dragged sideways and the account button sat off
        screen. Found by the first browser test ever run against this app — typecheck and
        `next build` are both perfectly happy with a layout nobody can use on a phone.

        Scrolling, not wrapping, and the same `scroll-slim` treatment as the session tabs: the
        wordmark and the account button must stay put, and a nav that changes height as links
        wrap moves the page content under the reader's finger.
      */}
      <div className="shell flex items-center gap-4 py-4 sm:gap-8">
        <Link href="/" className="wordmark shrink-0">
          wapi<span>.</span>
        </Link>
        <div className="scroll-slim flex min-w-0 flex-1 items-center gap-5 overflow-x-auto whitespace-nowrap text-[0.875rem] sm:gap-6">
          {link("/sessions", "sessions", "Sessions")}
          {link("/tokens", "tokens", "Tokens")}
          {link("/audit", "audit", "Audit")}
          {link("/docs", "docs", "Docs")}
          <a
            href={`${API}/docs`}
            className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            API reference
          </a>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <GithubLink />
          <UserButton />
        </div>
      </div>
    </nav>
  );
}
