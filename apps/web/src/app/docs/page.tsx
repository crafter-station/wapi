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
      {/*
        `minmax(0,1fr)` at every width, not only at `lg`.

        The two-column rule already had it; the single-column mobile track did not, and a grid
        item defaults to `min-width: auto` — so a wide `<pre>` set its own minimum and stretched
        the track past the viewport. The code block has `overflow-x: auto` and was ready to
        scroll inside itself; nothing was letting it. At 390px the page measured 740.
      */}
      <main className="shell grid grid-cols-[minmax(0,1fr)] gap-14 py-12 lg:grid-cols-[200px_minmax(0,1fr)]">
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
              ["session", "Session activity"],
              ["webhooks", "Webhooks"],
              ["sandbox", "Sandbox"],
              ["cli", "Command line"],
              ["errors", "Errors"],
              ["audit", "Audit log"],
              ["typescript", "TypeScript SDK"],
              ["python", "Python SDK"],
              ["go", "Go SDK"],
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
            <p>
              <strong>After sending</strong>, a message can be edited or deleted for everyone —{" "}
              <code>PUT /api/messages/{"{msgId}"}</code> and{" "}
              <code>DELETE /api/messages/{"{msgId}"}</code>, both addressed by the integer{" "}
              <code>msgId</code> a send returns. WhatsApp allows each only for a short window
              afterwards and gives no way to ask how long is left, so a refusal there is ordinary
              rather than a bug. An edit is a *new* message that supersedes the old one, so it
              comes back with a fresh key while keeping the original <code>msgId</code>.
            </p>
            <p>
              <code>POST /api/messages/{"{msgId}"}/resend</code> retries, and only for messages
              whose status is <code>failed</code>. That restriction is worth understanding rather
              than working around: a send that timed out is recorded as{" "}
              <code>in_progress</code> precisely because nobody knows whether it arrived, and
              resending one of those is how somebody receives the same message twice. It also
              needs <code>log_messages</code> to have been on, since otherwise there is no stored
              content to send again.
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
              <strong>Writing, not just reading.</strong> Groups can be left, renamed and
              re-described; participants promoted and demoted; invite links read, inspected before
              joining, and accepted. Contacts can be blocked, unblocked, given a saved name, and
              asked for a picture. Messages you sent can be edited or deleted for everyone, within
              the short window WhatsApp allows — there is no way to ask how long is left, so a
              refusal there is ordinary rather than a bug.
            </p>
            <p>
              Two of these disagree with each other, and wapi reproduces that rather than tidying
              it: <code>participants/add</code> and <code>/remove</code> return a per-participant
              array of <code>{"{status, jid, message}"}</code>, while{" "}
              <code>participants/update</code> — the promote/demote route — returns{" "}
              <code>{"{participants: [jid]}"}</code> with no status at all. On the latter, compare
              what you sent against what comes back to spot a partial failure. And{" "}
              <code>invite-link</code> puts <code>inviteLink</code> beside{" "}
              <code>success</code> rather than under <code>data</code> — the sixth success
              envelope.
            </p>
            <p>
              <strong>Group changes are the highest ban risk in the research</strong>, above send
              volume. Rehearse them on a sandbox, where the participants are invented.
            </p>
            <p className="mt-5">
              <strong>On LIDs.</strong> Group participants and inbound senders often appear as{" "}
              <code>…@lid</code> rather than a phone number. That is WhatsApp&rsquo;s newer
              identity format, not an error. <code>pn-from-lid</code> resolves it where a mapping
              has been observed; a miss there is legitimate, because resolution only works in one
              direction reliably.
            </p>
          </S>

          {/* ------------------------------------------------------ webhooks */}
          {/* ------------------------------------------------------- session */}
          <S id="session" kicker="Session activity" title={<>Presence, usernames, <em>and a paper trail.</em></>}>
            <Code
              tabs={[
                {
                  label: "Typing indicator", lang: "bash",
                  code: `curl -X POST ${API}/api/send-presence-update   -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json'   -d '{"jid":"+51999888777","type":"composing"}'

# type is one of: unavailable, available, composing, recording, paused
# → { "success": true, "data": { "jid": "+51999888777", "type": "composing" } }`,
                },
                {
                  label: "Session logs", lang: "bash",
                  code: `# PAT-scoped, Laravel paginator — what happened to the *connection*.
curl "${API}/api/whatsapp-sessions/3/session-logs?page=1"   -H "Authorization: Bearer $PAT"

# → { "success": true, "data": { "current_page": 1, "total": 12, "data": [
#     { "id": 201, "whatsapp_session_id": 3,
#       "event_type": "status_change", "status": "connected",
#       "occurred_at": "2025-09-23T12:00:00.000Z" } ] } }`,
                },
                {
                  label: "Username", lang: "bash",
                  code: `curl ${API}/api/fetch-username/+51999888777   -H "Authorization: Bearer $KEY"

# → { "success": true, "data": { "jid": "...@s.whatsapp.net", "username": null } }`,
                },
              ]}
            />
            <p className="mt-5">
              <strong>Presence is fire-and-forget.</strong> WhatsApp acknowledges nothing, so a{" "}
              <code>200</code> means the frame left, not that anybody saw it. The documented{" "}
              <code>delayMs</code> field is accepted and ignored — holding a request open to sleep
              server-side would occupy a connection to simulate something you can do better
              yourself.
            </p>
            <p>
              <strong>Session logs are not the audit log.</strong> The audit log records HTTP
              calls; this records what happened to the connection — status changes and restarts.
              When a session misbehaves, this is the one that answers the question. Rows are
              written by the webhook worker, which is the only place a transition WhatsApp
              initiated is observed.
            </p>
            <p>
              <strong><code>username</code> is almost always <code>null</code>.</strong> WhatsApp
              volunteers one only for accounts that have set it and offers no way to ask, so null
              means &ldquo;not told us&rdquo; and &ldquo;has none&rdquo; alike. It is a{" "}
              <code>200</code> either way, never a <code>404</code>.
            </p>
          </S>

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

          {/* ------------------------------------------------------- sandbox */}
          <S id="sandbox" kicker="Sandbox" title={<>A fake number, <em>a fake WhatsApp.</em></>}>
            <p>
              Linking a real number is the hardest step here and the one that carries the risk —
              you need a phone, a QR scan, and a number you are willing to have banned. A sandbox
              session removes all three. It pairs itself, comes with a small directory, accepts
              sends, and can be made to <em>receive</em> messages so you can watch your webhook
              handler run.
            </p>
            <p className="mt-4">
              It is not a separate API. A sandbox session goes through the same routes and the
              same code as a real one, so what you build against it is what runs in production.
              Its number lives under country code <code>+999</code>, which is unassigned and
              cannot route anywhere.
            </p>
            <Code
              tabs={[
                {
                  label: "Create and connect", lang: "bash",
                  code: `# A wapi extension — WasenderAPI has nothing like this.
# Needs a PAT, like any session creation.
curl -X POST ${API}/api/sandbox/sessions \
  -H "Authorization: Bearer $PAT" \
  -H 'Content-Type: application/json' \
  -d '{"name":"my sandbox"}'

# → { "success": true, "data": { "id": 42,
#     "phone_number": "+99900000042", "api_key": "..." } }

# Connect it. No QR to scan: it shows a fake one, then pairs itself
# after about four seconds — the same need_scan -> connected transition
# a real session makes, so your status webhook fires too.
curl -X POST ${API}/api/whatsapp-sessions/42/connect \
  -H "Authorization: Bearer $PAT"`,
                },
                {
                  label: "Receive a message", lang: "bash",
                  code: `# The reason the sandbox exists. This fabricates a message TO your
# number and sends it down the ordinary pipeline, so the webhook that
# reaches your handler is signed exactly like a real one.
curl -X POST ${API}/api/sandbox/inbound \
  -H "Authorization: Bearer $SANDBOX_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello from a fake human"}'

# → { "success": true, "data": { "key": { "id": "SANDBOX0000000001",
#     "remoteJid": "99900000042001@s.whatsapp.net", "fromMe": false } } }
#
# Your endpoint then receives messages.received, exactly as it would in
# production. Pass "from" to choose which contact it appears to be from.`,
                },
                {
                  label: "From an SDK", lang: "javascript",
                  code: `const admin = new WapiClient({ apiKey: process.env.WAPI_PAT });
const session = await admin.sandbox.createSession("my sandbox");

const wapi = new WapiClient({ apiKey: session.api_key });
await admin.sessions.connection.connect(session.id);

// It pairs itself; poll until it is ready.
while ((await wapi.status()) !== "connected") await sleep(1000);

const contacts = await wapi.contacts.list();   // 5, deterministic
await wapi.messages.send({ to: contacts[0].jid, text: "hi" });
await wapi.sandbox.inbound("and a reply");      // fires your webhook`,
                },
              ]}
            />
            <p className="mt-5">
              <strong>Groups are safe to change here, and only here.</strong> Creating a group and
              adding participants is the one part of the API worth never rehearsing on a real
              number, because it makes a real group and adds real people to it. On a sandbox the
              participants are invented. A created group is listed by <code>GET /api/groups</code>
              afterwards, and per-participant status is reported the way WhatsApp reports it — so
              adding somebody already in the group comes back as <code>409</code> for that
              participant inside a <code>200</code> response.
            </p>
            <p>
              <strong>Three things behave differently on purpose.</strong>{" "}
              <code>account_protection</code> pacing is ignored, so sends return immediately where
              production waits five seconds — it protects a phone number from being banned, and a
              fake number cannot be. <code>decrypt-media</code> returns a fixed PNG rather than
              real media. And everything a sandbox accumulates — its conversation, any groups you
              create — lives in memory: a restart returns it to its fixtures, and{" "}
              <code>logout</code> is how you reset one deliberately. The first two matter if you
              tune retry or timing logic against a sandbox: production is slower.
            </p>
            <p>
              Sandbox sessions are capped at 25 per account and carry a{" "}
              <strong>sandbox</strong> badge everywhere they appear in the dashboard, so a fake
              number is never mistaken for a live one. Each also gets its own{" "}
              <strong>Sandbox</strong> tab — the invented contacts, the conversation as it happens,
              and a box to write a message <em>as</em> one of those contacts. It is the shortest
              path from &ldquo;I have a webhook handler&rdquo; to &ldquo;I have watched it
              run&rdquo;.
            </p>
          </S>

          {/* ----------------------------------------------------------- cli */}
          <S id="cli" kicker="Command line" title={<>The whole API, <em>from a terminal.</em></>}>
            <p>
              <code>wapi</code> is a single binary with no runtime to install — the same 57
              operations this page documents, one command each, plus an escape hatch for anything
              that lands before its command does.
            </p>
            <Code
              tabs={[
                {
                  label: "Install", lang: "bash",
                  code: `# Linux, x64
curl -fsSL -o wapi https://github.com/crafter-station/wapi/releases/latest/download/wapi-linux-x64

# macOS, Apple Silicon
curl -fsSL -o wapi https://github.com/crafter-station/wapi/releases/latest/download/wapi-darwin-arm64
xattr -d com.apple.quarantine wapi   # else Gatekeeper refuses an unsigned download

chmod +x wapi && sudo mv wapi /usr/local/bin/
wapi --version

# Windows, in PowerShell:
#   irm https://github.com/crafter-station/wapi/releases/latest/download/wapi-windows-x64.exe -OutFile wapi.exe`,
                },
                {
                  label: "First run", lang: "bash",
                  code: `wapi login                    # prints a code, opens your browser to approve it
wapi sandbox create --use     # a fake number — no phone, nothing to ban
wapi sessions connect         # pairs itself in a few seconds

wapi send --to +51999888777 --text "hello"
wapi sandbox inbound "and a reply"   # fires your webhook, for real
wapi sandbox thread -f               # tail the conversation while your handler runs`,
                },
                {
                  label: "Scripting", lang: "bash",
                  code: `# --json on anything, and it composes with jq.
wapi sessions list --json | jq -r '.[] | select(.status=="connected") | .id'

# Exit codes: 0 success, 1 failure, 2 usage, 3 credentials.
wapi status --json || echo "exit $?"

# Anything without a command yet — the right credential is attached for you.
wapi api GET /api/groups`,
                },
              ]}
            />
            <p className="mt-5">
              <code>latest</code> follows the newest release; swap it for{" "}
              <code>download/v0.2.0</code> to pin one. Each release also carries{" "}
              <code>SHA256SUMS</code>, worth checking on a binary you did not watch being built.
            </p>
            <p>
              <strong>One token does everything.</strong> <code>wapi login</code> approves a code
              in your browser and stores a Personal Access Token; session keys are fetched from it
              on demand, so there is no second credential to manage. The token appears on your
              tokens page named after the machine, and revoking it there signs that machine out.
            </p>
            <p>
              <strong>Destructive commands refuse to guess.</strong> Deleting a session or leaving
              a group asks first, takes <code>-y</code>, and off a terminal without{" "}
              <code>-y</code> it <em>fails</em> rather than proceeding — auto-confirming inside a
              script is how a scheduled job deletes something at three in the morning.
            </p>
            <p>
              Point it at your own deployment with <code>--profile</code> or{" "}
              <code>WAPI_BASE_URL</code>. Config lives in{" "}
              <code>~/.wapi/config/config.json</code>.
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

          {/* --------------------------------------------------------- audit */}
          <S id="audit" kicker="Audit log" title={<>Every call, <em>on the record.</em></>}>
            <p>
              Each request to the API writes one row: which credential acted, the endpoint, the
              headers, the request and response, the status, how long it took and where it came
              from. Read it on the <Link href="/audit">Audit</Link> page, filtered by session or
              to errors only, and open any entry for the full record.
            </p>
            <Code
              tabs={[
                {
                  label: "What a row holds", lang: "json",
                  code: `{
  "method": "POST",
  "route": "/api/send-message",
  "path": "/api/send-message",
  "status": 200,
  "durationMs": 1249,
  "credentialKind": "session",
  "sessionId": 3,
  "ip": "38.187.27.123",
  "userAgent": "curl/8.9.0",
  "requestHeaders": { "content-type": "application/json" },
  "requestBody": { "to": "+51999888777", "text": "hello" },
  "responseBody": { "success": true, "data": { "msgId": 100722 } }
}`,
                },
                {
                  label: "What is never stored", lang: "json",
                  code: `// The Authorization header is dropped, not masked — it carries a
// credential that controls a WhatsApp account. What is kept instead
// is which KIND of credential acted, which is the audit question.
{
  "credentialKind": "session",   // not the key itself
  "requestHeaders": {
    // "authorization" is absent entirely, at any casing
    "content-type": "application/json",
    "user-agent": "curl/8.9.0"
  }
}

// Secrets inside bodies are replaced before the row is written, at any
// depth. This is the response of GET /api/whatsapp-sessions/{id}, which
// returns the key in plaintext:
{
  "data": {
    "name": "Production",
    "api_key": "[redacted]",
    "webhook_secret": "[redacted]"
  }
}`,
                },
                {
                  label: "Bounds and retention", lang: "json",
                  code: `// Bodies are bounded so an upload cannot become an audit row,
// and long lists are sampled rather than copied.
{
  "requestBody": { "base64": "[redacted] (2202800 chars)",
                   "mimetype": "image/png" },
  "responseBody": { "data": [ { "jid": "..." }, "…495 more" ] }
}

// Retention:
//   request and response bodies  ->  dropped after 7 days
//   the row itself               ->  deleted after 90 days
//
// Bodies carry message text and recipient numbers. A deployment that
// would rather not keep them at all can run with AUDIT_BODIES=off and
// retain the metadata trail only.`,
                },
              ]}
            />
            <p className="mt-5">
              Rejected requests are recorded too — the audit middleware runs before
              authentication, so a sweep of bad credentials shows up as a run of{" "}
              <code>401</code>s rather than as nothing at all.
            </p>
            <p>
              <strong>One honest limitation.</strong> The write is fire-and-forget so that no
              send can fail because logging did, which means rows are best-effort: if the
              database is unreachable the request still succeeds and nothing is written. Treat
              this as an operational record, not a compliance ledger.
            </p>
          </S>

          {/* ---------------------------------------------------- typescript */}
          <S id="typescript" kicker="TypeScript SDK" title={<>A typed client, <em>batteries included.</em></>}>
            <p>
              <code>@wapi/sdk</code> wraps the whole surface with no runtime dependencies — it
              uses global <code>fetch</code>, so Node 18+, Bun and Deno all work. It exists so you
              do not have to remember which of the six success envelopes an endpoint uses.
            </p>
            <p className="mt-4">
              <strong>Vendor it rather than installing it.</strong> npm cannot install a
              subdirectory of a git repository, and this client lives inside a monorepo — so{" "}
              <code>npm install github:crafter-station/wapi</code> would fetch the root package,
              not the SDK. Since the client is dependency-free source, copying it in is a real
              channel rather than a workaround:
            </p>
            <Code
              tabs={[
                {
                  label: "Install", lang: "bash",
                  code: `npx giget@latest gh:crafter-station/wapi/sdk/typescript/src src/wapi

# Then import it as local code:
#   import { WapiClient } from "./wapi/index.js";
#
# Copy src/ and nothing else — scripts/ beside it is a build tool for
# the wapi repository and imports packages you will not have.`,
                },
              ]}
            />
            <Code
              tabs={[
                {
                  label: "Send", lang: "javascript",
                  code: `import { WapiClient } from "@wapi/sdk";

const wapi = new WapiClient({ apiKey: process.env.WAPI_KEY });

const { msgId } = await wapi.messages.send({
  to: "+51999888777",
  text: "hello",
});

// Which field you set decides what is sent, and the types make
// setting two of them a compile error rather than a 422.
await wapi.messages.send({
  to: "+51999888777",
  imageUrl: "https://example.com/photo.jpg",
  text: "optional caption",
});`,
                },
                {
                  label: "Browse", lang: "javascript",
                  code: `// Grouped by resource, with sub-resources where it reads better.
const groups = await wapi.groups.list();
const meta   = await wapi.groups.metadata(groups[0].jid);
await wapi.groups.participants.add(groups[0].jid, ["+51999888777"]);

// list() and page() are separate on purpose: ?paginated=true returns
// a DIFFERENT shape, not the same one with metadata attached.
const { items, pagination } = await wapi.contacts.page({ limit: 50 });

// LIDs and phone numbers are not derivable from one another.
const lid = await wapi.contacts.lid.fromPhone("+51999888777");
const pn  = await wapi.contacts.lid.toPhone(lid); // null when unknown`,
                },
                {
                  label: "Errors", lang: "javascript",
                  code: `import { WapiAuthError, WapiValidationError } from "@wapi/sdk";

try {
  await wapi.sessions.list();          // needs a PAT, not a session key
} catch (err) {
  if (err instanceof WapiValidationError) {
    err.fields;                        // { to: ["The to field is required."] }
  }
  if (err instanceof WapiAuthError && err.isWrongCredentialType) {
    // 403, not 401 — the token was valid but the wrong KIND.
    // A configuration mistake, not a bad secret.
  }
}

// A timeout means the request failed, NOT that the message was
// undelivered. Retrying blindly sends twice — reconcile instead:
await wapi.messages.info(msgId);`,
                },
                {
                  label: "Sessions", lang: "javascript",
                  code: `// Account-level routes: these need a Personal Access Token.
const admin = new WapiClient({ apiKey: process.env.WAPI_PAT });

const session = await admin.sessions.create({
  name: "Production",
  phone_number: "+51999888777",
});

await admin.sessions.connection.connect(session.id);
const { qrCode } = await admin.sessions.connection.qrCode(session.id);

// Regenerating invalidates the old key immediately — anything still
// using it starts getting 401, with no grace period.
const newKey = await admin.sessions.keys.regenerate(session.id);`,
                },
              ]}
            />
            <p className="mt-5">
              The types are generated from the same OpenAPI document this site publishes, so they
              cannot drift from the server; the method names are written by hand, because
              generated ones would read{" "}
              <code>postApiWhatsappSessionsWhatsappSessionRegenerateKey</code>. Source is in{" "}
              <a href={`${REPO}/tree/main/sdk/typescript`}>sdk/typescript</a>, and{" "}
              <a href={`${REPO}/tree/main/sdk`}>sdk/</a> records the shape ports to other languages
              should follow.
            </p>
          </S>

          {/* -------------------------------------------------------- python */}
          <S id="python" kicker="Python SDK" title={<>The same client, <em>in Python.</em></>}>
            <p>
              Same surface, same decisions, snake_case. Zero runtime dependencies — it uses{" "}
              <code>urllib</code> from the standard library — and it is synchronous, because most
              Python callers here are scripts and workers.
            </p>
            <Code
              tabs={[
                {
                  label: "Install", lang: "bash",
                  code: `# pip understands git subdirectories, so this is an ordinary install.
pip install "git+https://github.com/crafter-station/wapi.git#subdirectory=sdk/python"

# Pin a tag for anything you deploy — main moves.
pip install "git+https://github.com/crafter-station/wapi.git@v0.2.0#subdirectory=sdk/python"`,
                },
              ]}
            />
            <Code
              tabs={[
                {
                  label: "Send", lang: "python",
                  code: `from wapi import WapiClient

client = WapiClient(api_key=os.environ["WAPI_KEY"])

result = client.messages.send(to="+51999888777", text="hello")
print(result["msgId"])

# Which field you set decides what is sent.
client.messages.send(
    to="+51999888777",
    imageUrl="https://example.com/photo.jpg",
    text="optional caption",
)`,
                },
                {
                  label: "Browse", lang: "python",
                  code: `groups = client.groups.list()
meta = client.groups.metadata(groups[0]["jid"])
client.groups.participants.add(groups[0]["jid"], ["+51999888777"])

# list() and page() are separate on purpose: ?paginated=true returns
# a DIFFERENT shape, not the same one with metadata attached.
page = client.contacts.page(page=1, limit=50)
items, pagination = page["items"], page["pagination"]

# LIDs and phone numbers are not derivable from one another.
lid = client.contacts.lid.from_phone("+51999888777")
pn = client.contacts.lid.to_phone(lid)   # None when unknown`,
                },
                {
                  label: "Errors", lang: "python",
                  code: `from wapi import WapiAuthError, WapiValidationError, WapiUnavailableError

try:
    client.sessions.list()          # needs a PAT, not a session key
except WapiAuthError as e:
    # 403 means the credential was the wrong KIND, not that it was bad.
    if e.is_wrong_credential_type:
        print("use a Personal Access Token here")

try:
    client.messages.send(to="not-a-number", text="hi")
except WapiValidationError as e:
    print(e.fields)                 # {"to": ["..."]}
except WapiUnavailableError as e:
    if e.is_ambiguous:
        # A timeout means the REQUEST failed, not that the message did
        # not arrive. Reconcile with messages.info() — never resend blindly.
        pass`,
                },
              ]}
            />
          </S>

          {/* ------------------------------------------------------------ go */}
          <S id="go" kicker="Go SDK" title={<>And <em>in Go.</em></>}>
            <p>
              Same surface again, zero dependencies, <code>net/http</code> only. Go resolves
              subdirectory modules natively, so unlike the TypeScript client this is an ordinary
              install rather than a vendoring step.
            </p>
            <Code
              tabs={[
                {
                  label: "Install", lang: "bash",
                  code: `go get github.com/crafter-station/wapi/sdk/go@v0.2.0

# @main moves, so pin a tag for anything you deploy. Go resolves a module in a
# subdirectory through a path-prefixed tag: the repo carries sdk/go/v0.2.0
# alongside v0.2.0, which is what makes the line above work.`,
                },
                {
                  label: "Send", lang: "javascript",
                  code: `import wapi "github.com/crafter-station/wapi/sdk/go"

client := wapi.New(os.Getenv("WAPI_KEY"))

res, err := client.Messages.Send(ctx, "+51999888777", wapi.Text("hello"))
fmt.Println(res.MsgID)

// Send options are functional, so setting two content fields is
// visible at the call site rather than buried in a struct.
client.Messages.Send(ctx, to,
    wapi.ImageURL("https://example.com/photo.jpg"),
    wapi.Text("optional caption"),
)`,
                },
                {
                  label: "Errors", lang: "javascript",
                  code: `_, err := client.Sessions.List(ctx)   // needs a PAT, not a session key

var authErr *wapi.AuthError
if errors.As(err, &authErr) && authErr.WrongCredentialType() {
    // 403: the credential was the wrong KIND, not a bad secret.
}

var unavailable *wapi.UnavailableError
if errors.As(err, &unavailable) && unavailable.Ambiguous() {
    // A timeout means the REQUEST failed, not that the message did not
    // arrive. Reconcile with Messages.Info — never resend blindly.
}`,
                },
              ]}
            />
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
# gotchas -- six success envelopes, two failure envelopes,
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
