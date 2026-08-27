# Browser tests

```bash
bunx playwright install chromium          # once
clerk env pull --file apps/web/.env.local # once — see "Credentials" below
bun run --cwd apps/web e2e                # run
bun run --cwd apps/web e2e:ui             # run with Playwright's watch UI
```

Specs are `*.pw.ts`, not `*.spec.ts`: Bun's test runner globs `*.spec.*`, so `bun test` would try
to run them and fail. Two runners, two conventions.

## Credentials

**Real Clerk keys are required, including the secret one.** A syntactically valid dummy gets
through `next build`, which only checks the shape — but `clerkMiddleware` contacts Clerk at
runtime and a fabricated key returns `400 host_invalid` for every page, public ones included. A
real publishable key with a fake secret gets one step further and then fails the handshake.

The first version of this suite "passed" two tests against that JSON error page. An error page
trivially has no horizontal scroll, so the tests were green and worthless. That is the failure
mode to watch for here.

`clerk env pull --file apps/web/.env.local` writes them; add a `NEXT_PUBLIC_`-prefixed copy of the
publishable key, which is what the browser bundle reads. The file is gitignored, and Next loads it
without Playwright passing anything through.

## Why `localhost` and not `127.0.0.1`

Next 16 treats dev resources requested from another host as cross-origin and blocks them,
including the HMR socket — and with that blocked **the page never hydrates**. Every client
component is inert: tabs do not switch, the copy button does nothing. Nothing is wrong with the
app when this happens (production hydrates; that was checked directly before touching anything).

## How sign-in works, and why not the obvious way

`auth.setup.ts` signs in once by **sign-in ticket** and shares the session through
`storageState`. Three simpler approaches were tried and do not work here:

- **Driving the sign-in form.** There is no `/sign-in` route, so `auth.protect()` redirects to
  Clerk's hosted Account Portal on another origin. That form is drivable right up to the point
  where Clerk challenges the sign-in as coming from an unrecognised device — which every fresh
  browser is.
- **Password sign-in via `clerk.signIn`.** Returns `needs_second_factor` on this instance, and the
  helper does not support multi-factor. It returns *without signing in and without throwing*,
  which looks exactly like success until the first protected page redirects.
- **Signing in before Clerk has loaded.** Silently does nothing. The setup waits for
  `window.Clerk.loaded`.

The ticket strategy mints a short-lived token through the backend API and bypasses factors by
design. A consequence worth having: the test account needs no password, so `CLERK_SECRET_KEY` is
the only credential involved.

## What is covered

`/` and `/docs` signed out; signed in, every dashboard page — sessions, tokens, audit, and a
session workspace across overview, messages, contacts, groups, webhooks, doctor, settings and
sandbox. The workspace builds its own fixture by creating a **sandbox** session through the UI,
which needs no phone and no QR — the only reason walking it automatically is possible at all.

One test skips without Redis, and the reason is a real property of the system: **nothing writes
`connected` to Postgres except the webhook worker**, reacting to the gateway's status event over
`wapi:events`. The dashboard's own Connect button talks to the gateway directly and persists
nothing. Without Redis the gateway pairs a sandbox perfectly and the dashboard shows
"disconnected" forever — which is equally true in production if Redis or the worker is down. CI
runs Redis and the worker, so it runs there.

## Known dev-only noise

`next dev` logs `@clerk/clerk-react: You've passed multiple children components to
<SignInButton/>`. Both usages pass exactly one child. Production was checked directly and its
landing page console is clean, so this is a dev-mode artifact, not a bug to chase.

## What these found on their first run

Both invisible to typecheck and to `next build`, which is the argument for having them:

- `AppNav` was one non-wrapping flex row. At 390px its content measured 740px, so **every
  dashboard page** dragged sideways and the account button sat off screen.
- The docs page's mobile grid track had no `minmax(0,1fr)`, so a wide `<pre>` set its own minimum
  and stretched the page instead of scrolling inside itself.
