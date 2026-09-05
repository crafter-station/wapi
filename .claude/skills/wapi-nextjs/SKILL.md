---
name: wapi-nextjs
description: Integrate wapi (self-hosted WhatsApp REST API) into a Next.js app — sending messages, reading contacts and groups, and receiving webhooks. Use when adding WhatsApp messaging to a Next.js project, or when a WasenderAPI client needs to point at wapi.
---

# Integrating wapi into a Next.js app

wapi exposes WhatsApp over a plain REST API and is wire-compatible with WasenderAPI.

- Base URL: `https://api.wapi.crafter.run`
- Per-endpoint reference (generated from the server's own contract): `https://api.wapi.crafter.run/docs`
- Raw OpenAPI spec: `https://api.wapi.crafter.run/openapi.json`
- Narrative guide, with worked examples: `https://wapi.crafter.run/docs`

Fetch the OpenAPI spec if you need a field this skill does not cover — it is generated from the
contract the server validates against, so it cannot drift from the implementation.

**If you are an agent building this without a human at the keyboard, read step 0 first.** You
cannot scan a QR code, and every real session begins with one.

Work in this order. Steps 1–3 are always required; 4 and 5 are per-feature.

## 0. Use a sandbox session while you build

A sandbox session is a fake number on a fake WhatsApp. It pairs itself — no QR, no phone, nothing
to ban — and goes through the same routes and the same code as a real one, so what you build
against it is what runs in production.

```bash
# Create one. Needs a PAT.
curl -X POST "$WAPI_BASE_URL/api/sandbox/sessions"   -H "Authorization: Bearer $WAPI_PAT" -H 'Content-Type: application/json'   -d '{"name":"agent sandbox"}'
# → data.api_key is what your app should use as WAPI_API_KEY while developing.

# Connect it, then poll: it pairs itself after ~4s.
curl -X POST "$WAPI_BASE_URL/api/whatsapp-sessions/<id>/connect"   -H "Authorization: Bearer $WAPI_PAT"
```

Then, once your webhook handler exists, **make it receive a real delivery**:

```ts
await wapi.sandbox.inbound("hello from a fake human");
```

That fabricates an inbound message and sends it down the ordinary pipeline, so your endpoint gets
a genuine, signed `messages.received`. It is the only way to verify a webhook handler without a
real conversation, and it is the single most useful thing here for an agent.

**Group and contact writes belong here specifically.** Creating a group, adding or promoting
participants, leaving, blocking somebody — these are the parts of the API you should not rehearse
on a real number, because they make a real group, add real people, and block a real contact. On a
sandbox all of it is invented, and the read-back works: a created group is listed by
`GET /api/groups`, an invite code from `GET /invite-link` is accepted by
`POST /api/groups/invite/accept`, and a name saved with `PUT /api/contacts` shows up in the
directory.

If you have a shell, the `wapi` CLI does all of this in one line each — `wapi sandbox create
--use`, `wapi sessions connect`, `wapi sandbox inbound "hello"` — and `wapi sandbox thread -f`
tails the fake conversation while your handler runs. It is a single binary with the runtime
inside, so installing it adds nothing to the project:

```bash
curl -fsSL -o wapi https://github.com/crafter-station/wapi/releases/latest/download/wapi-linux-x64
chmod +x wapi && sudo mv wapi /usr/local/bin/
wapi login
```

On macOS use `wapi-darwin-arm64` and clear the quarantine attribute afterwards
(`xattr -d com.apple.quarantine wapi`), or Gatekeeper refuses to run an unsigned download. On
Windows the asset is `wapi-windows-x64.exe`.

If you have a browser, the dashboard gives a sandbox its own **Sandbox** tab: the invented
contacts, the conversation as it happens, and a box to write a message *as* one of those contacts.
It is the fastest way to watch your webhook handler run.

**Swap in a real session before shipping.** Two behaviours differ deliberately:
`account_protection` pacing is ignored (production waits five seconds per send) and
`decrypt-media` returns a fixed PNG. Do not tune retry or timing logic against a sandbox.

## 1. Decide which credential each call needs

Two token types go in the same `Authorization: Bearer` header and are **not** interchangeable.
Using the wrong one returns `403`, not `401`, which is the usual source of a confusing first
failure.

| Token | Use for | Where it comes from |
| --- | --- | --- |
| **Session API key** | messaging, contacts, groups, media, status | the session's page in the dashboard |
| **Personal Access Token** | creating/updating/deleting sessions, proxies, regenerating keys | the Tokens page |

The session key *is* the session selector — that is why `GET /api/status` takes no session id.
Most app code needs only the session key.

## 2. Put the key on the server, never in the browser

Both tokens grant full control of a WhatsApp account. They must never reach the client.

```bash
# .env.local — no NEXT_PUBLIC_ prefix, deliberately
WAPI_BASE_URL=https://api.wapi.crafter.run
WAPI_API_KEY=<session api key>
WAPI_WEBHOOK_SECRET=<session webhook secret>
```

If a component needs to trigger a send, use a **Server Action** or a Route Handler. Never a
`fetch` from a client component with the key in scope — a `NEXT_PUBLIC_` key is world-readable
the moment it ships.

## 3. Add the client

Vendor the official SDK, then add the server-only wrapper:

```bash
npx giget@latest gh:crafter-station/wapi/sdk/typescript/src src/wapi
```

Copy `references/wapi-server.ts` to `src/lib/wapi.ts`. It is deliberately thin — the SDK does the
work, and the wrapper adds the one thing the SDK cannot express because it is a Next.js concern
rather than an API one: `server-only`, which turns importing it from a client component into a
build error rather than a leaked WhatsApp credential.

**Vendored rather than installed** because npm cannot install a subdirectory of a git repository
and the SDK lives inside a monorepo; `npm install github:crafter-station/wapi` fetches the root
package instead. Copy `src` and nothing else.

Earlier versions of this skill shipped their own client. That was a second implementation of the
same API covering thirteen of its thirty operations, with nothing keeping it in step — the SDK is
checked against the OpenAPI document in CI, so use that instead.

Read `references/api-notes.md` before hand-rolling anything: several behaviours are not guessable
from the endpoint names.

## 4. Send a message

`POST /api/send-message` is one endpoint for every message type. **Which field you set decides
what is sent** — there is no separate route for images or groups. Setting two content fields is
an error rather than a silent preference.

```ts
"use server";
import { wapi } from "@/lib/wapi";

export async function notify(phone: string, text: string) {
  const { msgId } = await wapi.messages.send({ to: phone, text });
  return msgId;
}
```

Sending to a group is the same call with a group JID (`…@g.us`) as `to`.

**Reacting** is a separate call and a **wapi extension** — WasenderAPI reports reactions over
webhooks but has no endpoint to send one, so feature-detect if you target both:

```ts
await wapi.messages.react(data.key, "👍");  // data.key comes straight from the webhook
await wapi.messages.unreact(data.key);      // empty emoji clears it
```

It takes the WhatsApp `key`, not a `msgId`, because you mostly react to messages someone *else*
sent and those have no `msgId`.

Media is sent **by URL** — `imageUrl`, `documentUrl` and friends are fetched server-side at send
time. If the file is not already hosted, `POST /api/upload` first and use the URL it returns:
that one is permanent, so it still resolves when the message is sent later.

## 5. Receive webhooks

Create a Route Handler and verify the signature before trusting anything. Copy
`references/webhook-route.ts` to `src/app/api/wapi/webhook/route.ts`.

Two things that will bite otherwise:

- **The default signature is a plain string compare**, not an HMAC — `X-Webhook-Signature`
  carries the webhook secret itself. That is WasenderAPI's scheme, reproduced for
  compatibility. wapi additionally supports HMAC-SHA256 over the raw body as a per-session
  opt-in (`webhook_hmac`); prefer it, and the reference handler supports both.
- **Acknowledge fast.** Delivery retries with backoff on any non-2xx, so slow handlers cause
  duplicate deliveries. Return 200 and do the work after.

Point the session at the handler:

```bash
curl -X PUT "$WAPI_BASE_URL/api/whatsapp-sessions/1" \
  -H "Authorization: Bearer $WAPI_PAT" \
  -H 'Content-Type: application/json' \
  -d '{"webhook_url":"https://your.app/api/wapi/webhook",
       "webhook_enabled":true,
       "webhook_events":["messages.received"]}'
```

An empty `webhook_events` array means *send everything*.

## Checks before you call it done

- No token reaches the client bundle. Grep the build output for the key's prefix.
- The webhook handler rejects a request with a wrong or missing signature.
- A `403` is handled distinctly from `401` — they mean different things here.
- Pagination uses `contacts.page()` / `groups.page()`, not `list()`. They are separate methods
  because `?paginated=true` returns a different shape, and mixing them up yields `undefined`.
- Sends are not retried blindly. A timeout does not mean the message was not sent; reconcile
  with `wapi.messages.info(msgId)` rather than sending again.
- `src/wapi/` is vendored, so it does not update itself. Re-run the giget command after the API
  gains endpoints you need.
- If you built against a sandbox, the app is pointed at a fake number. Swapping to a real session
  is a credential change, but re-read the timing caveats in step 0 before assuming behaviour
  carries over.

## Migrating from WasenderAPI

Their published npm client works unmodified. The base URL is the third argument:

```ts
import { createWasender } from "wasenderapi";
const wa = createWasender(process.env.WAPI_API_KEY!, undefined, `${base}/api`);
```

If a client validates media hostnames or pins the provider origin, point it at wapi's origin —
media is served from the same host as the API.
