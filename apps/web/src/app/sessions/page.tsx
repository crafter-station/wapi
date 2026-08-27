import Link from "next/link";
import { latestDoctorRuns, listSessions } from "@/lib/data";
import { createSandboxAction, createSessionAction } from "@/lib/actions";
import { SandboxBadge } from "@/components/sandbox-badge";
import { StatusBadge } from "@/components/status-badge";
import { AppNav } from "@/components/app-nav";

export const dynamic = "force-dynamic";

export default async function SessionsPage() {
  const [sessions, health] = await Promise.all([listSessions(), latestDoctorRuns()]);

  /**
   * Health is the last doctor verdict, not a live probe.
   *
   * Probing on render would send a WhatsApp message every time someone opened this page, which
   * is exactly the unattended traffic the doctor is designed not to produce. Showing a stored
   * verdict with its age is honest: it says what was true when someone last checked.
   */
  const verdictLabel: Record<string, string> = {
    degraded: "checks skipped",
    failed: "unhealthy",
    ok: "healthy",
  };

  return (
    <>
      <AppNav active="sessions" />
      <main className="shell py-12">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="kicker">Sessions</p>
            <h1 className="title mt-3">
              Linked <em>numbers.</em>
            </h1>
          </div>
          <p className="max-w-[380px] text-[0.875rem] leading-[1.7] text-[var(--muted-foreground)]">
            One session per phone number. Each carries its own API key, webhook configuration
            and optional proxy.
          </p>
        </header>

        {sessions.length === 0 ? (
          <div className="card mt-10 p-10 text-center">
            <p className="text-[1.05rem] font-[560]">No sessions yet</p>
            <p className="mx-auto mt-2 max-w-[420px] text-[0.9rem] leading-[1.7] text-[var(--muted-foreground)]">
              Create one below, then scan its QR code with WhatsApp to link a number.
            </p>
          </div>
        ) : (
          <ul className="mt-10 grid gap-px overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2">
            {sessions.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/sessions/${s.id}`}
                  className="block bg-[var(--card)] p-6 transition-colors hover:bg-[var(--muted)]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 truncate text-[1.05rem] font-[580] tracking-[-0.02em]">
                        <span className="truncate">{s.name}</span>
                        {s.sandbox ? <SandboxBadge /> : null}
                      </p>
                      <p className="code mt-1 truncate text-[var(--muted-foreground)]">
                        {s.phoneNumber}
                      </p>
                    </div>
                    <StatusBadge status={s.status} />
                  </div>
                  <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-[var(--border)] pt-4 text-[0.7rem]">
                    {[
                      ["Session", `#${s.id}`],
                      ["Webhook", s.webhookEnabled ? "on" : "off"],
                      [
                        "Health",
                        health.has(s.id)
                          ? (verdictLabel[health.get(s.id)!.verdict] ?? health.get(s.id)!.verdict)
                          : "not checked",
                      ],
                    ].map(([k, v]) => (
                      <div key={k}>
                        <dt className="text-[var(--muted-foreground)]">{k}</dt>
                        <dd className="code mt-0.5 text-[var(--foreground)]">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <section className="mt-14">
          <p className="kicker">New session</p>
          <form action={createSessionAction} className="card mt-4 p-7">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-[0.8rem] font-[560]">Name</span>
                <input
                  name="name"
                  placeholder="Support line"
                  required
                  className="mt-1.5 w-full rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 py-2 text-[0.9rem] outline-none focus:border-[var(--ring)]"
                />
              </label>
              <label className="block">
                <span className="text-[0.8rem] font-[560]">Phone number</span>
                <input
                  name="phone_number"
                  placeholder="+51999888777"
                  required
                  className="code mt-1.5 w-full rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 py-2 text-[0.9rem] outline-none focus:border-[var(--ring)]"
                />
              </label>
            </div>

            <label className="mt-5 flex items-start gap-3 rounded-[var(--radius)] bg-[var(--muted)] p-4">
              <input type="checkbox" name="account_protection" className="mt-1" />
              <span className="text-[0.85rem] leading-[1.65] text-[var(--muted-foreground)]">
                <strong className="font-[580] text-[var(--foreground)]">Account protection</strong>{" "}
                — paces sends to one every five seconds. Slower, but it is the phone number this
                protects, and a banned number cannot be redeployed.
              </span>
            </label>

            <button type="submit" className="btn btn-primary mt-6">
              Create session
            </button>
          </form>

          {/*
            A separate form rather than a checkbox on the one above: a sandbox session takes no
            phone number, because one is derived. Sharing a form would mean disabling half its
            own fields the moment the box is ticked.
          */}
          <form
            action={createSandboxAction}
            className="card mt-4 flex flex-wrap items-end gap-4 p-7"
          >
            <div className="min-w-0 flex-1">
              <p className="text-[0.9rem] font-[580]">Or create a sandbox session</p>
              <p className="mt-1.5 max-w-[560px] text-[0.85rem] leading-[1.65] text-[var(--muted-foreground)]">
                A fake number on a fake WhatsApp — no QR to scan, nothing to ban. It pairs itself,
                comes with a small directory, and can be made to receive messages so you can watch
                your webhook handler work. Nothing sent from it reaches anyone.
              </p>
              <input
                name="name"
                placeholder="Sandbox"
                className="mt-3 w-full max-w-[280px] rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 py-2 text-[0.9rem] outline-none focus:border-[var(--ring)]"
              />
            </div>
            <button type="submit" className="btn btn-ghost">
              Create sandbox
            </button>
          </form>
        </section>
      </main>
    </>
  );
}
