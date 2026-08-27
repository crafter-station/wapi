# AGENTS.md

Working notes for anyone — human or agent — changing this repository. `README.md` is the front
door and `PLAN.md` holds the design reasoning; this file is the operational knowledge, including
the mistakes that already cost time.

---

## What this is

A self-hosted clone of the **WasenderAPI** HTTP interface, backed by Baileys. The defining
constraint is **strict wire fidelity**: the goal is that their published SDK runs against us
unmodified. That means reproducing inconsistencies rather than tidying them. When something in
this API looks wrong, the first question is "is this theirs?" — usually it is, and it stays.

The upstream documentation is mirrored under `docs/wasenderapi/` and is **gitignored** (their
prose is copyrighted). CI therefore skips the suites that read it. A skipped suite is honest;
a green tick on assertions that never ran is not.

---

## Commands

```bash
bun install
bun run typecheck          # every workspace with a tsconfig, derived from package.json
bun test                   # unit + contract suites
bun run contracts:generate # regenerate Zod contracts from the mirrored spec
node ops/check-dockerfile-manifests.mjs
bun  ops/check-sdk-in-sync.mjs   # bun, not node — it imports the TS contracts
```

Live integration tests need `DATABASE_URL` and self-skip without it:

```bash
set -a; . ./.env; set +a
bun test compat/integration.test.ts
```

---

## Layout

| Path | Runtime | Notes |
| --- | --- | --- |
| `apps/api` | Bun + Hono | the 29 routes. **Stateless** |
| `apps/gateway` | **Node 22** | Baileys sockets. **Stateful**, internal RPC only, no public port |
| `apps/webhook-worker` | Node + BullMQ | delivery, retry, backoff, DLQ |
| `apps/web` | Next.js 16 | dashboard, guide, Clerk |
| `packages/contracts` | — | Zod contracts, response schemas, OpenAPI emit |
| `packages/core` | — | shared logic, `WhatsAppEngine` + `Storage` interfaces |
| `packages/db` | — | Drizzle schema + migrations |
| `packages/baileys-auth` | — | Postgres-backed `AuthenticationState` |
| `compat/` | — | SDK-compat + live integration suites |
| `sdk/typescript` | — | TypeScript client. Types generated, surface hand-written |
| `sdk/python` | — | Python client. Stdlib only, same surface, snake_case |
| `ops/` | — | backup, restore, retention, CI guards |

The gateway is Node, not Bun, because Baileys' WASM Signal bridge needs it. Everything else is
Bun. Do not "unify" this.

---

## The dashboard

Two halves, deliberately: an **operator console** (is this session healthy, what is it
configured to do) and a **developer workbench** (what contacts, groups, messages and webhook
deliveries exist). Everything session-scoped lives under `/sessions/{id}/…` — a contact list
without a session is meaningless, and a session picker on every page would re-express in UI
what the URL already says.

`apps/web/src/app/sessions/[id]/layout.tsx` resolves and authorises the session, so it is the
ownership check for every page beneath it.

`/audit` is the exception to the session-scoped rule and deliberately so: calls made with a PAT —
creating a session, rotating a key — belong to the account and have no session at all, so filing
the trail under a session would hide the actions most worth auditing.

**Where data comes from is a rule, not a habit:**

| | Source | Why |
| --- | --- | --- |
| Sessions, tokens | Postgres | no API equivalent that isn't PAT-scoped |
| Message log | Postgres | `message-logs` is PAT-authenticated upstream |
| Contacts, groups | our own API, internal `http://api:3001` | dogfooding: if `/api/contacts` breaks, the dashboard breaks |
| Doctor | our own API, public `https://api.wapi.crafter.run` | the edge is part of what it tests |

The web app must never hold a Personal Access Token. That is the whole reason account-scoped
reads go direct to the database rather than through HTTP.

**The doctor** (`apps/web/src/lib/doctor.ts`) has three rules that are not negotiable:

- Every call goes over the **public edge**, because "does this work end to end" includes TLS
  and the proxy.
- The only write is a message to the session's **own number**. Never a group, never a third
  party — a health check must be safe to press repeatedly.
- **`skipped` is not `fail`.** A session with no webhook is not broken. Reporting it as broken
  is how a health check earns a reputation for crying wolf and stops being read.

It verifies webhook delivery by reading what the worker recorded, never by repointing
`webhook_url` at our sink — that races with live traffic and can strand a session pointing
somewhere wrong if the run dies midway. The trade is that it proves *the worker got a 2xx*, not
that we saw the payload.

It does **not** run on a schedule, and should not: that is unattended WhatsApp traffic from a
bannable number, for a signal nobody is watching.

---

## Audit logs

Every API request lands one row in `audit_logs`: which credential acted, the endpoint, the route
pattern, headers, request, response, status, duration, IP and user agent.

**Read `packages/core/src/redact.ts` before touching any of it.** `Authorization` carries a full
WhatsApp credential, and the session detail and regenerate-key responses return `api_key` and
`webhook_secret` in plaintext because fidelity requires it. Recorded verbatim this table is a
list of every live key the system has issued.

The rule is **allow-list for headers, deny-list for bodies**. Header names are a small closed set
we control, so a future `x-internal-key` is excluded by default. Body shapes are open-ended, so an
allow-list would drop the fields that make the log useful — there secrets are stripped
recursively, bulk fields described rather than stored, arrays sampled and everything bounded.
`redact.test.ts` is the specification, written as "this must never appear".

Three properties, and they are ordered by how badly getting them wrong would hurt:

1. **It cannot leak.** See above.
2. **It cannot fail a request.** The insert is fire-and-forget with swallowed errors — no send
   should fail because bookkeeping did.
3. **It cannot slow the hot path.** The insert is not awaited.

The cost of (2): rows are **best-effort**. If Postgres is down nothing is written, and an
in-flight write is lost when the process is replaced. This is an operational record, not a
compliance ledger. Do not let anyone believe otherwise.

Registered *before* authentication, so a rejected request is recorded too — a sweep of failed
credentials is the thing an audit trail exists to show.

**Bodies carry message content.** Redaction removes credentials, not information: a send-message
body holds the message text and the recipient's number. `AUDIT_BODIES=off` keeps the metadata
trail without them. Retention nulls bodies at 7 days and deletes rows at 90 — metadata outlives
content because "which credential called what, when" is asked about last quarter far more often
than last week.

**No geolocation.** Cloudflare is DNS-only here, not proxying, so there is no `CF-IPCountry` and
`country` stays null. That is deliberate: a per-request GeoIP lookup would add a network
dependency to every call and hand client IPs to a third party. The column populates by itself if
proxying is ever enabled.

Webhook *triggers* are not duplicated here — they are in `webhook_dispatches` below.

---

## Webhook records

Two tables that are easy to confuse:

- **`webhook_deliveries`** — what our own test *sink* received. Only ever populated for a
  session deliberately pointed at `/api/webhook-sink`.
- **`webhook_dispatches`** — what the worker *sent*, for any session including production ones
  delivering to a customer's app. One row per event keyed on the BullMQ job id, **updated in
  place**: retries go up to five, so per-attempt rows would multiply by five exactly on the
  sessions that are failing.

Recording must never throw. A failed insert after a successful POST would fail the job, BullMQ
would retry it, and a bookkeeping error would become a duplicate webhook.

`dispatchStatus` in `apps/webhook-worker/src/events.ts` is a pure function *because* it cannot
be exercised live — the only paired session answers 200, so every production row is a
first-attempt success. BullMQ's `attemptsMade` counts attempts *before* the current one; that
off-by-one is version-sensitive and pinned by tests.

**Retention** runs in the backup container after the dump: payloads nulled at 7 days, rows
deleted at 30. Health stays useful for weeks; a payload is a debugging aid measured in hours
and carries real message content.

---

## The fidelity contract

This is the part most likely to be got wrong. Details in `packages/contracts/src/responses.ts`.

**Five success envelopes.** Do not write one `unwrap(res.data)` helper and assume it applies.

| Shape | Where |
| --- | --- |
| `{success, data}` | most routes |
| `{status}` — *no `success` key* | `GET /api/status` |
| `{success, api_key}` — top level | `POST …/regenerate-key` |
| `{success, publicUrl}` — top level | `POST /api/upload`, `POST /api/decrypt-media` |
| `{success, message}` | `POST …/restart` |
| `204`, no body | `DELETE /api/whatsapp-sessions/{id}` |

**Three failure envelopes**, and which one you get says *where* it failed:

- `{success: false, error}` — a route handler decided it.
- `{success: false, message, errors?}` — middleware decided it (auth, validation).
- `{message, retry_after}` — throttling, with **no `success` key**; Laravel short-circuits
  before the envelope is applied.

**Two unrelated pagination shapes:**

- `?paginated=true` on contacts and groups → `data: {items, pagination:{page, limit, total,
  totalPages}}`, `limit` default **20**. Consumers check `totalPages === ceil(total/limit)` and
  reject the page otherwise.
- Message and session logs → Laravel's length-aware paginator, **minus** the `links` array.

**Other inherited oddities:** `status` is SCREAMING_CASE in connect responses and lowercase
everywhere else. Contacts are keyed on `jid` in lists and `id` in the detail route (we emit
both). Groups carry `jid`/`id` and `name`/`subject`. `GET /api/messages/{msgId}/info` returns
the *WhatsApp* record, so `messageTimestamp` is a **string** (protobuf int64) and `status` a
**number** (ack enum), unlike everywhere else.

`msgId` is our own Postgres sequence starting at 100000 — not WhatsApp's id, which is `key.id`.

### Extensions

Anything of ours goes in `packages/contracts/src/extensions.ts`, never in `generated/routes.ts`
— that file is rewritten wholesale by `contracts:generate`, and folding an addition into
`ROUTES` would falsify the "29 routes" claim that a test asserts and `/health` reports. The two
counts are reported separately for that reason.

The bar is high. Fidelity means their SDK runs unmodified, and an endpoint they never call
cannot break that — but each addition is one more thing true of wapi and not of the interface it
claims to clone. Extending an *existing documented route* is worse and stays off the table:
that changes behaviour a client already knows.

Current extensions: `POST /api/messages/react` (they emit `messages.reaction` as a webhook but
document no way to send one), and `webhook_hmac`, which is dashboard-only.

---

## SDKs

`sdk/` holds one client per language — TypeScript and Python today. `sdk/README.md` records the
shape every port must follow, and it is worth reading before adding one: a port should reproduce
the *decisions* (five envelopes, three failure shapes, `list()` separate from `page()`), not just
the endpoints. An SDK that faithfully exposes the awkwardness has not earned its place.

**When you change a route or a response schema, every SDK is part of the change.** CI enforces
it:

```bash
bun run --cwd sdk/typescript generate   # refresh src/types.gen.ts
# add or update the method in sdk/typescript/src/resources/
# and the matching one in sdk/python/wapi/resources/
bun ops/check-sdk-in-sync.mjs
```

That guard makes three checks — generated types current, and one coverage check *per language*.
**Extend it when you add a language**; a rule nobody enforces is a rule that drifts, and the
coverage failure is silent in exactly the same way for every port. Stale generated types would eventually surface as a type
error; **an endpoint with no method is silent**, and that is the one it exists for — the same
class of drift as a hardcoded list in CI, which this repository has now hit three times.

**Types are generated, ergonomics are hand-written**, and that split is deliberate rather than
laziness. Every OpenAPI generator derives method names from `operationId`, and ours are
mechanical path transliterations — `postApiWhatsappSessionsWhatsappSessionRegenerateKey`. Running
one would buy correct types at the cost of a surface nobody wants to call. Renaming thirty
operations in a generator config is the same work as writing thirty methods, minus the ability to
group them into sub-resources.

**Both clients have zero runtime dependencies** — global `fetch` in TypeScript, `urllib` in
Python. Something dropped into other people's projects should not drag a dependency tree behind
it, and this is JSON in, JSON out, one header.

The Python client is **synchronous**, unlike the TypeScript one. That is the idiom on each side:
most Python callers here are scripts and workers, and a sync client composes with
`asyncio.to_thread` more easily than the reverse does.

The generator reads the **OpenAPI document**, not `@wapi/contracts` internals, because that is
the artifact the Go and Python ports will also read.

---

## Verification layers

Each catches something the others cannot. Do not collapse them.

1. **Unit** — pure logic.
2. **Contract** (`packages/contracts`) — our response schemas parse *their* documented
   examples. Catches drift from the interface being cloned. Skips without the mirror.
3. **SDK compat** (`compat/sdk-compat.test.ts`) — their real npm client against us.
4. **Live integration** (`compat/integration.test.ts`) — real HTTP against production,
   including parsing live responses with the schemas `/openapi.json` publishes. This is what
   catches a handler drifting from its own documentation.

Everything expensive learned in this repo was invisible to unit tests: a NOT NULL violation
inside the auth store, middleware registered after its routes, a bind mount that never resolved.

---

## Deploying

```bash
git push origin main
vps compose redeploy zHI9vuip7TU9vSuCH71QU
# poll composeStatus until "done"
```

**A gateway redeploy drops the WhatsApp session.** It reconnects from stored credentials, but
not instantly — POST `…/3/connect` with a PAT and poll `GET /api/status` until `connected`
before running live tests, or they fail with a misleading `409`.

Backups run in-container (`ops/backup.sh`) and verify themselves by restoring into a scratch
database. A backup that has never been restored is not a backup.

---

## Traps

Every one of these has already broken something here.

**Build / deploy**

- **`vps compose` reporting `done` means the build finished, not that containers have swapped.**
  Verifying a deploy immediately after can test the *old* container and read as a broken feature.
  Give it a few seconds, or check for something only the new build does.
- **A stray `nul` file breaks `git add -A`** with "short read while indexing nul" — it is a
  Windows reserved device name that some tool in the toolchain writes to as if it were a path.
  The commit then fails while a chained deploy ships the previous build. Now gitignored; it
  happened three times before that.

- **Every workspace manifest must reach the Dockerfile deps stage.** `bun install
  --frozen-lockfile` validates the *whole* workspace, so a missing `package.json` reads as
  lockfile drift and the image refuses to install. This shipped four times.
  `ops/check-dockerfile-manifests.mjs` guards it — and its first version hardcoded
  `packages/*`/`apps/*`, so it missed `compat`. Derive lists from `package.json`, never restate
  them.
- **`public/` is not in Next's standalone output.** It must be copied explicitly in the
  Dockerfile or every static asset 404s in production while working in `next dev`.
- **Next 16 renamed `middleware.ts` → `proxy.ts`.** With the old name the build still prints
  "Proxy (Middleware)", so it looks wired, but Clerk cannot detect it and every `auth()` throws.
- **The Clerk matcher skips static assets by extension.** Anything not in that list falls
  through to `auth.protect()` and 307s to sign-in — silently, if a browser rather than a person
  fetches it. `site.webmanifest` was missing and the PWA manifest redirected to a login page.

**Baileys / gateway**

- **`JSON.stringify(undefined, BufferJSON.replacer)` returns `undefined`**, which becomes SQL
  NULL and aborts the whole insert. This silently prevented credentials from ever persisting —
  the phone reported "can't log in" with nothing in the logs. Filter undefined before writing.
- **Pairing is `creds.me`, not `creds.registered`.** `registered` belongs to the pairing-code
  flow and stays false after a QR pair.
- **Disconnect reason 515 (`restartRequired`) means the scan was ACCEPTED.** Treat it as
  success and reconnect. Misread twice.
- **`connect()` must be idempotent for any state**, not just `connected`. Otherwise pressing
  Connect during `need_scan` opens a second socket, both rotate QRs, and scanning fails.
- **Baileys v7 removed the in-memory store.** There is no "ask the socket for contacts", and
  `resyncAppState` emits nothing on a session that already has sync data. Contacts are derived
  from event traffic into `packages/db`.
- **libsignal can print key material to stdout.** `quiet-signal.ts` diverts console to pino
  before any socket exists. Keep it first.

**Dashboard**

- **`server-only` throws outside a server component.** To run a module that imports it under
  bun — a script that exercises `doctor.ts`, say — pass `--conditions react-server`, which
  resolves the package to its no-op entry.
- **`webhook_hmac` is settable only from the dashboard.** The column exists and the worker
  honours it, but the API's `PUT` never accepts it: HMAC is a wapi addition rather than part of
  the cloned interface. Anything that documents it as an API field is wrong.

**Other**

- **Hono `app.use` only applies to routes registered after it.** Middleware ordering is a real
  bug source here.
- **SSE:** stash cleanup somewhere it actually runs, and never `enqueue` on a closed controller.
- **Windows/git:** a stray `nul` file (from a `> nul` redirect) makes `git add -A` die with
  `mmap failed`. A failed commit followed by a deploy silently ships the *previous* code —
  **always check `git log` after committing.** This has happened twice.

---

## Conventions

- **Comments explain *why*, not *what*.** Most comments in this repo record a decision or a
  trap. Match that density; do not narrate code.
- **Commit per feature**, conventional prefixes, body explains the reasoning. Never push
  unasked.
- **Never restate a list that can be derived** — the Dockerfile check and the typecheck script
  both exist because a hardcoded list drifted.
- Prefer fixing a broken script over documenting the breakage.

---

## Inferred, not verified

State these as inferences if you rely on them (see `PLAN.md` §10):

- The `msgId` sequencing scheme and `pn-from-lid` miss behaviour.
- The ack mapping on `/info` — `0` error, `1` pending, `2` sent, `3` delivered, `4` read. It is
  Baileys' own enum and their example showing `2` for a sent message corroborates it, but the
  mapping itself is not documented.
- UploadX's SDK on Bun is lightly exercised.

---

## Safety

- **Session 3 is a real, live WhatsApp number.** Tests write to *its own* number, never to a
  group. An early probe of mine posted to a real 13-person group by accident; that is why the
  rule is written down rather than remembered.
- Machine credentials (PATs, session keys) are minted here but verified locally against hashed
  Postgres rows — never through Clerk. Clerk guards humans only.
- Session API keys are stored **AES-256-GCM encrypted**, not hashed, because fidelity requires
  returning them in plaintext from the detail route. The lookup column is a hash so auth never
  needs to decrypt.
- Driving WhatsApp this way is against its terms and a number can be banned. Do not add
  anything that increases send volume or looks like evasion without saying so explicitly.
