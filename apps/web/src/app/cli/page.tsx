import { AppNav } from "@/components/app-nav";
import { approveCliAction } from "@/lib/actions";
import { findCliRequest } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * Approving a CLI login.
 *
 * The CLI cannot sign in to Clerk, so it prints a code and waits. This page is the other half:
 * a browser that *is* signed in, where a human confirms that the terminal asking is theirs.
 *
 * The approval is the authorisation. A pending request belongs to nobody until somebody claims
 * it here, which is why this page is not account-scoped — there is no account on the request to
 * scope it to until the moment a signed-in person presses the button.
 */
export default async function CliPage({
  searchParams,
}: {
  searchParams: Promise<{ approved?: string; code?: string; expired?: string }>;
}) {
  const { approved, code, expired } = await searchParams;
  const request = code ? await findCliRequest(code) : null;

  return (
    <>
      <AppNav />
      <main className="shell py-12">
        <p className="kicker">Command line</p>
        <h1 className="title mt-3">
          Authorise a <em>terminal.</em>
        </h1>

        {approved ? (
          <Panel title="Approved.">
            The terminal that showed you this code is now signed in as your account. It may take a
            second or two to notice. You can close this tab — and revoke that machine any time from{" "}
            <a className="underline" href="/tokens">
              tokens
            </a>
            , which is where it appears.
          </Panel>
        ) : !code ? (
          <Panel title="Run the command first.">
            Start with <code className="code">wapi login</code>. It prints a code and opens this
            page for you; if it could not open a browser, the code it printed goes in the URL as{" "}
            <code className="code">?code=…</code>.
          </Panel>
        ) : !request ? (
          <Panel title={expired ? "That code expired while you were here." : "No such code."}>
            Codes last ten minutes and can only be used once. Run{" "}
            <code className="code">wapi login</code> again for a fresh one — nothing was
            authorised, so there is nothing to undo.
          </Panel>
        ) : (
          <section className="mt-8 max-w-[620px] rounded-[var(--radius)] border border-[var(--border)] p-6">
            <p className="text-[0.875rem] leading-[1.7] text-[var(--muted-foreground)]">
              A terminal is asking to sign in as you. Check that the code below is the one it
              printed — if it is not, close this tab and approve nothing.
            </p>

            <p className="code mt-5 text-[1.6rem] tracking-[0.2em]">{code.toUpperCase()}</p>

            <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[0.85rem]">
              <dt className="text-[var(--muted-foreground)]">Machine</dt>
              <dd className="code">{request.hostname ?? "unknown"}</dd>
              <dt className="text-[var(--muted-foreground)]">Requested</dt>
              <dd>{request.createdAt.toLocaleTimeString()}</dd>
              <dt className="text-[var(--muted-foreground)]">Expires</dt>
              <dd>{request.expiresAt.toLocaleTimeString()}</dd>
            </dl>

            <p className="mt-5 text-[0.85rem] leading-[1.7] text-[var(--muted-foreground)]">
              Approving mints a Personal Access Token named{" "}
              <code className="code">cli@{request.hostname ?? "unknown"}</code> with full access to
              this account. It behaves like any other token: it is listed on the tokens page, and
              revoking it there signs that machine out.
            </p>

            <form action={approveCliAction} className="mt-6">
              <input type="hidden" name="code" value={code} />
              <button className="btn btn-primary">Authorise this terminal</button>
            </form>
          </section>
        )}
      </main>
    </>
  );
}

function Panel({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section className="mt-8 max-w-[620px] rounded-[var(--radius)] border border-dashed border-[var(--border)] p-6">
      <p className="font-[580]">{title}</p>
      <p className="mt-2 text-[0.875rem] leading-[1.7] text-[var(--muted-foreground)]">{children}</p>
    </section>
  );
}
