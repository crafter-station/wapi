import Link from "next/link";
import { notFound } from "next/navigation";
import { AppNav } from "@/components/app-nav";
import { SandboxBadge } from "@/components/sandbox-badge";
import { SessionTabs } from "@/components/session-tabs";
import { connectAction, deleteSessionAction, disconnectAction, restartAction } from "@/lib/actions";
import { getSession } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * Session workspace shell.
 *
 * The header and lifecycle controls live here rather than on each page so they stay put while
 * you move between tabs — a Connect button that disappears when you open Settings would be an
 * odd thing to explain.
 *
 * `getSession` is account-scoped, so this layout is also the ownership check for every page
 * beneath it: a session belonging to someone else 404s before any child renders.
 */
export default async function SessionLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSession(Number(id));
  if (!session) notFound();

  const connected = session.status === "connected";

  return (
    <>
      <AppNav active="sessions" />
      <main className="shell py-12">
        <Link
          href="/sessions"
          className="text-[0.85rem] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          ← Sessions
        </Link>

        <header className="mt-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="title flex flex-wrap items-center gap-3">
              {session.name}
              {session.sandbox ? <SandboxBadge className="!text-[0.65rem]" /> : null}
            </h1>
            <p className="code mt-2 text-[var(--muted-foreground)]">
              {session.phoneNumber} · session #{session.id}
              {session.lid ? ` · ${session.lid}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            {/*
              Connect and Disconnect are the same slot: offering both at once invites the
              question of what pressing the inapplicable one does. Restart only appears once
              there is a live socket to restart.
            */}
            {connected ? (
              <form action={disconnectAction}>
                <input type="hidden" name="id" value={session.id} />
                <button className="btn btn-ghost">Disconnect</button>
              </form>
            ) : (
              <form action={connectAction}>
                <input type="hidden" name="id" value={session.id} />
                <button className="btn btn-primary">Connect</button>
              </form>
            )}
            {connected ? (
              <form action={restartAction}>
                <input type="hidden" name="id" value={session.id} />
                <button className="btn btn-ghost">Restart</button>
              </form>
            ) : null}
            <form action={deleteSessionAction}>
              <input type="hidden" name="id" value={session.id} />
              <button className="btn btn-ghost text-[var(--destructive)]">Delete</button>
            </form>
          </div>
        </header>

        <SessionTabs id={session.id} sandbox={session.sandbox} />

        {children}
      </main>
    </>
  );
}
