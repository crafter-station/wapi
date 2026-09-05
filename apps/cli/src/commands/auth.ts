import { hostname } from "node:os";
import type { Command } from "commander";
import { accountClient, context, type Ctx } from "../client.ts";
import { CONFIG_PATH, readConfig, saveProfile, writeConfig } from "../config.ts";
import { bold, dim, EXIT, emit, fail, green, info, table, cell } from "../output.ts";

/**
 * Signing in, out, and finding out who you are.
 *
 * Login is a device flow: the CLI asks for a code, a human approves it in a browser that is
 * already signed in, and the CLI collects the token. A terminal cannot sign in to Clerk, and
 * asking somebody to paste a token they first have to find in a dashboard is a worse first
 * experience than one click.
 */

type StartResponse = {
  expires_in: number;
  interval: number;
  poll_token: string;
  user_code: string;
  verification_url: string;
};

export function registerAuth(program: Command): void {
  program
    .command("login")
    .description("Authorise this machine by approving a code in your browser")
    .option("--no-browser", "print the URL instead of trying to open one")
    .action(async (opts: { browser: boolean }) => {
      const ctx = context(program.opts());
      const start = await fetch(`${ctx.profile.dashboardUrl}/api/cli/start`, {
        body: JSON.stringify({ hostname: hostname() }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }).catch(() => null);

      if (!start?.ok) {
        fail(`Could not reach ${ctx.profile.dashboardUrl}. Is the URL right?`, EXIT.failure);
      }
      const req = (await start.json()) as StartResponse;

      info("");
      info(`  Your code is  ${bold(req.user_code)}`);
      info("");
      info(`  Approve it at ${req.verification_url}`);
      info(dim(`  Expires in ${Math.round(req.expires_in / 60)} minutes.`));
      info("");

      if (opts.browser) await openBrowser(req.verification_url);
      info(dim("  Waiting for approval…"));

      const token = await poll(ctx, req);
      saveProfile(ctx.profileName, { token });

      /**
       * Pin the session now, while there is exactly one.
       *
       * Choosing it fresh on every command would work until a second session exists, and then
       * every command already in somebody's shell history would quietly mean something else.
       */
      const client = accountClient({ ...ctx, profile: { ...ctx.profile, token } });
      const sessions = (await client.sessions.list().catch(() => [])) as { id: number }[];
      if (sessions.length === 1) saveProfile(ctx.profileName, { sessionId: sessions[0]!.id });

      info("");
      info(`${green("✓")} Signed in. Token saved to ${CONFIG_PATH}`);
      if (sessions.length === 1) info(dim(`  Using session ${sessions[0]!.id}.`));
      else if (sessions.length > 1) info(dim("  Pick a session with `wapi use <id>`."));
    });

  program
    .command("logout")
    .description("Forget this machine's credentials")
    .option("--revoke", "also revoke the token server-side, so it cannot be reused")
    .action(async (opts: { revoke?: boolean }) => {
      const ctx = context(program.opts());
      if (!ctx.profile.token) fail("Not signed in.", EXIT.auth);

      if (opts.revoke) {
        /**
         * Revoking the token you are authenticating with works: the call authenticates first and
         * the credential dies immediately after. Best-effort, because forgetting it locally must
         * still happen even if the server is unreachable — otherwise `logout` on a machine you
         * are decommissioning would fail exactly when you need it.
         */
        const client = accountClient(ctx);
        const mine = (await client.tokens.list().catch(() => [])) as {
          id: number;
          name: string;
          revoked_at: string | null;
        }[];
        const match = mine.find((t) => t.name === `cli@${hostname()}` && !t.revoked_at);
        if (match) await client.tokens.revoke(match.id).catch(() => null);
        else info(dim(`  No server-side token named cli@${hostname()} to revoke.`));
      }

      const config = readConfig();
      const profile = config.profiles[ctx.profileName];
      if (profile) {
        delete profile.token;
        delete profile.sessionKeys;
        writeConfig(config);
      }
      info(`${green("✓")} Signed out of profile ${ctx.profileName}.`);
    });

  program
    .command("whoami")
    .description("Show the account, deployment and session in use")
    .action(async () => {
      const ctx = context(program.opts());
      if (!ctx.profile.token) fail("Not signed in. Run `wapi login` first.", EXIT.auth);

      const client = accountClient(ctx);
      const sessions = (await client.sessions.list()) as { id: number; name: string }[];
      const payload = {
        base_url: ctx.profile.baseUrl,
        profile: ctx.profileName,
        session_count: sessions.length,
        session_id: ctx.profile.sessionId ?? null,
      };

      emit(ctx.json, payload, () => {
        table(
          ["", ""],
          [
            ["profile", ctx.profileName],
            ["api", ctx.profile.baseUrl],
            ["session", cell(ctx.profile.sessionId)],
            ["sessions", String(sessions.length)],
          ],
        );
      });
    });

  program
    .command("use")
    .argument("<sessionId>", "the session most commands should act on")
    .description("Pin the session used by session-scoped commands")
    .action(async (raw: string) => {
      const ctx = context(program.opts());
      const id = Number(raw);
      if (!Number.isInteger(id) || id < 1) fail(`Not a session id: ${raw}`, EXIT.usage);

      // Checked rather than trusted: pinning a session that does not exist would fail later, in
      // some unrelated command, with an error that does not mention this decision.
      const client = accountClient(ctx);
      const session = (await client.sessions.get(id).catch(() => null)) as { name?: string } | null;
      if (!session) fail(`No session ${id} on this account.`, EXIT.failure);

      saveProfile(ctx.profileName, { sessionId: id });
      info(`${green("✓")} Using session ${id}${session.name ? dim(` (${session.name})`) : ""}.`);
    });
}

/** Poll until approved or expired, honouring the interval the server asked for. */
async function poll(ctx: Ctx, req: StartResponse): Promise<string> {
  const deadline = Date.now() + req.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.max(1, req.interval) * 1000));

    const res = await fetch(`${ctx.profile.dashboardUrl}/api/cli/poll`, {
      body: JSON.stringify({ poll_token: req.poll_token }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }).catch(() => null);
    if (!res?.ok) continue;

    const body = (await res.json()) as { status: string; token?: string };
    if (body.status === "approved" && body.token) return body.token;
    // `expired` is terminal and distinguishable from `pending` on purpose — waiting out ten
    // minutes on a request that is already dead helps nobody.
    if (body.status === "expired") fail("That code expired. Run `wapi login` again.", EXIT.auth);
  }
  return fail("Timed out waiting for approval.", EXIT.auth);
}

/** Best-effort: a headless box has no browser, and the URL is already on screen. */
async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const { spawn } = await import("node:child_process");
    spawn(command, [url], { detached: true, shell: process.platform === "win32", stdio: "ignore" }).unref();
  } catch {
    // Nothing to say: the URL is printed above, which is the fallback.
  }
}
