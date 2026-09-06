import { notFound } from "next/navigation";
import { Empty } from "@/components/pager";
import { SandboxComposer } from "@/components/sandbox-composer";
import { type SandboxMessage, sandboxThread } from "@/lib/data";
import { getSession, sessionApiKey } from "@/lib/data";
import { ApiError, contactsPage } from "@/lib/wapi-api";

export const dynamic = "force-dynamic";

/**
 * The fake WhatsApp, as a screen.
 *
 * Everything else in the dashboard shows a session's *metadata* — status, counts, logs. This
 * shows the thing itself: who the fake number knows, and what has been said. A sandbox whose only
 * evidence is a row in a table is hard to believe in, and being able to watch a message arrive is
 * most of what makes it feel real.
 *
 * Only reachable for sandbox sessions. A real session 404s here rather than rendering an empty
 * chat, because a page that looks like your WhatsApp history but is always blank is worse than no
 * page at all.
 */
/**
 * What actually goes inside a bubble.
 *
 * This used to print `[image]`. That told somebody debugging an image webhook that *an* image had
 * arrived but not which one — the least useful half of the answer, and the sandbox exists to
 * answer exactly that kind of question. The engine now records the URL a media send pointed at,
 * so the bubble can show the thing instead of naming its category.
 *
 * The URL is whatever the caller sent, so this renders it the way a chat client renders a remote
 * image: no referrer, and lazily, because a long thread should not fetch every attachment at once.
 */
function BubbleContent({ m }: { m: SandboxMessage }) {
  const caption = m.text ? (
    <span className="mt-1.5 block">{m.text}</span>
  ) : null;

  if (m.mediaUrl) {
    switch (m.kind) {
      case "image":
        return (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt={m.text ?? "Image sent in this sandbox"}
              className="block max-h-[260px] w-auto max-w-full rounded-[calc(var(--radius)-4px)]"
              loading="lazy"
              referrerPolicy="no-referrer"
              src={m.mediaUrl}
            />
            {caption}
          </>
        );
      case "sticker":
        return (
          // Smaller and unframed: a sticker is not a photo, and sizing it like one reads wrong.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            alt="Sticker sent in this sandbox"
            className="block h-[120px] w-[120px] object-contain"
            loading="lazy"
            referrerPolicy="no-referrer"
            src={m.mediaUrl}
          />
        );
      case "video":
        return (
          <>
            <video
              className="block max-h-[260px] w-auto max-w-full rounded-[calc(var(--radius)-4px)]"
              controls
              // Metadata only: a thread of videos should not pull every file to show a first frame.
              preload="metadata"
              src={m.mediaUrl}
            />
            {caption}
          </>
        );
      case "audio":
        return <audio className="block max-w-full" controls preload="metadata" src={m.mediaUrl} />;
      case "document":
        return (
          <>
            <a
              className="flex items-center gap-2 underline underline-offset-2"
              href={m.mediaUrl}
              rel="noreferrer"
              target="_blank"
            >
              {/* A document has no thumbnail, so its name is the whole bubble. */}
              <span aria-hidden>▤</span>
              <span>{m.fileName ?? "Document"}</span>
            </a>
            {caption}
          </>
        );
      default:
        break;
    }
  }

  /*
   * Everything else: a location, a contact card, a poll. A kind with no text of its own still
   * needs to occupy the bubble — otherwise it renders as an empty box and looks like a bug.
   */
  return <>{m.text ?? <span className="opacity-70">[{m.kind}]</span>}</>;
}

export default async function SandboxPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sessionId = Number(id);

  const session = await getSession(sessionId);
  if (!session?.sandbox) notFound();

  const [thread, contacts] = await Promise.all([
    sandboxThread(sessionId),
    // Through our own API, like the contacts tab: if `/api/contacts` regresses this page
    // regresses with it, which is how a fidelity bug reaches us before it reaches anyone else.
    sessionApiKey(sessionId).then((key) =>
      key
        ? contactsPage(key, 1, 50)
            .then((r) => r.items)
            .catch((err: unknown) => (err instanceof ApiError ? [] : []))
        : [],
    ),
  ]);

  if (session.status !== "connected") {
    return (
      <Empty
        title="Not connected yet"
        hint="A sandbox pairs itself a few seconds after you press Connect — no phone, no QR to scan. Once it does, its contacts and conversation appear here."
      />
    );
  }

  /**
   * Who each line is with.
   *
   * The thread is one list across every counterparty, so without this a message to Ada and a
   * message to Grace are indistinguishable — which would make the whole view quietly misleading
   * rather than merely simple. Falls back to the raw jid, since a send may address a number that
   * is not in the derived directory at all.
   */
  const nameFor = new Map(contacts.map((c) => [c.jid, c.name ?? c.notify ?? c.jid]));

  return (
    <div className="mt-8 grid gap-6 lg:grid-cols-[260px_1fr]">
      <aside>
        <h2 className="text-[0.8rem] font-[580] uppercase tracking-wide text-[var(--muted-foreground)]">
          Contacts
        </h2>
        <p className="mt-2 text-[0.8rem] leading-[1.6] text-[var(--muted-foreground)]">
          Invented for this session and always the same. Nothing here is a real person.
        </p>
        <ul className="mt-4 space-y-1">
          {contacts.map((c) => (
            <li
              key={c.jid}
              className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-2"
            >
              <p className="text-[0.875rem] font-[520]">{c.name ?? c.notify ?? "Unknown"}</p>
              <p className="code mt-0.5 text-[0.75rem] text-[var(--muted-foreground)]">
                {c.phoneNumber ?? c.jid}
              </p>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex min-h-[420px] flex-col rounded-[var(--radius)] border border-[var(--border)]">
        <div className="scroll-slim flex-1 space-y-3 overflow-y-auto p-5">
          {thread.length === 0 ? (
            <p className="mt-10 text-center text-[0.875rem] text-[var(--muted-foreground)]">
              Nothing yet. Send a message with the API, or write one below as if a contact had
              sent it.
            </p>
          ) : (
            thread.map((m) => (
              <div key={m.id} className={m.fromMe ? "flex justify-end" : "flex justify-start"}>
                <div
                  className={
                    "max-w-[75%] rounded-[var(--radius)] px-3.5 py-2 text-[0.875rem] leading-[1.6] " +
                    (m.fromMe
                      ? "bg-[var(--foreground)] text-[var(--background)]"
                      : "border border-[var(--border)] bg-[var(--muted)]")
                  }
                >
                  <BubbleContent m={m} />
                  <span
                    className={
                      "mt-1 block text-[0.7rem] " +
                      (m.fromMe ? "opacity-60" : "text-[var(--muted-foreground)]")
                    }
                  >
                    {m.fromMe ? "to" : "from"} {nameFor.get(m.jid) ?? m.jid} ·{" "}
                    {new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        <SandboxComposer
          id={sessionId}
          contacts={contacts.map((c) => ({
            jid: c.jid,
            label: c.name ?? c.notify ?? c.jid,
          }))}
        />
      </section>
    </div>
  );
}
