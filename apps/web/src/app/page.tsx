import Link from "next/link";
import { SignedIn, SignedOut, SignInButton } from "@clerk/nextjs";
import { GithubLink } from "@/components/github-link";
import { DemoVideo } from "@/components/demo-video";
import { highlight } from "@/lib/highlight";

/**
 * Landing page.
 *
 * Structure and typographic devices follow normal.fast (see docs/design-reference.md): huge
 * tight headings with one Georgia-serif phrase each, an uppercase kicker per section, single
 * hairline rules between sections, and a product panel in the hero rather than a stock image.
 *
 * The content is ours. The hero panel is a terminal because this product's surface is a REST
 * API — showing a curl and its response is the honest equivalent of showing the app.
 */

const API = "https://api.wapi.crafter.run";

function Nav() {
  return (
    <nav className="rule">
      <div className="shell grid grid-cols-[1fr_auto_1fr] items-center gap-6 py-5">
        <Link href="/" className="wordmark w-fit">
          wapi<span>.</span>
        </Link>
        <div className="hidden items-center gap-8 text-[0.875rem] font-[520] md:flex">
          <a href="#how" className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
            How it works
          </a>
          <Link href="/docs" className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
            Docs
          </Link>
          <a
            href={`${API}/docs`}
            className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            API reference
          </a>
        </div>
        <div className="flex items-center justify-end gap-2">
          <GithubLink />
          <SignedIn>
            <Link href="/sessions" className="btn btn-primary">
              Dashboard
            </Link>
          </SignedIn>
          <SignedOut>
            <SignInButton mode="modal">
              <button className="btn btn-primary">Get started</button>
            </SignInButton>
          </SignedOut>
        </div>
      </div>
    </nav>
  );
}

/**
 * Hero panel.
 *
 * A terminal rather than a product screenshot, because this product's surface *is* a REST API:
 * the honest equivalent of showing the app is showing a request and its response. Highlighted
 * with the same build-time highlighter as the documentation, so the colours a reader sees here
 * are the colours they see in the guide.
 */
async function HeroTerminal() {
  const request = await highlight(
    `curl -X POST ${API}/api/send-message \
  -H "Authorization: Bearer $KEY" \
  -d '{"to":"+51999888777","text":"hello"}'`,
    "bash",
  );
  const response = await highlight(
    `{ "success": true,
  "data": { "msgId": 100024, "status": "in_progress" } }`,
    "json",
  );

  return (
    <div className="terminal w-full max-w-[560px]">
      <div className="terminal-bar">
        <span className="status status-connected">connected</span>
        <span className="ml-auto">POST /api/send-message</span>
      </div>
      <div className="terminal-body code">
        <div dangerouslySetInnerHTML={{ __html: request }} />
        <div className="my-3 border-t border-[var(--border)]" />
        <div dangerouslySetInnerHTML={{ __html: response }} />
      </div>
    </div>
  );
}

export default async function Home() {
  return (
    <>
      <Nav />

      {/* ------------------------------------------------------------------ hero */}
      <section className="hero-wash rule">
        <div className="shell grid items-center gap-14 py-20 lg:grid-cols-[1.05fr_1fr] lg:py-28">
          <div>
            <p className="kicker">Self-hosted WhatsApp API</p>
            <h1 className="display mt-6">
              WhatsApp over HTTP, <em>on your own box.</em>
            </h1>
            <p className="lede mt-7 max-w-[560px]">
              Link a number, get an API key, send and receive messages over a plain REST API.
              Wire-compatible with WasenderAPI, so existing clients work by changing one base
              URL.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-4">
              <SignedIn>
                <Link href="/sessions" className="btn btn-primary">
                  Open dashboard
                </Link>
              </SignedIn>
              <SignedOut>
                <SignInButton mode="modal">
                  <button className="btn btn-primary">Link a number</button>
                </SignInButton>
              </SignedOut>
              <Link href="/docs" className="btn btn-ghost">
                Read the guide
              </Link>
            </div>
            <p className="mt-7 text-[0.85rem] text-[var(--muted-foreground)]">
              Sessions live on your server. Credentials never leave your database.
            </p>
          </div>
          <div className="justify-self-center lg:justify-self-end">
            <HeroTerminal />
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- demo */}
      <section className="rule">
        <div className="shell grid items-center gap-12 py-20 lg:grid-cols-[1fr_1.15fr]">
          <div>
            <p className="kicker">Watch it</p>
            <h2 className="title mt-5">
              Your WhatsApp, <em>over HTTP.</em>
            </h2>
            <p className="lede mt-6">
              Seventy-eight seconds on a live account: messages, images, stickers, video and
              documents landing in a real thread with WhatsApp&rsquo;s own delivery ticks, then a
              group — and finally a sandbox, where a contact who does not exist fires a genuine
              webhook.
            </p>
            <p className="mt-5 text-[0.85rem] text-[var(--muted-foreground)]">
              Every command in it was recorded from the real CLI against a real session, and the
              number is masked at capture time — see{" "}
              <code className="code">ops/capture-demo.mjs</code>.
            </p>
          </div>
          <DemoVideo />
        </div>
      </section>

      {/* -------------------------------------------------------------- tension */}
      <section className="rule">
        <div className="shell grid gap-10 py-20 lg:grid-cols-[1.1fr_1fr]">
          <div>
            <p className="kicker">The gap</p>
            <h2 className="title mt-5">
              The official API cannot see <em>your groups.</em>
            </h2>
          </div>
          <div className="self-end">
            <p className="lede">
              Meta&rsquo;s Cloud API covers business messaging, not the conversations most
              teams actually run on: group chats, personal threads, the number people already
              message. Reaching those means driving a real WhatsApp client.
            </p>
            <p className="mt-5 font-[580]">
              wapi does that, and puts a stable REST surface in front of it.
            </p>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- what */}
      <section className="rule">
        <div className="shell py-20">
          <p className="kicker">What you get</p>
          <h2 className="title mt-5 max-w-[760px]">
            Twenty-nine endpoints, <em>one polymorphic send.</em>
          </h2>
          <div className="mt-12 grid gap-px overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--border)] md:grid-cols-3">
            {[
              {
                t: "Send anything",
                d: "Text, images, video, audio notes, documents, stickers, locations, contact cards and polls — all through one endpoint, discriminated by which field you set.",
              },
              {
                t: "Receive everything",
                d: "Twenty-two webhook events with retry and backoff, from messages and receipts to group participant changes and calls.",
              },
              {
                t: "Groups and contacts",
                d: "List groups, read metadata and participants, resolve LID identities, and send to a group with the same call you use for a person.",
              },
            ].map((c) => (
              <div key={c.t} className="bg-[var(--card)] p-7">
                <h3 className="text-[1.05rem] font-[600] tracking-[-0.02em]">{c.t}</h3>
                <p className="mt-3 text-[0.925rem] leading-[1.7] text-[var(--muted-foreground)]">
                  {c.d}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------------- how */}
      <section className="rule" id="how">
        <div className="shell py-20">
          <p className="kicker">How it works</p>
          <h2 className="title mt-5 max-w-[720px]">
            Three steps, <em>about two minutes.</em>
          </h2>
          <ol className="mt-12 grid gap-10 md:grid-cols-3">
            {[
              {
                n: "01",
                t: "Create a session",
                d: "One session per phone number. It gets its own API key, webhook config and optional proxy.",
              },
              {
                n: "02",
                t: "Scan the QR",
                d: "The code streams to your dashboard live. Credentials are stored encrypted, so a redeploy reconnects instead of asking you to scan again.",
              },
              {
                n: "03",
                t: "Call the API",
                d: "Send with the session key. Point a webhook URL at your app and inbound messages arrive as JSON.",
              },
            ].map((s) => (
              <li key={s.n}>
                <span className="code text-[var(--muted-foreground)]">{s.n}</span>
                <h3 className="mt-3 text-[1.15rem] font-[600] tracking-[-0.025em]">{s.t}</h3>
                <p className="mt-2 text-[0.925rem] leading-[1.7] text-[var(--muted-foreground)]">
                  {s.d}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ------------------------------------------------------------ honesty */}
      <section className="rule">
        <div className="shell grid gap-10 py-20 lg:grid-cols-[1fr_1.1fr]">
          <div>
            <p className="kicker">Worth knowing</p>
            <h2 className="title mt-5">
              It drives an <em>unofficial client.</em>
            </h2>
          </div>
          <div className="self-end">
            <p className="lede">
              wapi is built on Baileys, which speaks WhatsApp&rsquo;s protocol directly. That is
              what makes group access possible, and it is against WhatsApp&rsquo;s terms — numbers
              driven this way can be restricted or banned.
            </p>
            <p className="mt-5 text-[0.925rem] leading-[1.7] text-[var(--muted-foreground)]">
              There is per-session proxy support and an account-protection mode that paces sends
              to one every five seconds. Neither is a guarantee. Use a number you can afford to
              lose.
            </p>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- cta */}
      <section>
        <div className="shell py-24 text-center">
          <h2 className="title mx-auto max-w-[720px]">
            Link a number and <em>send your first message.</em>
          </h2>
          <div className="mt-9 flex justify-center gap-4">
            <SignedIn>
              <Link href="/sessions" className="btn btn-primary">
                Open dashboard
              </Link>
            </SignedIn>
            <SignedOut>
              <SignInButton mode="modal">
                <button className="btn btn-primary">Get started</button>
              </SignInButton>
            </SignedOut>
            <Link href="/docs" className="btn btn-ghost">
              Documentation
            </Link>
          </div>
        </div>
      </section>

      <footer className="rule border-t">
        <div className="shell flex flex-wrap items-center justify-between gap-4 py-8 text-[0.85rem] text-[var(--muted-foreground)]">
          <span className="wordmark text-[1rem]">
            wapi<span>.</span>
          </span>
          <div className="flex gap-6">
            <Link href="/docs" className="hover:text-[var(--foreground)]">
              Docs
            </Link>
            <a href={`${API}/docs`} className="hover:text-[var(--foreground)]">
              API reference
            </a>
            <a href={`${API}/openapi.json`} className="hover:text-[var(--foreground)]">
              OpenAPI
            </a>
            <GithubLink className="!p-0" />
          </div>
        </div>
      </footer>
    </>
  );
}
