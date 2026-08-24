import Link from "next/link";
import { listSessions } from "@/lib/data";
import { createSessionAction } from "@/lib/actions";
import { StatusBadge } from "@/components/status-badge";
import { AppNav } from "@/components/app-nav";

export const dynamic = "force-dynamic";

export default async function SessionsPage() {
  const sessions = await listSessions();

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
                      <p className="truncate text-[1.05rem] font-[580] tracking-[-0.02em]">
                        {s.name}
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
                      ["Protection", s.accountProtection ? "on" : "off"],
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
        </section>
      </main>
    </>
  );
}
