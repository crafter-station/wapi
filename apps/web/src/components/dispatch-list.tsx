"use client";

import { useEffect, useState } from "react";
import type { WebhookDispatch } from "@wapi/db";

/**
 * Webhook deliveries, updating as they happen.
 *
 * Watching a delivery land is the single most convincing thing this dashboard does — it turns
 * "did my integration work?" from a guess into an observation. That is why this is live rather
 * than a table with a refresh button.
 *
 * The SSE announcement is content-free: it carries status and timing only, so the payload never
 * crosses a fan-out channel. When an event arrives for a row already on screen the row is
 * updated in place — a retry is the same delivery, not a new one — and a genuinely new event is
 * prepended with what the announcement knows. The full record, payload included, arrives on the
 * next render.
 */
type Live = Pick<
  WebhookDispatch,
  "jobId" | "event" | "status" | "statusCode" | "attempts" | "durationMs" | "lastError"
> & { lastAttemptAt: string | Date; payload?: string | null };

const TONE: Record<string, string> = {
  delivered: "var(--foreground)",
  failed: "var(--destructive)",
  retrying: "var(--muted-foreground)",
};

const time = (v: string | Date) =>
  new Date(v).toISOString().slice(11, 19);

export function DispatchList({
  sessionId,
  initial,
}: {
  sessionId: number;
  initial: WebhookDispatch[];
}) {
  const [rows, setRows] = useState<Live[]>(initial as unknown as Live[]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/sessions/${sessionId}/events`);
    es.addEventListener("dispatch", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as Live & { jobId: string };
        setRows((prev) => {
          const at = prev.findIndex((r) => r.jobId === d.jobId);
          if (at === -1) return [{ ...d, lastAttemptAt: new Date() }, ...prev].slice(0, 50);
          const next = [...prev];
          next[at] = { ...next[at]!, ...d, lastAttemptAt: new Date() };
          return next;
        });
      } catch {
        /* a malformed frame must not break the list */
      }
    });
    return () => es.close();
  }, [sessionId]);

  return (
    <div className="mt-4 grid gap-px overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--border)]">
      {rows.map((d) => (
        <div key={d.jobId} className="bg-[var(--card)]">
          <button
            type="button"
            onClick={() => setOpen(open === d.jobId ? null : d.jobId)}
            className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left text-[0.875rem] hover:bg-[var(--muted)]"
          >
            <span className="code min-w-[180px] flex-1 truncate">{d.event}</span>
            <span style={{ color: TONE[d.status] ?? "inherit" }}>
              {d.status}
              {d.statusCode ? ` · ${d.statusCode}` : ""}
            </span>
            {d.attempts > 1 ? (
              <span className="text-[var(--muted-foreground)]">{d.attempts} attempts</span>
            ) : null}
            <span className="text-[var(--muted-foreground)]">
              {d.durationMs != null ? `${d.durationMs}ms` : ""}
            </span>
            <span className="code text-[0.8rem] text-[var(--muted-foreground)]">
              {time(d.lastAttemptAt)}
            </span>
          </button>
          {open === d.jobId ? (
            <div className="border-t border-[var(--border)] px-4 py-3">
              {d.lastError ? (
                <p className="mb-2 text-[0.85rem] text-[var(--destructive)]">{d.lastError}</p>
              ) : null}
              {d.payload ? (
                <pre className="code max-h-[320px] overflow-auto whitespace-pre-wrap text-[0.75rem]">
                  {(() => {
                    try {
                      return JSON.stringify(JSON.parse(d.payload), null, 2);
                    } catch {
                      return d.payload;
                    }
                  })()}
                </pre>
              ) : (
                /* Payloads are nulled after 7 days; the delivery record itself lives 30. */
                <p className="text-[0.85rem] text-[var(--muted-foreground)]">
                  Payload no longer retained.
                </p>
              )}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
