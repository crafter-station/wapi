import { createDb, cliAuthRequests } from "@wapi/db";
import { generatePollToken, generateUserCode, hashToken } from "@wapi/core";

/**
 * `POST /api/cli/start` — begin a CLI login.
 *
 * **Unauthenticated, deliberately.** The caller is a terminal with no Clerk session; obtaining one
 * is the entire point of the exchange. It creates a pending request and hands back two things:
 *
 *   - `user_code`, short enough to read aloud, which a human types into a signed-in browser.
 *   - `poll_token`, high entropy, which the CLI keeps and which is the only thing that can collect
 *     the token once somebody approves.
 *
 * Splitting them is what makes the short code safe to be short. Guessing it lets an attacker
 * approve a *stranger's* pending request into their own account — which authenticates that
 * stranger's CLI as the attacker, so the CLI prints which account it landed in — but it never
 * yields the token, because collection needs the other half.
 *
 * This lives on the dashboard rather than the public API so the cloned surface stays
 * credential-only. `gh` splits the same way: github.com authenticates, api.github.com works.
 */
export const dynamic = "force-dynamic";

/** Ten minutes. A request nobody approves stops existing rather than lingering. */
const TTL_MS = 10 * 60 * 1000;

export async function POST(req: Request) {
  const url = process.env["DATABASE_URL"];
  if (!url) return Response.json({ error: "Not configured." }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { hostname?: string };
  const hostname = typeof body.hostname === "string" ? body.hostname.slice(0, 80) : null;

  const userCode = generateUserCode();
  const pollToken = generatePollToken();

  const { db, close } = createDb(url, { max: 2 });
  try {
    await db.insert(cliAuthRequests).values({
      expiresAt: new Date(Date.now() + TTL_MS),
      hostname,
      pollTokenHash: hashToken(pollToken),
      userCode,
    });
  } finally {
    await close();
  }

  /**
   * The public origin, not the one this process is bound to.
   *
   * `new URL(req.url).origin` gave `https://0.0.0.0:3000` in production, because behind Traefik
   * the request URL carries the container's bind address — so the CLI printed a link nobody could
   * open. Found by calling the deployed endpoint rather than trusting it.
   *
   * Configuration first, then what the proxy forwarded, then the request as a last resort. The
   * `x-forwarded-*` headers are trustworthy here specifically because nothing reaches this
   * process except through Traefik.
   */
  const forwardedHost = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const forwardedProto = req.headers.get("x-forwarded-proto") ?? "https";
  const origin =
    process.env["WEB_PUBLIC_URL"] ??
    (forwardedHost ? `${forwardedProto}://${forwardedHost}` : new URL(req.url).origin);
  return Response.json({
    expires_in: TTL_MS / 1000,
    // Seconds between polls. The CLI honours it; the poll endpoint also enforces a floor.
    interval: 2,
    poll_token: pollToken,
    user_code: userCode,
    // Pre-filled, so the common path is a click rather than transcription. The code is shown
    // anyway, because a terminal that cannot open a browser still needs to be usable.
    verification_url: `${origin}/cli?code=${userCode}`,
  });
}
