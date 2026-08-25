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
| `ops/` | — | backup, restore, CI guards |

The gateway is Node, not Bun, because Baileys' WASM Signal bridge needs it. Everything else is
Bun. Do not "unify" this.

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
