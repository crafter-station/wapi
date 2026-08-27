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

## What is covered, and what is not

Only `/` and `/docs`. Everything else is behind `auth.protect()` (see `src/proxy.ts`), and
rendering a protected page needs a signed-in session.

**The signed-in dashboard has still never been rendered by a test.** Sessions, messages, contacts,
groups, webhooks, doctor, settings, audit, tokens and the sandbox chat are covered by typecheck
and by `next build` in CI — which catch a broken import or an unprerenderable page, but not a
component that throws when it meets real data.

To close it: add `@clerk/testing`, call `clerkSetup()` in a global setup and
`setupClerkTestingToken()` per test, and sign in a seeded user. Those specs need a database, so
the job would boot Postgres the way the `sandbox` job already does.

That is a deliberate not-yet. It needs credentials this repository does not have, and a green
suite that silently skipped the whole dashboard would be worse than an honest gap.

## What these found on their first run

Both invisible to typecheck and to `next build`, which is the argument for having them:

- `AppNav` was one non-wrapping flex row. At 390px its content measured 740px, so **every
  dashboard page** dragged sideways and the account button sat off screen.
- The docs page's mobile grid track had no `minmax(0,1fr)`, so a wide `<pre>` set its own minimum
  and stretched the page instead of scrolling inside itself.
