import Link from "next/link";
import { AppNav } from "@/components/app-nav";
import { Code, CodeBlock } from "@/components/code";

export const dynamic = "force-static";

const API = "https://api.wapi.crafter.run";
const REPO = "https://github.com/crafter-station/wapi";
const SKILL = `${REPO}/tree/main/.claude/skills/wapi-nextjs`;

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
              ["skill", "Agent skill"],
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
            <Code
              tabs={[
                {
                  label: "curl", lang: "bash",
                  code: `curl -X POST ${API}/api/send-message \\
  -H "Authorization: Bearer $KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"to":"+51999888777","text":"hello from wapi"}'`,
                },
                {
                  label: "JavaScript", lang: "javascript",
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
                  label: "Python", lang: "python",
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
            <Code
              tabs={[
                {
                  label: "Send response",
                  lang: "json",
                  code: `{ "success": true,
  "data": { "msgId": 100024, "jid": "+51999888777", "status": "in_progress" } }`,
                },
                {
                  label: "Message info",
                  lang: "json",
                  code: `{
  "success": true,
  "data": {
    "remoteJid": "51999888777@s.whatsapp.net",
    "id": "3EB0A9C1...",
    "msgId": 100024,
    "key": { "id": "3EB0A9C1...", "fromMe": true,
             "remoteJid": "51999888777@s.whatsapp.net" },
    "message": { "conversation": "hello from wapi" },
    "messageTimestamp": "1787537909",
    "status": 2
  }
}`,
                },
              ]}
            />
            <p className="mt-5">
              Two field types on <code>/info</code> catch people out, and both follow WhatsApp&rsquo;s
              own record rather than ours. <code>messageTimestamp</code> is a{" "}
              <strong>string</strong> — it is a protobuf 64-bit integer, which JSON cannot hold as
              a number — and <code>status</code> is WhatsApp&rsquo;s numeric acknowledgement
              (<code>0</code> error, <code>1</code> pending, <code>2</code> sent, <code>3</code>{" "}
              delivered, <code>4</code> read), not the word you get back from a send.
            </p>
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
            <Code
              tabs={[
                { label: "Text", lang: "json", code: `{ "to": "+51999888777", "text": "hello" }` },
                {
                  label: "Image", lang: "json",
                  code: `{ "to": "+51999888777",
  "imageUrl": "https://example.com/photo.jpg",
  "text": "optional caption" }`,
                },
                {
                  label: "Document", lang: "json",
                  code: `{ "to": "+51999888777",
  "documentUrl": "https://example.com/invoice.pdf",
  "fileName": "invoice.pdf" }`,
                },
                {
                  label: "Location", lang: "json",
                  code: `{ "to": "+51999888777",
  "location": { "latitude": -12.0464, "longitude": -77.0428, "name": "Lima" } }`,
                },
                {
                  label: "Poll", lang: "json",
                  code: `{ "to": "+51999888777",
  "poll": { "question": "Ship on Friday?",
            "options": ["Yes", "No", "Needs discussion"],
            "multiSelect": false } }`,
                },
                {
                  label: "Contact", lang: "json",
                  code: `{ "to": "+51999888777",
  "contact": { "name": "Ada Lovelace", "phone": "+51999111222" } }`,
                },
                {
                  label: "Reply", lang: "json",
                  code: `{ "to": "+51999888777",
  "text": "answering your question",
  "replyTo": 100024 }`,
                },
                {
                  label: "React", lang: "bash",
                  code: `# A wapi extension: WasenderAPI reports reactions over webhooks but
# has no endpoint to send one. Their SDK never calls this.
#
# Addressed by WhatsApp key, not msgId — you mostly react to messages
# someone else sent, and those have no msgId. Take the key from the
# webhook payload.
curl -X POST ${API}/api/messages/react \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"key":{"id":"3EB0...","remoteJid":"51999888777@s.whatsapp.net",
              "fromMe":false},
       "emoji":"👍"}'

# An empty emoji removes the reaction. That is WhatsApp's convention,
# not a separate endpoint.`,
                },
                {
                  label: "Mentions", lang: "json",
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
            <Code
              tabs={[
                {
                  label: "Upload (binary)", lang: "bash",
                  code: `curl -X POST ${API}/api/upload \\
  -H "Authorization: Bearer $KEY" \\
  -H 'Content-Type: image/png' \\
  --data-binary @photo.png

# → { "success": true, "publicUrl": "${API}/media/<uuid>/photo.png" }`,
                },
                {
                  label: "Upload (base64)", lang: "bash",
                  code: `curl -X POST ${API}/api/upload \\
  -H "Authorization: Bearer $KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"base64":"iVBORw0KGgo...","mimetype":"image/png","fileName":"photo.png"}'`,
                },
                {
                  label: "Decrypt inbound", lang: "bash",
                  code: `# Inbound media arrives ENCRYPTED. Pass the message node from the
# webhook straight through and get back a URL valid for one hour.
curl -X POST ${API}/api/decrypt-media \\
  -H "Authorization: Bearer $KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"data":{"messages":{"message":{"imageMessage":{ ...from webhook... }}}}}'

# → { "success": true,
#     "publicUrl": "${API}/media/<uuid>.jpg?expires=1750000000&sig=<hmac>" }`,
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
            <Code
              tabs={[
                {
                  label: "List groups", lang: "bash",
                  code: `curl ${API}/api/groups -H "Authorization: Bearer $KEY"

# → { "success": true,
#     "data": [ { "jid": "120363...@g.us", "id": "120363...@g.us",
#                 "name": "Team", "subject": "Team", "imgUrl": null,
#                 "owner": "...", "creation": 1678886400,
#                 "desc": null, "participants": [ ... ] } ] }
#
# jid and name are the documented keys; id and subject carry the same
# values and are kept so existing callers keep working.`,
                },
                {
                  label: "Group detail", lang: "bash",
                  code: `curl ${API}/api/groups/120363...@g.us/metadata \\
  -H "Authorization: Bearer $KEY"

curl ${API}/api/groups/120363...@g.us/participants \\
  -H "Authorization: Bearer $KEY"

# A participant carries both documented forms at once:
# { "jid": "51999888777@s.whatsapp.net", "isAdmin": true,
#   "isSuperAdmin": false, "id": "51999888777@s.whatsapp.net",
#   "admin": "admin" }`,
                },
                {
                  label: "Contacts", lang: "bash",
                  code: `curl ${API}/api/contacts -H "Authorization: Bearer $KEY"

# → { "success": true,
#     "data": [ { "jid": "51999888777@s.whatsapp.net",
#                 "id": "51999888777@s.whatsapp.net",
#                 "name": "Ada", "notify": "Ada L.",
#                 "verifiedName": null, "imgUrl": null, "status": null,
#                 "phoneNumber": "+51999888777", "lid": "4627...@lid" } ] }

# One contact. imgUrl and status are always null in a list: a picture and an
# "about" string are per-contact fetches, so a list call never makes N of them.
curl ${API}/api/contacts/+51999888777 -H "Authorization: Bearer $KEY"

# Is a number on WhatsApp?
curl ${API}/api/on-whatsapp/+51999888777 -H "Authorization: Bearer $KEY"`,
                },
                {
                  label: "Paginated", lang: "bash",
                  code: `# Both /api/contacts and /api/groups take ?paginated=true, which changes
# the response shape: data becomes { items, pagination } instead of an array.
curl "${API}/api/contacts?paginated=true&page=1&limit=20" \
  -H "Authorization: Bearer $KEY"

# → { "success": true,
#     "data": { "items": [ ... ],
#               "pagination": { "page": 1, "limit": 20,
#                               "total": 38, "totalPages": 2 } } }

# limit defaults to 20 and caps at 500. totalPages is ceil(total / limit),
# and page echoes what you asked for.`,
                },
                {
                  label: "LID lookup", lang: "bash",
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
              Set a webhook URL on the session and we POST events to it, retrying up to five
              times with exponential backoff. Configure it under{" "}
              <Link href="/sessions">Settings</Link> on the session, or with the API call below.
            </p>
            <p className="mt-4">
              <strong>Two signature schemes.</strong> By default{" "}
              <code>X-Webhook-Signature</code> carries the webhook secret <em>itself</em>, and you
              compare strings — that is WasenderAPI&rsquo;s scheme, reproduced so their clients
              work unchanged. Turning on <strong>HMAC</strong> in Settings switches the header to
              HMAC-SHA256 over the raw request body, which is what you should prefer: it proves
              the payload was not altered, and it never puts the secret on the wire.
            </p>
            <Code
              tabs={[
                {
                  label: "Configure", lang: "bash",
                  code: `curl -X PUT ${API}/api/whatsapp-sessions/1 \\
  -H "Authorization: Bearer $PAT" \\
  -H 'Content-Type: application/json' \\
  -d '{"webhook_url":"https://your.app/hook",
       "webhook_enabled":true,
       "webhook_events":["messages.received","session.status"]}'

# An empty webhook_events array means "send everything".
#
# HMAC signing is a wapi addition rather than part of the cloned
# interface, so it is not a field on this endpoint. Turn it on under
# Settings for the session in the dashboard.`,
                },
                {
                  label: "Receive", lang: "javascript",
                  code: `// Accepts either scheme, so enabling HMAC later needs no redeploy.
// Read the RAW body: express.json() consumes the stream, leaving
// nothing to compute a hash over.
app.post("/hook", express.raw({ type: "*/*" }), (req, res) => {
  const secret = process.env.WAPI_WEBHOOK_SECRET;
  const sent = req.headers["x-webhook-signature"];
  const hmac = crypto.createHmac("sha256", secret)
                     .update(req.body).digest("hex");

  if (sent !== secret && sent !== hmac) return res.sendStatus(401);

  const { event, data } = JSON.parse(req.body);
  if (event === "messages.received") {
    console.log(data.key.remoteJid, data.message?.conversation);
  }

  // Acknowledge fast; do the work asynchronously.
  res.json({ received: true });
});`,
                },
                {
                  label: "Payload", lang: "json",
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
              <CodeBlock
                label="Route-level — uses error"
                lang="json"
                code={`{ "success": false,
  "error": "Your Whatsapp Session is not connected please connect your session first." }`}
              />
              <CodeBlock
                label="Validation & auth — uses message"
                lang="json"
                code={`{ "success": false,
  "message": "Validation failed",
  "errors": { "to": ["The to field is required."] } }`}
              />
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
            <Code
              tabs={[
                {
                  label: "Node", lang: "javascript",
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

          {/* --------------------------------------------------------- skill */}
          <S id="skill" kicker="Agent skill" title={<>Let your agent <em>wire it up.</em></>}>
            <p>
              If you build with Claude Code, Cursor, Copilot or another agent, install the{" "}
              <a href={SKILL}>
                <code>wapi-nextjs</code> skill
              </a>
              . It carries a server-only client, a webhook route handler, and notes on the parts
              of this API that are not guessable from the endpoint names — so your agent writes
              the integration correctly the first time instead of inferring it.
            </p>
            <Code
              tabs={[
                {
                  label: "Install", lang: "bash",
                  code: `npx skills@latest add crafter-station/wapi --skill=wapi-nextjs

# Installs to .agents/skills/ and symlinks .claude/skills/ for Claude Code.
# Works with Cursor, Codex, Gemini CLI, Copilot and others from the same copy.`,
                },
                {
                  label: "Then ask", lang: "bash",
                  code: `# In your Next.js project, ask your agent:

"Add wapi to this app so it can send a WhatsApp message
 when an order ships, and receive replies via webhook."

# The skill supplies the client, the route handler, and the
# gotchas -- five success envelopes, two failure envelopes,
# and why a failed send must not simply be retried.`,
                },
              ]}
            />
            <p className="mt-5">
              It is four files in this repository under{" "}
              <a href={SKILL}>
                <code>.claude/skills/wapi-nextjs</code>
              </a>
              , so you can read the whole thing before installing it — worth doing with any skill,
              since they run with your agent&rsquo;s permissions. Prefer to copy by hand? The
              client and the webhook handler are directly usable on their own.
            </p>
          </S>
        </div>
      </main>
    </>
  );
}
