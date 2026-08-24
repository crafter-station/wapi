import Link from "next/link";
import { AppNav } from "@/components/app-nav";
import { CodeTabs } from "@/components/code-tabs";

export const dynamic = "force-static";

const API = "https://api.wapi.crafter.run";

/**
 * Getting started.
 *
 * This is the narrative half of the documentation; the exhaustive per-endpoint reference is
 * generated from the OpenAPI document and lives at {API}/docs. Splitting them that way means
 * the reference can never drift from the implementation, while this page can explain the
 * things a generated reference cannot: which credential to use, why send-message is one
 * endpoint, and what the failure envelopes mean.
 */

const S = ({ id, kicker, title, children }: { id: string; kicker: string; title: React.ReactNode; children: React.ReactNode }) => (
  <section id={id} className="scroll-mt-24 border-t border-[var(--border)] py-14 first:border-0">
    <p className="kicker">{kicker}</p>
    <h2 className="title mt-4 !text-[clamp(1.8rem,3vw,2.6rem)]">{title}</h2>
    <div className="prose mt-6 max-w-[720px]">{children}</div>
  </section>
);

export default function DocsPage() {
  return (
    <>
      <AppNav active="docs" />
      <main className="shell grid gap-14 py-12 lg:grid-cols-[200px_minmax(0,1fr)]">
        {/* ------------------------------------------------------------- toc */}
        <aside className="hidden lg:block">
          <nav className="sticky top-10 space-y-2 text-[0.85rem]">
            <p className="kicker mb-3">On this page</p>
            {[
              ["start", "Quick start"],
              ["auth", "Two credentials"],
              ["sending", "Sending messages"],
              ["media", "Media"],
              ["groups", "Groups & contacts"],
              ["webhooks", "Webhooks"],
              ["errors", "Errors"],
              ["sdk", "Using their SDK"],
            ].map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                className="block text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                {label}
              </a>
            ))}
            <div className="!mt-6 border-t border-[var(--border)] pt-4">
              <a href={`${API}/docs`} className="block hover:underline">
                Full API reference →
              </a>
            </div>
          </nav>
        </aside>

        <div>
          <header>
            <p className="kicker">Documentation</p>
            <h1 className="display mt-5 !text-[clamp(2.4rem,5vw,3.8rem)]">
              Get started in <em>two minutes.</em>
            </h1>
            <p className="lede mt-6 max-w-[640px]">
              wapi speaks the WasenderAPI interface. If you have written against that, everything
              here will look familiar — change the base URL and your existing client works.
            </p>
          </header>

          {/* --------------------------------------------------------- start */}
          <S id="start" kicker="Quick start" title={<>From zero to <em>a sent message.</em></>}>
            <h3>1. Create a session and link a number</h3>
            <p>
              Open the <Link href="/sessions">dashboard</Link>, create a session, press{" "}
              <strong>Connect</strong>, and scan the QR with WhatsApp → Settings → Linked
              devices. The code refreshes about every twenty seconds and updates live.
            </p>
            <p>
              Once it shows <strong>connected</strong>, copy the session API key from that page.
            </p>

            <h3>2. Send something</h3>
            <CodeTabs
              tabs={[
                {
                  label: "curl",
                  code: `curl -X POST ${API}/api/send-message \\
  -H "Authorization: Bearer $KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"to":"+51999888777","text":"hello from wapi"}'`,
                },
                {
                  label: "JavaScript",
                  code: `const res = await fetch("${API}/api/send-message", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.WAPI_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ to: "+51999888777", text: "hello from wapi" }),
});

const { data } = await res.json();
console.log(data.msgId); // 100024`,
                },
                {
                  label: "Python",
                  code: `import os, requests

r = requests.post(
    "${API}/api/send-message",
    headers={"Authorization": f"Bearer {os.environ['WAPI_KEY']}"},
    json={"to": "+51999888777", "text": "hello from wapi"},
)
print(r.json()["data"]["msgId"])  # 100024`,
                },
              ]}
            />

            <h3>3. Read the response</h3>
            <p>
              Every send returns an integer <code>msgId</code> from our own sequence — not
              WhatsApp&rsquo;s message id. You use it for <code>replyTo</code> and for{" "}
              <code>GET /api/messages/{"{msgId}"}/info</code>, which returns both identifiers
              side by side.
            </p>
            <div className="code-block code">{`{ "success": true,
  "data": { "msgId": 100024, "jid": "+51999888777", "status": "in_progress" } }`}</div>
          </S>

          {/* ---------------------------------------------------------- auth */}
          <S id="auth" kicker="Authentication" title={<>Two keys, <em>two jobs.</em></>}>
            <p>
              Both go in the same header — <code>Authorization: Bearer &lt;token&gt;</code> — but
              they are not interchangeable, and using the wrong one returns <code>403</code>.
            </p>
            <div className="not-prose mt-5 grid gap-px overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2">
              <div className="bg-[var(--card)] p-5">
                <p className="font-[580]">Session API key</p>
                <p className="mt-2 text-[0.875rem] leading-[1.7] text-[var(--muted-foreground)]">
                  Messaging, contacts, groups, media. The key <em>is</em> the session selector,
                  which is why <code className="code">GET /api/status</code> takes no session id.
                  Found on the session page.
                </p>
              </div>
              <div className="bg-[var(--card)] p-5">
                <p className="font-[580]">Personal Access Token</p>
                <p className="mt-2 text-[0.875rem] leading-[1.7] text-[var(--muted-foreground)]">
                  Account-level: creating, updating and deleting sessions, setting a proxy,
                  regenerating keys. Mint one under{" "}
                  <Link href="/tokens" className="underline underline-offset-2">
                    Tokens
                  </Link>
                  .
                </p>
              </div>
            </div>
          </S>

          {/* ------------------------------------------------------- sending */}
          <S id="sending" kicker="Messaging" title={<>One endpoint, <em>every message type.</em></>}>
            <p>
              <code>POST /api/send-message</code> handles everything. Which field you set decides
              what gets sent — there is no separate route for images or groups. Setting two
              content fields is an error rather than a silent preference.
            </p>
            <CodeTabs
              tabs={[
                { label: "Text", code: `{ "to": "+51999888777", "text": "hello" }` },
                {
                  label: "Image",
                  code: `{ "to": "+51999888777",
  "imageUrl": "https://example.com/photo.jpg",
  "text": "optional caption" }`,
                },
                {
                  label: "Document",
                  code: `{ "to": "+51999888777",
  "documentUrl": "https://example.com/invoice.pdf",
  "fileName": "invoice.pdf" }`,
                },
                {
                  label: "Location",
                  code: `{ "to": "+51999888777",
  "location": { "latitude": -12.0464, "longitude": -77.0428, "name": "Lima" } }`,
                },
                {
                  label: "Poll",
                  code: `{ "to": "+51999888777",
  "poll": { "question": "Ship on Friday?",
            "options": ["Yes", "No", "Needs discussion"],
            "multiSelect": false } }`,
                },
                {
                  label: "Contact",
                  code: `{ "to": "+51999888777",
  "contact": { "name": "Ada Lovelace", "phone": "+51999111222" } }`,
                },
                {
                  label: "Reply",
                  code: `{ "to": "+51999888777",
  "text": "answering your question",
  "replyTo": 100024 }`,
                },
                {
                  label: "Mentions",
                  code: `{ "to": "120363000000000000@g.us",
  "text": "@51999888777 can you confirm?",
  "mentions": ["+51999888777"] }`,
                },
              ]}
            />
            <p className="mt-5">
              <strong>Recipients</strong> can be a phone number in any readable form
              (<code>+51999888777</code>, <code>51999888777</code>), a WhatsApp JID, a group JID
              ending <code>@g.us</code>, or a channel JID ending <code>@newsletter</code>.
              Sending to a group is the same call with a group JID.
            </p>
          </S>

          {/* --------------------------------------------------------- media */}
          <S id="media" kicker="Media" title={<>Upload, send, <em>and decrypt.</em></>}>
            <p>
              Media is sent by URL: <code>imageUrl</code> and friends are fetched server-side. If
              you do not already host the file, upload it first and use the URL you get back —
              it is permanent, so it still resolves when the message is sent later.
            </p>
            <CodeTabs
              tabs={[
                {
                  label: "Upload (binary)",
                  code: `curl -X POST ${API}/api/upload \\
  -H "Authorization: Bearer $KEY" \\
  -H 'Content-Type: image/png' \\
  --data-binary @photo.png

# → { "success": true, "publicUrl": "${API}/media/<uuid>/photo.png" }`,
                },
                {
                  label: "Upload (base64)",
                  code: `curl -X POST ${API}/api/upload \\
  -H "Authorization: Bearer $KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"base64":"iVBORw0KGgo...","mimetype":"image/png","fileName":"photo.png"}'`,
                },
                {
                  label: "Decrypt inbound",
                  code: `# Inbound media arrives ENCRYPTED. Pass the message node from the
# webhook straight through and get back a URL valid for one hour.
curl -X POST ${API}/api/decrypt-media \\
  -H "Authorization: Bearer $KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"data":{"messages":{"message":{"imageMessage":{ ...from webhook... }}}}}'

# → { "success": true, "publicUrl": "https://.../image.jpg?X-Amz-Expires=3600" }`,
                },
              ]}
            />
            <p className="mt-5">
              <strong>Inbound media is encrypted.</strong> WhatsApp hands out a CDN link plus a{" "}
              <code>mediaKey</code>; the bytes are useless without decryption. Take the{" "}
              <code>imageMessage</code> (or video, audio, document, sticker) node from the webhook
              payload and post it to <code>/api/decrypt-media</code>. Uploads cap at 16 MB.
            </p>
          </S>

          {/* -------------------------------------------------------- groups */}
          <S id="groups" kicker="Groups & contacts" title={<>Reading the <em>address book.</em></>}>
            <CodeTabs
              tabs={[
                {
                  label: "List groups",
                  code: `curl ${API}/api/groups -H "Authorization: Bearer $KEY"

# → [{ "id": "120363...@g.us", "subject": "Team", "participants": [...] }]`,
                },
                {
                  label: "Group detail",
                  code: `curl ${API}/api/groups/120363...@g.us/metadata \\
  -H "Authorization: Bearer $KEY"

curl ${API}/api/groups/120363...@g.us/participants \\
  -H "Authorization: Bearer $KEY"`,
                },
                {
                  label: "Contacts",
                  code: `curl ${API}/api/contacts -H "Authorization: Bearer $KEY"

# Is a number on WhatsApp?
curl ${API}/api/on-whatsapp/+51999888777 -H "Authorization: Bearer $KEY"`,
                },
                {
                  label: "LID lookup",
                  code: `# WhatsApp now addresses many identities by LID rather than phone number.
curl ${API}/api/lid-from-pn/+51999888777 -H "Authorization: Bearer $KEY"
curl ${API}/api/pn-from-lid/46274715893950@lid -H "Authorization: Bearer $KEY"`,
                },
              ]}
            />
            <p className="mt-5">
              <strong>On LIDs.</strong> Group participants and inbound senders often appear as{" "}
              <code>…@lid</code> rather than a phone number. That is WhatsApp&rsquo;s newer
              identity format, not an error. <code>pn-from-lid</code> resolves it where a mapping
              has been observed; a miss there is legitimate, because resolution only works in one
              direction reliably.
            </p>
          </S>

          {/* ------------------------------------------------------ webhooks */}
          <S id="webhooks" kicker="Webhooks" title={<>Receiving <em>as it happens.</em></>}>
            <p>
              Set a webhook URL on the session and we POST events to it, with retries and
              exponential backoff. Verify the <code>X-Webhook-Signature</code> header against your
              session&rsquo;s webhook secret.
            </p>
            <CodeTabs
              tabs={[
                {
                  label: "Configure",
                  code: `curl -X PUT ${API}/api/whatsapp-sessions/1 \\
  -H "Authorization: Bearer $PAT" \\
  -H 'Content-Type: application/json' \\
  -d '{"webhook_url":"https://your.app/hook",
       "webhook_enabled":true,
       "webhook_events":["messages.received","session.status"]}'

# An empty webhook_events array means "send everything".`,
                },
                {
                  label: "Receive",
                  code: `app.post("/hook", express.json(), (req, res) => {
  if (req.headers["x-webhook-signature"] !== process.env.WAPI_WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }

  const { event, data } = req.body;
  if (event === "messages.received") {
    console.log(data.key.remoteJid, data.message?.conversation);
  }

  // Acknowledge fast; do the work asynchronously.
  res.json({ received: true });
});`,
                },
                {
                  label: "Payload",
                  code: `{
  "event": "messages.received",
  "sessionId": 1,
  "timestamp": 1787537909,
  "data": {
    "key": { "id": "3EB0...", "remoteJid": "46274715893950@lid",
             "remoteJidAlt": "51999888777@s.whatsapp.net", "fromMe": false },
    "message": { "conversation": "hello" },
    "pushName": "Ada"
  }
}`,
                },
              ]}
            />
            <p className="mt-5">
              <strong>Useful events.</strong> <code>messages.received</code> for inbound only,{" "}
              <code>messages.upsert</code> for everything including your own sends,{" "}
              <code>message.sent</code>, <code>messages.update</code> for delivery and read
              receipts, <code>session.status</code> for connection changes, and{" "}
              <code>qrcode.updated</code> during pairing. There are twenty-two in total.
            </p>
            <p>
              The three <code>messages-personal</code>, <code>messages-group</code> and{" "}
              <code>messages-newsletter</code> variants are filtered views of{" "}
              <code>messages.received</code>, so subscribe to those if you only care about one
              chat kind.
            </p>
          </S>

          {/* -------------------------------------------------------- errors */}
          <S id="errors" kicker="Errors" title={<>Two shapes, <em>on purpose.</em></>}>
            <p>
              Failures come back in one of two forms, and which one tells you where the failure
              happened. This mirrors the interface being cloned rather than being tidied up.
            </p>
            <div className="not-prose mt-5 space-y-3">
              <div className="terminal">
                <div className="terminal-bar">Route-level — uses `error`</div>
                <div className="terminal-body">
                  <pre className="code">{`{ "success": false,
  "error": "Your Whatsapp Session is not connected please connect your session first." }`}</pre>
                </div>
              </div>
              <div className="terminal">
                <div className="terminal-bar">Validation & auth — uses `message`</div>
                <div className="terminal-body">
                  <pre className="code">{`{ "success": false,
  "message": "Validation failed",
  "errors": { "to": ["The to field is required."] } }`}</pre>
                </div>
              </div>
            </div>
            <p className="mt-5">
              Rate-limit headers — <code>X-RateLimit-Limit</code>,{" "}
              <code>X-RateLimit-Remaining</code>, <code>X-RateLimit-Reset</code> — are on every
              response. A <code>429</code> carries <code>retry_after</code> in seconds.
            </p>
            <p>
              <strong>Common statuses.</strong> <code>401</code> missing or invalid key,{" "}
              <code>403</code> wrong credential type, <code>409</code> session not connected,{" "}
              <code>422</code> validation, <code>503</code> the WhatsApp service is briefly
              unavailable — retry.
            </p>
          </S>

          {/* ----------------------------------------------------------- sdk */}
          <S id="sdk" kicker="Compatibility" title={<>Their SDK, <em>unmodified.</em></>}>
            <p>
              wapi implements the WasenderAPI interface closely enough that their published npm
              client works against it with no changes — this is covered by an automated test
              suite, not just an aspiration.
            </p>
            <CodeTabs
              tabs={[
                {
                  label: "Node",
                  code: `import { createWasender } from "wasenderapi";

// Third argument is the base URL. That is the whole migration.
const wa = createWasender(
  process.env.WAPI_KEY,
  undefined,
  "${API}/api",
);

await wa.sendText({ to: "+51999888777", text: "hello" });
const groups = await wa.getGroups();`,
                },
              ]}
            />
            <p className="mt-5">
              The per-endpoint reference, with every field and response shape, is generated from
              the same contract the server validates against:{" "}
              <a href={`${API}/docs`}>{API.replace("https://", "")}/docs</a>. The raw spec is at{" "}
              <a href={`${API}/openapi.json`}>/openapi.json</a>.
            </p>
          </S>
        </div>
      </main>
    </>
  );
}
