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
export function AppNav({ active }: { active?: "sessions" | "tokens" | "docs" }) {
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
      <div className="shell flex items-center gap-8 py-4">
        <Link href="/" className="wordmark">
          wapi<span>.</span>
        </Link>
        <div className="flex items-center gap-6 text-[0.875rem]">
          {link("/sessions", "sessions", "Sessions")}
          {link("/tokens", "tokens", "Tokens")}
          {link("/docs", "docs", "Docs")}
          <a
            href={`${API}/docs`}
            className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            API reference
          </a>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <GithubLink />
          <UserButton />
        </div>
      </div>
    </nav>
  );
}
