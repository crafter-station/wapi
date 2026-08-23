# wapi — a WasenderAPI clone

Rev 3 · 2026-08-23. Every decision below was settled in a grilling session; nothing here is assumed.
Evidence: `docs/wasenderapi/` (99 pages mirrored, 50 routes normalised), `docs/wasenderapi/TECH-STACK.md`,
`docs/design-reference.md`.

## Decisions

| | |
|---|---|
| **Build-to-learn**, deployed for real | No billing, no quotas, no capacity ceiling, no abuse machinery. Target ~5 sessions |
| **Strict drop-in fidelity** | Their published SDKs must work unmodified against our base URL. Warts included |
| **29 Tier-1 routes**, 21 deferred | 22 of 23 webhook events |
| **Bun** workspaces, **Next.js 16**, **Hono** API — **Node 22** for the gateway alone | |
| **`baileys@7.0.0-rc14`** pinned exactly, behind a `WhatsAppEngine` interface | |
| **Clerk** for humans, hashed **Postgres** credentials for machines | |
| **LID** canonical internally; `phone_number` stays required on the public contract | |
| Walking skeleton first | Postgres auth swap lands before feature #2 |

---

## 0. Standing risks

**WhatsApp ToS.** Baileys is an unofficial, reverse-engineered client. Operating it breaks WhatsApp's
terms and gets numbers banned. Two 2026 enforcement mechanisms are *structural* — they penalise being
an unofficial client regardless of how politely you send:

- **Error 463 (Reachout Timelock).** Per the Baileys maintainer, the absence of `<tctoken>`/`<cstoken>`
  makes unofficial clients accrue a "reaching out" rate limit unwillingly. Handling TC tokens is the
  single highest-value mitigation, which is why they're a required key type in §4.
- **Error 475 (Message Capping).** A monthly new-conversation quota on Business accounts.

v7 surfaces both as first-class events — `connection.update.reachoutTimeLock` and
`message-capping.update` — and the enforcement enum includes `WEB_COMPANION_ONLY`, i.e. restriction
applied *because* the account is driven from a linked device. Gate outbound sends on these.

**Legal.** Baileys is clean MIT (verified against the LICENSE file, not npm metadata). The upstream
README discourages business use rhetorically but imposes no licence restriction. Two real items:
the original author received a **cease-and-desist from WhatsApp in April 2023** and had his account
blocked — the one confirmed enforcement action, and it targeted the library author, not a downstream
user. Our own exposure is WhatsApp Business Terms **(b)**: distributing Business Services "over a
network to be used by multiple devices at the same time," which describes a multi-tenant socket host
exactly. This cannot be made compliant; it can be made reliable.

**GPL.** `libsignal@6.0.0` is GPL-3.0 and a direct runtime dependency of rc14. Hosting a network
service is not distribution, so this is fine for us. **If we ever ship an on-prem build or hand a
container image to anyone, it becomes a real problem.**

**Copyright.** `docs/wasenderapi/raw/` and `llms.txt` are their copyrighted prose. Gitignored —
reference locally, never publish. Cloning the *interface* is fine; interfaces aren't copyrightable.

**Evidence hygiene.** Essentially every circulating WhatsApp-ban statistic is vendor marketing with
no dataset or methodology, and `wasenderapi.com` is part of that corpus. We clone their interface;
we give their operational advice zero weight. The only audited figures are India IT Rules compliance
reports (5.1M accounts banned June 2026, 27% proactive; **2.76% appeal reversal rate**, Feb 2026) —
so treat a ban as unrecoverable, not appealable.

---

## 1. The interface

### The fidelity contract

**Their published `wasenderapi` SDKs must work unmodified against `api.wapi.crafter.run`.** That is
the testable definition, and it means copying the warts:

1. **`POST /api/send-message` is one polymorphic endpoint**, documented 14 ways. Union: `to` (required)
   plus one of `text | imageUrl | videoUrl | documentUrl | audioUrl | stickerUrl | contact | location | poll`,
   plus modifiers `fileName`, `mentions[]`, `replyTo`, `viewOnce`. Group, channel, mention, quoted and
   view-once are **not separate routes**.
2. **`msgId` is an integer DB primary key**, distinct from the WhatsApp `key.id` — `/info` returns both.
   **One global monotonic Postgres sequence seeded at 100000.** `replyTo` takes the integer.
3. **Casing stays inconsistent.** Sessions `snake_case`, messages `camelCase`, status lowercase in list
   responses and SCREAMING in connect responses. Their SDKs are written against this.
4. **Envelopes — three failure shapes, not one.** Verified against all 68 response examples;
   this corrects an earlier reading of the docs.
   - Success: `{"success": true, "data": …}`.
   - **Controller failures: `{"success": false, "error": "…"}`.** All 20 per-endpoint failures use
     `error`; **none** use `message`. This is the common case — session not connected, message not
     resendable, upload too large.
   - **Framework failures: `{"success": false, "message": "…", "errors"?: {field: [msg]}}`** — auth,
     validation, subscription gating. Laravel's exception handler, so middleware concerns only.
   - **Throttle: `{"message": "…", "retry_after": n}` with *no* `success` key**, because Laravel's
     ThrottleRequests short-circuits before the envelope is applied. Reproduce the omission.

   Paginated lists use Laravel's length-aware paginator **minus the `links` array** it normally
   includes — twelve keys, verified against both paginated examples. Implemented in
   `packages/contracts/src/envelope.ts`, locked by tests.
5. **Headers.** `X-RateLimit-Limit/Remaining/Reset` on every response; 429 carries `retry_after`.

### Rate limiting — real shape, nominal numbers

Headers and 429 bodies are real; plan-tier limits are generous statics with no meaningful enforcement
(there is no one to abuse this). **`account_protection` is the exception and is genuinely implemented** —
its 1-message-per-5-seconds pacing protects the phone number, which is the one resource here that can't
be redeployed.

### Webhooks

**22 of 23 events** — everything except `passkey.updated`, which has nothing to fire from until §8's
spike resolves. All 23 payload shapes are captured in `docs/wasenderapi/reference/webhooks/`. The
expensive part is the pipeline (queue, retry/backoff, DLQ, signature, per-session filtering); each
additional event is a mapping function, so cutting events saves nothing.

Signature verification copies their **plain-string compare** of `X-Webhook-Signature` as the default,
with **HMAC-SHA256 over the raw body as an opt-in** per session. One boolean column. We keep drop-in
compatibility without shipping the weaker thing as the only option.

### Tier 1 — 29 routes

**Sessions (12)** create · list · get · update · delete · connect · disconnect · qrcode ·
`GET /api/status` · `GET /api/user` · restart · regenerate-key
**Messages (6)** `send-message` (all variants) · `upload` · `decrypt-media` · `messages/{msgId}/info` ·
`messages/read` · `message-logs`
**Groups (6)** list · metadata · participants · create · participants/add · participants/remove
**Contacts (5)** list · get · `on-whatsapp` · `lid-from-pn` · `pn-from-lid`

`decrypt-media` is non-negotiable: Baileys hands you an *encrypted* CDN blob, so without it "read
messages" means text only and every inbound image is a dead link.

The two LID routes are promoted from Tier 2 because v7 makes LID the default identity, `onWhatsApp()`
no longer returns LIDs, and we must maintain the `lid_map` table regardless (§4). Note resolution is
**one-way**: PN→LID works via USync; `getPNForLID` only succeeds for pairs cached from inbound traffic,
so `/api/pn-from-lid` will legitimately miss.

**Deferred (21):** passkey ×4 · group admin tail ×7 (settings, picture, leave, invite-link, invite info,
invite accept, participants/update) · contacts ×4 (create/update, block, unblock, picture) · message
mutations ×3 (edit, delete, resend) · session extras ×3 (session-logs, fetch-username, presence-update).

### Contract as code

`packages/contracts` generates Zod schemas from `docs/wasenderapi/structured/endpoints.json`; the
OpenAPI document and the runtime validators both derive from it. Contract drift becomes a test failure.
The docs site is generated from that same OpenAPI document — theirs is a hand-edited database CMS
(`api_doc_entries` rows of stored HTML), which is why theirs can drift and ours can't.

---

## 2. Architecture

```
                       Cloudflare (proxy, WAF)
                                |
                         Traefik (Dokploy)
                +---------------+---------------+
                |                               |
        +-------v--------+            +---------v---------+
        |      web       |            |        api        |
        |  Next.js 16    |            |    Hono / Bun     |
        | wapi.crafter.  |            | api.wapi.crafter. |
        |     run        |            |       run         |
        | docs·dashboard |            |   29 routes       |
        +-------+--------+            +---------+---------+
                |   HTTP (deadlined) + Redis pubsub        |
                +---------------+--------------------------+
                                |
                  +-------------v--------------+
                  |    gateway  (Node 22)      |
                  |  WhatsAppEngine -> Baileys |
                  |  STATEFUL - 1 owner/session|
                  +-------------+--------------+
                                | enqueue
                  +-------------v--------------+
                  | webhook-worker (BullMQ)    |
                  +-------------+--------------+
                                |
        +-----------------+-----+------+------------------+
        | Postgres (Dokploy) |  Redis  |  UploadX / MinIO |
        +-----------------+------------+------------------+
```

```
apps/web               Next.js 16 — dashboard, Scalar docs, Clerk. No marketing page
apps/api               Hono on Bun — the 29 routes
apps/gateway           Node 22 — sockets, internal RPC only, no published port
apps/webhook-worker    BullMQ — delivery, retry/backoff/DLQ
packages/core          shared logic + WhatsAppEngine interface + Storage interface
packages/contracts     Zod from the mirrored spec, OpenAPI emit
packages/db            Drizzle schema + migrations
packages/baileys-auth  Postgres+Redis AuthenticationState
```

**Why the API isn't in Next.js:** its job is byte-exact envelopes and headers plus raw 16 MB uploads;
Next's routing and rendering give it nothing, and separating it means a docs deploy never bounces
production traffic. `packages/core` keeps logic shared, so the split costs a container, not a codebase.

**Why the gateway is Node:** it holds sockets open for days, and a runtime incompatibility there
surfaces as an unexplained day-three disconnect rather than a startup crash. Baileys declares
`engines: node >= 20`; `minio` is Node-oriented. `whatsapp-rust-bridge` is **WASM, not a native addon**
(single 2 MB file, no per-platform binaries, Alpine/musl/ARM safe), so Bun would probably work — that's
a later experiment, not a critical-path bet.

### The load-bearing constraint

A WhatsApp session is a WebSocket owned by **exactly one process**. `web` and `api` are stateless;
the gateway is not.

- **V1: one gateway replica.** But every call goes through `resolveOwner(sessionId)` against a
  `session_assignments` table from day one, so sharding is later a config change, not a rewrite.
- Known-good ceiling is **~100 sessions per process** (~80 MB and ~40 mCPU each). WAHA's current
  capacity table lists no 500-session row for Baileys and routes that load to a Go engine. Irrelevant
  at ~5 sessions; recorded so nobody later assumes headroom that isn't there.
- Two live sockets on one session escalates to a restriction. Single-socket discipline with monotonic
  attempt guards is a correctness requirement, not an optimisation.

### `WhatsAppEngine`

A thin interface in `packages/core` over **only** what the gateway calls: connect, disconnect, send,
event stream. Not the whole Baileys surface. Baileys upstream managed 8 commits in 60 days against
whatsmeow's 43, hasn't merged the WebAuthn fix in eight weeks, and its own v8 plan names "whatsmeow
integration" — so it's a twelve-month bridge, not a foundation. `@oxidezap/baileyrs` (Rust/WASM, MIT,
Baileys-compatible API, accepts upstream `{creds, keys}`) is the Q1-2027 re-evaluation.

This is the same move `crafter-status` already made — its transport is contained to one file, which is
the only reason moving off puppeteer is thinkable.

### Transport between services

**HTTP for commands, Redis pub/sub for events.** `send-message` needs the WhatsApp ack back to write
the row and return `msgId`, so it's request/response — **with a hard deadline on every call**, because
the failure mode is silence, not an error. Events fan out to more than one consumer (`qrcode.updated`
must reach the SSE stream in `web` *and* the webhook queue), which is pub/sub's job.

---

## 3. Auth

Clerk API Keys cannot back our machine credentials: an API key's `subject` must be `user_xxx` or
`org_xxx` (no application-owned resource, so a per-session key can't be modelled), verification is a
network call billed per use, and it would put a Clerk round-trip on every `send-message`.

| Credential | Owner | Verification |
|---|---|---|
| Dashboard login | **Clerk** | Clerk middleware in `apps/web` |
| Personal Access Token | **Us** — Postgres, hashed | Local, in `apps/api` |
| Session API Key | **Us** — Postgres, hashed | Local, in `apps/api` |

PATs are minted from the dashboard after Clerk auth, so Clerk is the root of trust for *who may create
one* — it's just off the request path. Both machine credentials verify through one hashed-lookup path
with a short Redis cache.

Matching their model: PAT is account-scoped (session CRUD, `proxy_url`, regenerate-key); Session API Key
is per-session and dies with the session. `GET /api/status` and `GET /api/user` take no session id
**because the key is the selector**.

Personal accounts only, but `accounts.clerk_org_id` exists as a nullable column from day one so
Organizations later is a backfill, not a re-parenting of every foreign key.

---

## 4. Data model

**LID is the canonical internal identity; PN is nullable.** The public contract is unchanged —
`phone_number` stays required on session create and present in every response — but internally it's
user-supplied metadata. v7 creates all new Signal sessions in LID format, `Contact.id` is now primary
with `phoneNumber`/`lid` as alternates, `MessageKey` gained `remoteJidAlt`/`participantAlt`, and there
are new `@hosted`/`@hosted.lid` domains.

**Rule for `packages/core`: never string-compare JIDs. Always `areJidsSameUser()`.** That's the bug
class this decision exists to prevent, and it fails silently.

```
accounts               clerk_user_id, clerk_org_id (nullable), created_at
personal_access_tokens account_id, token_hash, name, last_used_at, revoked_at
whatsapp_sessions      id (int PK, exposed), account_id, name, phone_number, lid (nullable),
                       status, api_key_hash, proxy_url, account_protection, log_messages,
                       read_incoming_messages, auto_reject_calls, always_online,
                       ignore_groups, ignore_channels, ignore_broadcasts,
                       webhook_url, webhook_enabled, webhook_secret, webhook_hmac (bool),
                       webhook_events jsonb, last_event_at
session_assignments    session_id, gateway_id, claimed_at          -- the sharding seam
messages               msgId (bigint PK from one global sequence seeded 100000), session_id,
                       wa_key jsonb, remote_jid, from_me, status, content jsonb,
                       media_ref, failed_reason, timestamps
message_logs           the paginated log surface
session_logs           connection lifecycle
contacts, groups       local cache, keyed on LID
lid_map                lid <-> pn, backs the two LID routes
webhook_deliveries     event, payload, attempts, last_status, next_retry_at
```

### The auth store — shaped for v8 now

Upstream: *"v8 ships a new auth state format… Clients that have not been migrated will not connect on
v8."* So `packages/baileys-auth` matches `develop`'s `useSqliteAuthState` from the start:

```sql
CREATE TABLE baileys_creds (session_id …, key TEXT, value TEXT, PRIMARY KEY (session_id, key));
CREATE TABLE signal_keys   (session_id …, type TEXT, id TEXT, value TEXT,
                            PRIMARY KEY (session_id, type, id));
CREATE INDEX signal_keys_type_idx ON signal_keys(session_id, type);
```

- Implement `get`/`set`/`clear` **plus `list(type)`/`listIds(type)`** as async iterables from day one —
  `migrateAuthState` requires them.
- **Serialize with `BufferJSON`.** Plain `JSON.stringify` corrupts Buffers.
- Handle all four v7 key types: **`lid-mapping`, `device-list`, `tctoken`, `identity-key`.** A v6-shaped
  store silently drops LID mappings and TC tokens, and missing TC tokens directly cause error 463.
- **Latency is on the critical path.** Baileys serialises inbound processing per socket behind ordering
  mutexes plus a concurrency-1 queue per key type, so a slow auth read blocks that session's entire
  inbound pipeline. Wrap in `makeCacheableSignalKeyStore`, hot path on Redis, Postgres as durable tier.
- Community packages (`baileys-redis-auth`, `mysql-baileys`, `@rodrigogs/baileys-store`) are all stale
  and none handles v7's new key types. Write our own.

---

## 5. Baileys operational rules

Non-negotiable, no decision attached:

- **Pin `baileys@7.0.0-rc14` exactly** — no caret. rc12 is the floor for **CVE-2026-48063** (critical,
  message-upsert/history-sync spoofing). Note Evolution API pins rc.9, which is vulnerable *and*
  pre-leak-fix; don't inherit that.
- **`syncFullHistory: false`** explicitly. It silently flipped from `false` to `true` in v7 and isn't
  in the migration guide.
- **Patch `LIDMappingStore`'s LRU locally.** It's `ttl: 3 days, ttlAutopurge: true, updateAgeOnGet: true`
  with **no `max`** — unbounded by count, one timer per entry, and active contacts never expire. The fix
  (PR #2640) was auto-closed by a stale bot with no human review.
- **`cachedGroupMetadata`**, or every group send refetches the participant list into a rate limit.
- Pass **shared, namespaced** caches (`userDevicesCache`, `msgRetryCounterCache`, `callOfferCache`,
  `placeholderResendCache`) via `SocketConfig` — and own their lifecycle, since `end()` only closes
  caches it created.
- **Group operations are the top behavioural ban risk**, above send volume — the only trigger with
  quasi-experimental support. Six of our Tier-1 routes are group routes; pace them.
- Don't expect upstream anti-ban help: their Code of Conduct rejects contributions that bypass
  anti-spam or rate-limiting.

---

## 6. Design

Tokens extracted from https://normal.fast — full values in `docs/design-reference.md`. Tailwind v4 +
shadcn/ui, **Geist Sans/Mono**, weights **400/500/600 only**, radius `.625rem`, motion `.1–.2s` on
`cubic-bezier(.23,1,.32,1)`, and the `--landing-paper/ink/line/wash` alias layer.

Adopted verbatim **except** the stray `--sidebar-primary: #1447e6`, an unoverridden shadcn default whose
light-mode sibling is `#171717`.

**The palette is achromatic** — `--destructive` is the only chromatic token in the system. So the seven
session states (`connected`, `connecting`, `need_scan`, `need_passkey`, `disconnected`, `logged_out`,
`expired`) separate on **weight, fill, dashed-vs-solid border and mono labels**, with `destructive`
reserved for genuine failure. More disciplined than coloured dots, and more work.

---

## 7. Deployment

Dokploy `v0.29.1` at `95.111.248.246`, org `jEsGth9_nYbmz6gT4mmKY`, via the `vps` skill.
Repo **`crafter-station/wapi`**, public. One project, Postgres and Redis as managed Dokploy databases,
the four apps as one compose stack from GitHub.

```bash
PROJECT=$(vps project create wapi -d "WhatsApp API gateway" --json | jq -r '.projectId')
ENV=$(vps project info "$PROJECT" --json | jq -r '.environments[0].environmentId')
PG=$(vps pg create wapi-db      -e "$ENV" --json)
RD=$(vps redis create wapi-redis -e "$ENV" --json)

C=$(vps github deploy crafter-station/wapi -e "$ENV" --compose \
      --compose-path ./docker-compose.yaml --branch main --json)
CID=$(echo "$C" | jq -r '.composeId')

vps compose services "$CID" --json
vps domain add wapi.crafter.run     --compose "$CID" --service web --port 3000 --json
vps domain add api.wapi.crafter.run --compose "$CID" --service api --port 3001 --json
vps compose deploy "$CID" --json
```

**Postgres is local to the box, not Neon.** `baileys_auth` is the hottest write path in the system and
sits inside the send/receive loop; it must not have an external network dependency. (`crafter-status`
uses Neon — deliberately not copied here.)

**Media is UploadX hosted mode.** `@uploadx-sdk/core` only — `next` is an *optional* peer dep and the
server bundle is Web-standard `Request`/`Response`. `uploadFiles([{name, data: buffer, type}])` takes
the Buffer Baileys produces; `generateSignedURL(key, 3600)` goes straight to MinIO, so `decrypt-media`'s
one-hour promise costs no extra hop. Behind a `Storage` interface in `packages/core`, so the
direct-MinIO fallback (set `MINIO_*` env vars — they take priority) is a config change with no deploy.
Hosted mode makes `uploadx.crafter.run` a **startup dependency**; that's the escape hatch's purpose.

Only `web` and `api` get domains. `gateway` and `webhook-worker` stay internal with **no published
ports** — the gateway is an unauthenticated internal RPC surface. Two of the loudest "mystery ban"
reports in the research turned out to be hijacked open instances used as spam relays.

- Gateway `replicas: 1`, `restart: unless-stopped`, no rolling deploy — take the honest downtime and
  reconnect from Postgres auth state.
- `web`, `api`, `webhook-worker` redeploy freely.
- Per-session SOCKS5 egress via `proxy_url`, wired but defaulting to none. (Honest caveat: nobody has
  ever run both arms on proxy efficacy — every quantitative claim traces to a proxy vendor.)
- **Backups: Postgres is the whole product.** Lose `baileys_auth` and every session re-pairs — which,
  given §8, may not be possible. Nightly dumps off-box, restore tested before launch.

### Live resources (created 2026-08-23)

| | |
|---|---|
| project | `Qv06ZQHtN8SFNl4F4ZI-O` (`wapi`) |
| environment | `-3bQ8kULOe03LWxojT8gn` (production) |
| compose | `zHI9vuip7TU9vSuCH71QU`, service `api` |
| GitHub provider | `mQ9jA2X9wMQI62PpeoWaL` — **use this one**, not `PUhK5iuG22LeojyZEW87B` |
| test host | `wapi-api-95-111-248-246.traefik.me` (HTTP, no cert) — works today |
| api domain | `api.wapi.crafter.run` → `api:3001`, HTTPS/Let's Encrypt, domain `-aWuTvbIy8zByfSmBLk8l` — **pending DNS** |
| web domain | DNS exists; no Dokploy domain yet — no `web` service in the compose |
| postgres | `H1XF46drj9y19qSnAEBgz` (`wapi-db`), internal host `postgres-program-bluetooth-protocol-s5on6h:5432`, external `5685` |
| redis | `cU8TvQAt278-F3Fmij8O8` (`wapi-redis`), internal host `redis-parse-bluetooth-hard-drive-vnjs36:6379`, external `5646` |

`DATABASE_URL` and `REDIS_URL` are set on the compose stack, built against the **internal**
`appName` hostnames and default ports — not the external ports Dokploy exposes. Secrets live only
in Dokploy; nothing credential-bearing is in this repo.

Two CLI quirks worth remembering: `project create`, `pg create` and `redis create` interleave
progress output on stdout, so `--json` cannot be piped straight into a parser — read the ids back
from `vps project info` instead. And domain ids beginning with `-` need `--` before them
(`vps domain info --json -- -aWuTvbIy8zByfSmBLk8l`).

The earlier "GitHub App has lost access" worry was wrong: provider `mQ9jA2X9wMQI62PpeoWaL` sees all
257 org repos including this one. The existing apps' `hasGitProviderAccess: false` is them being bound
to the *other* provider, which sees 1 repo.

**Traefik labels for a compose stack are applied at deploy time**, so adding a domain requires a
`vps compose redeploy` afterwards or Traefik 404s. Not obvious from the CLI.

### DNS — blocked, needs a human

**There is no wildcard `*.crafter.run` record.** `wspstatus.crafter.run` and `uploadx.crafter.run`
resolve to `95.111.248.246` via explicit A records; `wapi.crafter.run` and `api.wapi.crafter.run`
do not resolve at all. Two A records are needed before the real domains can be attached, because
Let's Encrypt's HTTP-01 challenge requires the hostname to already point at the box:

DNS for `crafter.run` is hosted at **Spaceship** (`launch1.spaceship.net`, `launch2.spaceship.net`).
Records needed there:

| Type | Host | Value | When |
|---|---|---|---|
| A | `api.wapi` | `95.111.248.246` | now — the router already exists and is waiting |
| A | `wapi` | `95.111.248.246` | once `apps/web` ships |

After the first record propagates, `vps compose redeploy zHI9vuip7TU9vSuCH71QU` triggers Let's Encrypt
issuance. Until then Traefik holds the route and ACME cannot validate.

Note `api.wapi.crafter.run` is a second-level subdomain — a `*.crafter.run` wildcard would not cover
it even if one existed, since wildcards match a single label.

---

## 8. Sequencing

**Phase 1 opens with a one-hour empirical test, and everything hangs off it.**

Since 2026-06-30 WhatsApp demands a real WebAuthn assertion during device linking. whatsmeow shipped
support in 31 hours; Baileys' PR #2689 was **closed unmerged on 2026-08-20**, and virtual WebAuthn
authenticators are server-rejected. WasenderAPI's entire passkey surface — including the Device Link
Helper Chrome extension — was **created 2026-07-09, nine days after that change**. That's independent
corroboration from two directions. But their `connect` still defaults to QR and falls back
passkey→QR, so QR works for *some* numbers.

So: **try to pair your real number by QR. One hour.**
- **It pairs** → passkey stays deferred, the spike is money never spent, continue below.
- **It doesn't** → the three-day passkey spike starts that afternoon and becomes the critical path,
  with a headed-browser onboarding fallback as the likely shape. Everything else waits.

| Phase | Ships | Proves |
|---|---|---|
| 0 | `packages/contracts` from the mirrored spec, OpenAPI emit, CI | Interface pinned before code depends on it |
| 1a | **QR pairing test with a real number** | Whether the rest of this plan is possible |
| 1b | Walking skeleton: pair → send one text → receive one `messages.upsert`, on Dokploy, throwaway auth | The deploy topology and the socket, end to end |
| 2 | `packages/baileys-auth` on Postgres; session survives a container recreate | **Lands before feature #3, never "later"** |
| 3 | `apps/api`: both token types, session CRUD, `send-message` text-only, exact envelopes | Auth + the polymorphic route |
| 4 | `apps/web`: Clerk, dashboard, QR over SSE, PAT management | A human can pair without curl |
| 5 | Full send-message union, `upload`, `decrypt-media`, UploadX | Media path |
| 6 | `webhook-worker`: 22 events, retries, signature | Receive path |
| 7 | Groups + contacts + LID routes | Breadth to 29 |
| 8 | Rate-limit headers, `account_protection` pacing, logs, staleness | Operability |
| 9 | Scalar docs from OpenAPI, generated `/llms.txt` | Shippable |

Commit per coherent feature, conventional format with workspace scopes (`feat(api):`), straight to
`main`. **Never pushed without asking.**

---

## 9. Verification

1. **Their free trial account** — one hour with it converts our remaining guesses into facts:
   `msgId` sequencing, the exact paginator envelope, and what `pn-from-lid` returns on a miss.
   *(Using a competitor's trial to build a clone is a ToS call to make with open eyes.)*
2. **68 golden fixtures** already extracted into `docs/wasenderapi/structured/entries.json` — assert
   our responses match.
3. **Their real `wasenderapi` npm SDK** run against `api.wapi.crafter.run`. This is the actual
   definition of the promise: if it works unmodified, the claim is proven rather than asserted.

`bun test`, one GitHub Actions workflow, three jobs: typecheck, fixtures, SDK smoke.

### Observability

`pino` structured logs (already a Baileys dependency) plus `last_event_at` touched on every inbound
event. The characteristic failure is a socket reporting `connected` while receiving nothing for hours —
silence, which throws nothing, so an error tracker wouldn't catch it. No Sentry in V1.

**Staleness cannot appear in `GET /api/status`** — §1 pins that response to their seven statuses, none
of which is "connected but stale." It lives in the dashboard and the logs only. Strict fidelity making
the product slightly worse, deliberately.

---

## 10. Known unknowns

Not settled, and not to be read as settled:

1. **Whether your number pairs by QR.** Gates phase 1 and possibly three days of passkey work.
2. **`msgId` sequencing, the paginator envelope, `pn-from-lid` miss behaviour** — inferred, pending §9.1.
3. **UploadX's SDK on Bun is untested** and `apps/api` is Bun. If `minio`/`Readable.toWeb()` misbehave,
   storage calls move to the Node gateway or drop to raw HTTP.
4. **Whether the MinIO `endPoint` UploadX returns is reachable from inside a Dokploy container.**
5. **The Dokploy GitHub App needs reconnecting** — a manual click, and it blocks the first deploy.
6. **The `upx_live_` key was pasted in cleartext and needs rotating.**

And one honest note: strict fidelity to an interface nobody is currently migrating from is the single
largest discretionary expense in this plan. It was chosen knowingly, on the grounds that "clone" should
mean something testable rather than aspirational.
