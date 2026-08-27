# @wapi/sdk

TypeScript client for the [wapi](https://wapi.crafter.run) WhatsApp REST API.
Zero runtime dependencies — global `fetch`, so Node 18+, Bun and Deno.

## Install

**Vendor it.** npm cannot install a subdirectory of a git repository, and this package lives at
`sdk/typescript` in a monorepo — `npm install github:crafter-station/wapi` resolves the root
package, which is private and not this. That is a package-manager limitation, not something the
repository can route around.

Since the client is dependency-free source, copying it in is a reasonable channel rather than a
workaround:

```bash
npx giget@latest gh:crafter-station/wapi/sdk/typescript/src src/wapi
```

```ts
import { WapiClient } from "./wapi/index.js";
```

Copy `src` and nothing else — `scripts/` beside it is a build tool for this repository and
imports `@wapi/contracts`, which you will not have.

The `.js` extensions resolve to the `.ts` sources under both `nodenext` and `bundler`, so a
vendored copy compiles in an ordinary project with no special compiler flags.

## Usage

```ts
import { WapiClient } from "./wapi/index.js";

const wapi = new WapiClient({ apiKey: process.env.WAPI_KEY! });

await wapi.messages.send({ to: "+51999888777", text: "hello" });

const { items, pagination } = await wapi.contacts.page({ limit: 50 });
const groups = await wapi.groups.list();
await wapi.messages.react(key, "👍");
```

## Two credentials

A **session API key** covers messaging, contacts, groups and media — it identifies the session,
which is why those endpoints take no session id. A **Personal Access Token** covers everything
under `sessions.*`.

They are not interchangeable, and using the wrong one returns `403`, not `401`:

```ts
try {
  await wapi.sessions.list();
} catch (err) {
  if (err instanceof WapiAuthError && err.isWrongCredentialType) {
    // Valid token, wrong kind — a configuration mistake, not a bad secret.
  }
}
```

A client holds exactly one credential. Construct two if you need both.

## Errors

| Class | Status | Carries |
| --- | --- | --- |
| `WapiValidationError` | 422 | `fields` — each rejected field to its messages |
| `WapiAuthError` | 401, 403 | `isWrongCredentialType` |
| `WapiRateLimitError` | 429 | `retryAfter` in seconds |
| `WapiUnavailableError` | 5xx, transport | `isAmbiguous` |
| `WapiError` | anything else | `isSessionNotConnected` for 409 |

All carry `status` and the raw `body`, so nothing is hidden behind the abstraction.

**A failed send is not safely retryable.** A timeout says the request failed, not that the
message was undelivered — retrying sends twice. Reconcile with `messages.info(msgId)`.

## Surface

```
wapi.status()                            wapi.user()

wapi.sessions.list() get() create() update() delete()
wapi.sessions.connection.connect() disconnect() restart() qrCode()
wapi.sessions.keys.regenerate()
wapi.sessions.logs.messages()

wapi.messages.send() info() markRead() react() unreact()
wapi.messages.media.upload() decrypt()

wapi.contacts.list() page() get() onWhatsApp()
wapi.contacts.lid.fromPhone() toPhone()

wapi.groups.list() page() create() metadata()
wapi.groups.participants.list() add() remove()
```

`list()` and `page()` are separate because `?paginated=true` returns a *different shape*, not the
same one with metadata. Keeping them apart means a caller cannot read `data` and get `undefined`.

## Changing the API

`src/types.gen.ts` is generated. After adding or changing a route:

```bash
bun run --cwd sdk/typescript generate   # refresh the types
# then add or update the method in src/resources/
bun ops/check-sdk-in-sync.mjs           # fails if an operation has no method
```

CI runs that last check. See [`../README.md`](../README.md) for why the types are generated but
the surface is not.
