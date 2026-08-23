import { SignedIn, SignedOut } from "@clerk/nextjs";
import Link from "next/link";

export default function Home() {
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <p className="eyebrow">WhatsApp REST API</p>
        <h1 className="text-4xl leading-tight">
          A WhatsApp API you run yourself.
        </h1>
        <p className="max-w-xl text-[var(--muted-foreground)]">
          Link a number, get an API key, send messages over HTTP. Wire-compatible with
          WasenderAPI, so existing clients work by changing one base URL.
        </p>
      </div>

      <div className="flex gap-3">
        <SignedIn>
          <Link
            href="/sessions"
            className="rounded-[var(--radius)] bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)]"
          >
            Open dashboard
          </Link>
        </SignedIn>
        <SignedOut>
          <span className="text-sm text-[var(--muted-foreground)]">Sign in to get started.</span>
        </SignedOut>
        <a
          href="https://api.wapi.crafter.run/docs"
          className="rounded-[var(--radius)] border border-[var(--border)] px-4 py-2 text-sm"
        >
          API reference
        </a>
      </div>

      <dl className="grid gap-px overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--border)] sm:grid-cols-3">
        {[
          ["29", "REST endpoints"],
          ["22", "webhook events"],
          ["1h", "signed media URLs"],
        ].map(([n, label]) => (
          <div key={label} className="bg-[var(--card)] p-5">
            <dt className="font-mono text-2xl">{n}</dt>
            <dd className="mt-1 text-sm text-[var(--muted-foreground)]">{label}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
