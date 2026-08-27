# wapi SDKs

Client libraries for the wapi API. One directory per language.

| Language | Path | Status |
| --- | --- | --- |
| TypeScript | [`typescript/`](typescript) | usable |
| Python | [`python/`](python) | usable |

## Installing

Neither client is published to a registry — they live in this repository, so installation pulls
from GitHub. The two ecosystems differ in how well they support that, and the instructions below
are the ones that were actually run rather than the ones that look plausible.

### Python

pip understands git subdirectories, so this is a normal install:

```bash
pip install "git+https://github.com/crafter-station/wapi.git#subdirectory=sdk/python"
```

Pin to a commit or tag for anything you deploy — `main` moves:

```bash
pip install "git+https://github.com/crafter-station/wapi.git@v0.1.0#subdirectory=sdk/python"
```

### TypeScript

**npm cannot install a subdirectory of a git repository.** `npm install github:crafter-station/wapi`
resolves the *root* package — this monorepo, which is private and not the SDK. That is a
limitation of the package manager, not something the repository can work around.

So vendor the source. It is dependency-free TypeScript, which makes copying it a reasonable
distribution channel rather than a workaround:

```bash
npx giget@latest gh:crafter-station/wapi/sdk/typescript/src src/wapi
```

Then import it as local code:

```ts
import { WapiClient } from "./wapi/index.js";
```

Copy `sdk/typescript/src` and nothing else. `scripts/` next to it is a build tool for this
repository — it imports `@wapi/contracts` and Node types a consumer does not have, and pulling
it in is the difference between a clean compile and eight errors.

The `.js` extensions in those imports are deliberate and point at `.ts` sources. TypeScript
resolves them under both `nodenext` and `bundler`, so a vendored copy compiles in an ordinary
project. `.ts` specifiers would need `allowImportingTsExtensions`, which forces `noEmit` on
whoever consumes it — verified by trying it.

## The shape every SDK should follow

These exist so a caller does not have to know the API's quirks. Ports to other languages should
reproduce the *decisions* below, not just the endpoints — an SDK that faithfully exposes the
awkwardness has not earned its place.

**Types are generated, ergonomics are written.** The OpenAPI document at
`https://api.wapi.crafter.run/openapi.json` is emitted from the Zod contracts the server
validates against, so it cannot drift from the implementation. Generate types from it. Do **not**
generate the method surface: `operationId`s are mechanical path transliterations
(`postApiWhatsappSessionsWhatsappSessionRegenerateKey`), and every generator derives names from
them. The ergonomic surface is worth writing by hand.

**Group by resource, nest sub-resources.** `sessions.keys.regenerate(id)` reads better than
thirty flat functions, and `sessions.connection.` lists exactly what you can do to a live socket.

**Do not unwrap `data` centrally.** There are five success envelopes:

| Shape | Where |
| --- | --- |
| `{success, data}` | most routes |
| `{status}` — *no `success` key* | `GET /api/status` |
| `{success, api_key}` — top level | `POST …/regenerate-key` |
| `{success, publicUrl}` — top level | `POST /api/upload`, `/api/decrypt-media` |
| `204`, no body | `DELETE /api/whatsapp-sessions/{id}` |

A single `unwrap(res.data)` is wrong for four of them.

**Map all three failure envelopes.** Which one arrives says *where* it failed — a route handler
sets `error`, middleware sets `message`, and the throttler emits `{message, retry_after}` with no
`success` key at all. Read both keys; a client that reads one loses half the failures and logs
`undefined`.

**Distinguish `403` from `401`.** `403` means the credential was valid but the wrong *kind* — a
session key on an account route, or a PAT on a session route. That is a configuration mistake,
not a bad secret.

**Say that sends are not safely retryable.** A timeout means the request failed, not that the
message was undelivered. Retrying blindly sends twice.

## Keeping an SDK current

`ops/check-sdk-in-sync.mjs` runs in CI and fails when generated types are stale or an operation
has no method. Extend it when adding a language; a rule nobody enforces is a rule that drifts.
