import WapiClient from "@wapi/sdk";
import { resolveProfile, saveProfile, type Profile } from "./config.ts";
import { EXIT, fail } from "./output.ts";

/**
 * Turning config into something that can make requests.
 *
 * One credential does everything. A PAT can read any session's detail, and that response carries
 * the session's API key — so there is no second credential to store, no `--key` flag, and no
 * destructive `regenerate` in the happy path. The CLI fetches a session key when it first needs
 * one and remembers it, because keys change only when somebody rotates them.
 */

export type Ctx = { json: boolean; profileName: string; profile: Profile; yes: boolean };

/** The account-level client. Everything PAT-scoped goes through this. */
export function accountClient(ctx: Ctx): WapiClient {
  if (!ctx.profile.token) {
    fail("Not signed in. Run `wapi login` first.", EXIT.auth);
  }
  return new WapiClient({ apiKey: ctx.profile.token, baseUrl: ctx.profile.baseUrl });
}

/**
 * Which session a session-scoped command acts on.
 *
 * `--session` beats the pinned one, which beats nothing at all. Failing with the fix in the
 * message matters more here than anywhere else: "no session selected" without saying how to
 * select one is the single most annoying thing a CLI can do on first use.
 */
export function sessionId(ctx: Ctx, override?: number): number {
  const id = override ?? ctx.profile.sessionId;
  if (!id) {
    fail(
      "No session selected. Run `wapi sessions list` to see them, then `wapi use <id>` — or pass --session <id>.",
      EXIT.usage,
    );
  }
  return id;
}

/**
 * A client authenticated as one session.
 *
 * The key is fetched through the account client and cached in the profile. Anything holding the
 * token can already fetch every session key on demand, so writing it down adds no exposure that
 * matters — and it saves a round trip on every send.
 */
export async function sessionClient(ctx: Ctx, override?: number): Promise<WapiClient> {
  const id = sessionId(ctx, override);
  const cached = ctx.profile.sessionKeys?.[String(id)];
  if (cached) return new WapiClient({ apiKey: cached, baseUrl: ctx.profile.baseUrl });

  const account = accountClient(ctx);
  const detail = (await account.sessions.get(id)) as { api_key?: string | null };
  if (!detail?.api_key) {
    fail(`Session ${id} has no API key. It may have been deleted.`, EXIT.failure);
  }

  const keys = { ...(ctx.profile.sessionKeys ?? {}), [String(id)]: detail.api_key };
  saveProfile(ctx.profileName, { sessionKeys: keys });
  ctx.profile.sessionKeys = keys;
  return new WapiClient({ apiKey: detail.api_key, baseUrl: ctx.profile.baseUrl });
}

/**
 * Forget a cached session key.
 *
 * Called after `regenerate-key` and whenever a session-scoped call is refused, since a cached key
 * that no longer works would otherwise fail every command until somebody cleared it by hand.
 */
export function forgetSessionKey(ctx: Ctx, id: number): void {
  if (!ctx.profile.sessionKeys?.[String(id)]) return;
  const keys = { ...ctx.profile.sessionKeys };
  delete keys[String(id)];
  saveProfile(ctx.profileName, { sessionKeys: keys });
  ctx.profile.sessionKeys = keys;
}

/** Built once per invocation from the global flags, then handed to whichever command runs. */
export function context(opts: { json?: boolean; profile?: string; yes?: boolean }): Ctx {
  const { name, profile } = resolveProfile(opts.profile);
  return { json: opts.json === true, profile, profileName: name, yes: opts.yes === true };
}
