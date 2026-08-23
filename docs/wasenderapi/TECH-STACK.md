# WasenderAPI — Technology Investigation

Investigated 2026-08-23 by fingerprinting HTTP headers, cookies, the Inertia SSR payload,
the Vite asset manifest, the published SDKs, and the semantics of the documented API surface.

## Evidence table

| Layer | Finding | Evidence |
|---|---|---|
| Edge / CDN | **Cloudflare** (proxied, HTTP/3, NEL, Rocket Loader, Speculation Rules) | `Server: cloudflare`, `CF-RAY`, `cf-cache-status: HIT`, `alt-svc: h3`, `<script type="5b9af484...-text/javascript">` (Rocket Loader), `Speculation-Rules: "/cdn-cgi/speculation"` |
| Edge caching | Full-page HTML cache with **tag-based purging** | `Cache-Control: public, max-age=21600, s-maxage=21600, stale-while-revalidate=86400`, `x-cache-tags: public,dynamic,route:api-docs.index,path:api-docs` |
| Web framework | **Laravel (PHP)** | `XSRF-TOKEN` + `wasenderapi_..._session` cookies in Laravel's `iv/value/mac/tag` encrypted-cookie envelope; validation error body `{"message":..., "errors":{field:[...]}}`; `errors` prop always present in the page payload |
| SPA transport | **Inertia.js v2** | `vary: X-Inertia` response header; `data-page="{component,props,url,version}"` root attribute; bundle strings `inertia:finish`, `inertia-error-dialog`, `inertia:infinite-scroll-data` (v2-only) |
| UI runtime | **React 18** | 18 `react` refs + `createElement` in `app-BlSDj6Hl.js`; zero Vue markers |
| Bundler | **Vite** | `/build/assets/<name>-<hash>.js`, `rel="modulepreload"` link header emitted by the Vite manifest |
| Component kit | **shadcn/ui on Radix** + **lucide-react** + **Tailwind** | code-split chunks named `dialog-*.js`, `tabs-*.js`, `button-*.js`, `createLucideIcon-*.js`, `search-*.js`, `chevron-left-*.js` |
| Route helper | **Ziggy** | `ziggy` prop with full `routes` map (`login`, `logout`, `password.request`, `password.reset`, …) |
| Fonts | **Bunny Fonts** (GDPR-friendly Google Fonts mirror) | `https://fonts.bunny.net` |
| Billing | **Paddle Billing** (almost certainly Laravel Cashier Paddle) | `cdn.paddle.com`, `window.Paddle.Initialize({token:"live_c90f691403a136205e93da51d76"})` |
| Analytics / ads | GA4 (`G-KM8QTS9EJZ`), GTM, Meta Pixel, Twitter Ads, Reddit Pixel | script hosts in page HTML |
| Support widget | easychatwidget.com | third-party host |
| Social proof | Trustpilot, ProductHunt embeds | third-party hosts |

## Docs system

The API docs are **not** generated from OpenAPI — they are a database-backed CMS inside the same Laravel app.
The Inertia payload leaks the exact row shape of the entry table:

```
api_doc_categories(id, name, slug, description, icon, order, created_at, updated_at)
api_doc_entries(id, api_doc_category_id, user_id, title, slug, description,
                endpoint, method, parameters, code_examples, response_examples,
                content, order, is_published, created_at, updated_at)
```

`parameters`, `code_examples`, `response_examples` are JSON columns; `content` is stored HTML
(`<div class="help-article">…`). Rendered by component `api-docs/show`. There is no `openapi.json`,
`swagger.json`, or `llms-full.txt` (all 404) — but `/llms.txt` **is** generated dynamically from
those rows and contains the whole reference. That is what was downloaded.

## WhatsApp engine — Baileys, behind a separate Node service

This is the load-bearing conclusion for a clone. The Laravel app is a control plane; it is not what
talks to WhatsApp.

**It's Baileys (`@whiskeysockets/baileys`), not the WhatsApp Cloud API and not whatsapp-web.js:**

- Every webhook `event` name is a verbatim Baileys `ev.on()` key:
  `messages.upsert`, `messages.update`, `messages.delete`, `messages.reaction`, `message-receipt.update`,
  `chats.upsert`, `chats.update`, `chats.delete`, `contacts.upsert`, `contacts.update`,
  `groups.upsert`, `groups.update`, `group-participants.update`, `call`.
- `POST /api/decrypt-media` takes a raw Baileys message node — `imageMessage` with `url`, `mediaKey`,
  `fileSha256`, `fileLength`, `mimetype`. Those fields only exist because Baileys hands you the
  encrypted CDN blob and you call `downloadContentFromMessage` yourself. The Cloud API never exposes this.
- `GET /api/lid-from-pn/{pn}` and `GET /api/pn-from-lid/{lid}` mirror Baileys' LID↔PN signal-identity
  mapping introduced in the 6.7.x line.
- Newsletter/channel JIDs (`@newsletter`), `@g.us` group JIDs, `@s.whatsapp.net` user JIDs, view-once,
  presence (`composing`/`recording`), poll decryption — all Baileys socket features.
- QR **and** WebAuthn passkey pairing (`/api/passkey/pending|response|confirm` + a
  "Device Link Helper" Chrome extension) is the newer Baileys `pairing via passkey` flow.
- whatsapp-web.js is ruled out: it drives a headless Chrome and never exposes `mediaKey`/LID primitives,
  and could not sustain the per-session density these plans imply.

**A distinct engine process is confirmed by the docs' own wording:** update-session "syncs webhook
settings *with the WhatsApp API server*", delete-session "will attempt to disconnect *from the
WhatsApp API server* first". So: Laravel ⇄ internal HTTP ⇄ Node/Baileys gateway holding the live sockets.

Supporting operational tells:
- Per-session `proxy_url` accepting `http/https/socks5` (Baileys accepts an `agent`); "use a proxy in
  the same country as the number", "sticky IP" — classic Baileys anti-ban ops advice.
- Session statuses `connecting / connected / disconnected / need_scan / need_passkey / logged_out / expired`
  map onto Baileys `connection.update` + DisconnectReason.
- `account_protection` = throttle to 1 send / 5s. `always_online`, `read_incoming_messages`,
  `auto_reject_calls`, `ignore_groups/channels/broadcasts` are all socket-level toggles.

## Auth model (two distinct token types)

1. **Personal Access Token** — account-scoped (Laravel Sanctum). Required for session CRUD:
   create/update/delete sessions, set `proxy_url`, regenerate keys, and the MCP server.
2. **Session API Key** — per-session, auto-issued on connect, revoked when the session is deleted.
   Used for all messaging/contacts/groups traffic. This is why `GET /api/status` and `GET /api/user`
   take no session id — the key *is* the session selector.

Rate limits are enforced **per endpoint per session**, returned via `X-RateLimit-Limit/Remaining/Reset`
and 429 bodies carrying `retry_after`.

## Other surface

- **Remote MCP server** at `https://wasenderapi.com/mcp`, streamable-HTTP transport, Bearer PAT auth,
  ~30 tools. Paid plans only.
- **SDKs**: `wasenderapi` on npm (v0.4.0, TypeScript, zero runtime deps beyond dotenv, base URL
  `https://www.wasenderapi.com/api`), `wasenderapi` on PyPI, `wasenderapi/wasenderapi-laravel` on Packagist.
- **n8n community node**, official.
