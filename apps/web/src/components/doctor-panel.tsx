"use client";

import { useActionState } from "react";
import type { DoctorCheck } from "@wapi/db";
import { runDoctorAction, type DoctorState } from "@/lib/actions";

const MARK: Record<DoctorCheck["state"], { colour: string; glyph: string }> = {
  fail: { colour: "var(--destructive)", glyph: "✕" },
  pass: { colour: "var(--foreground)", glyph: "✓" },
  // Deliberately not a warning colour: skipped means "not applicable", not "nearly broken".
  skipped: { colour: "var(--muted-foreground)", glyph: "–" },
};

const VERDICT: Record<string, string> = {
  degraded: "Working, with checks that did not apply",
  failed: "Something is broken",
  ok: "Healthy",
};

function Checks({ checks }: { checks: DoctorCheck[] }) {
  return (
    <ul className="mt-4 grid gap-px overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--border)]">
      {checks.map((c) => (
        <li key={c.name} className="flex items-start gap-3 bg-[var(--card)] px-4 py-3">
          <span aria-hidden className="mt-0.5 w-4 shrink-0" style={{ color: MARK[c.state].colour }}>
            {MARK[c.state].glyph}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[0.9rem] font-[520]">{c.name}</span>
            <span className="block text-[0.85rem] leading-[1.6] text-[var(--muted-foreground)]">
              {c.detail}
            </span>
          </span>
          {c.ms != null ? (
            <span className="code shrink-0 text-[0.8rem] text-[var(--muted-foreground)]">
              {c.ms}ms
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The connection doctor.
 *
 * Six checks over the public edge, because "does this work end to end" includes the proxy and
 * the certificate. The run is deliberately manual — see `runDoctorAction`.
 */
export function DoctorPanel({
  id,
  previous,
}: {
  id: number;
  previous: { checks: DoctorCheck[]; ranAt: string; verdict: string } | null;
}) {
  const [state, action, pending] = useActionState<DoctorState, FormData>(runDoctorAction, null);
  const shown = state?.result ?? previous;

  return (
    <div className="mt-8 max-w-[720px]">
      <p className="text-[0.875rem] leading-[1.7] text-[var(--muted-foreground)]">
        Runs six checks against the public API — the same URL your integration uses, so TLS and
        the proxy are part of what gets tested. The only message it sends goes to this
        session&rsquo;s own number.
      </p>

      <form action={action} className="mt-5 flex items-center gap-4">
        <input type="hidden" name="id" value={id} />
        <button className="btn btn-primary" disabled={pending}>
          {pending ? "Running…" : shown ? "Run again" : "Run check"}
        </button>
        {previous && !state?.result ? (
          <span className="text-[0.85rem] text-[var(--muted-foreground)]">
            Last run {new Date(previous.ranAt).toISOString().slice(0, 16).replace("T", " ")}
          </span>
        ) : null}
      </form>

      {state?.error ? (
        <p className="mt-4 text-[0.85rem] text-[var(--destructive)]">{state.error}</p>
      ) : null}

      {shown ? (
        <div className="mt-6">
          <p className="font-[580]">{VERDICT[shown.verdict] ?? shown.verdict}</p>
          <Checks checks={shown.checks} />
        </div>
      ) : null}
    </div>
  );
}
