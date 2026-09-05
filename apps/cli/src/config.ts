import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where the CLI keeps what it knows.
 *
 * `~/.wapi/config/config.json` on every platform — the same path on Windows as on Linux, because
 * a person who has to find this file should be able to guess where it is rather than remember
 * which OS convention applies.
 *
 * **It holds secrets in plaintext**, mode `0600`. An OS keychain would be three different
 * platform APIs with no Bun binding, which for a compiled single binary means shelling out to
 * `security` / `secret-tool` / PowerShell — a lot of surface, and one more thing to break on the
 * platform nobody tested. `gh` makes the same trade for the same reason. The honest consequence:
 * anything that can read your home directory can read this token, so revoke it if a machine is
 * lost. `wapi tokens list` shows every machine that holds one.
 */
export const CONFIG_PATH = join(homedir(), ".wapi", "config", "config.json");

export const DEFAULT_BASE_URL = "https://api.wapi.crafter.run";

/** Where the browser half of the device flow lives. Not the API — see `apps/web/src/app/cli`. */
export const DEFAULT_DASHBOARD_URL = "https://wapi.crafter.run";

export type Profile = {
  baseUrl: string;
  dashboardUrl: string;
  token?: string;
  /**
   * The session most commands act on, set by `wapi use` or pinned at login when the account has
   * exactly one. Pinned rather than inferred per-invocation: inferring works fine until a second
   * session exists, and then every existing command silently changes meaning.
   */
  sessionId?: number;
  /**
   * Session API keys, by session id.
   *
   * Fetched on demand and kept because they change only on `regenerate-key`. This adds no
   * exposure that matters — anything holding the token can already fetch every session key — and
   * saves a round trip on every session-scoped command.
   */
  sessionKeys?: Record<string, string>;
};

export type Config = { current: string; profiles: Record<string, Profile> };

const EMPTY: Config = {
  current: "default",
  profiles: { default: { baseUrl: DEFAULT_BASE_URL, dashboardUrl: DEFAULT_DASHBOARD_URL } },
};

export function readConfig(): Config {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
    if (!parsed.profiles || typeof parsed.profiles !== "object") return structuredClone(EMPTY);
    return { current: parsed.current ?? "default", profiles: parsed.profiles as Config["profiles"] };
  } catch {
    // Missing, unreadable or corrupt all mean the same thing to a first run: start clean. A CLI
    // that refuses to work because its config is malformed is a CLI you cannot use to fix it.
    return structuredClone(EMPTY);
  }
}

export function writeConfig(config: Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    // `writeFileSync`'s mode only applies when it creates the file, so an existing one keeps its
    // old permissions. Setting it explicitly is what makes the 0600 promise true on rewrite.
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // Windows has no POSIX mode. Nothing to enforce, nothing to report.
  }
}

/**
 * The profile in play, with environment variables layered on top.
 *
 * Env beats file, always: it is how CI and a scratch shell point at a different deployment
 * without editing anything, and how the test suite drives a locally booted stack.
 */
export function resolveProfile(name?: string): { config: Config; name: string; profile: Profile } {
  const config = readConfig();
  const resolved = name ?? process.env["WAPI_PROFILE"] ?? config.current ?? "default";
  const stored = config.profiles[resolved] ?? {
    baseUrl: DEFAULT_BASE_URL,
    dashboardUrl: DEFAULT_DASHBOARD_URL,
  };

  const profile: Profile = {
    ...stored,
    baseUrl: process.env["WAPI_BASE_URL"] ?? stored.baseUrl ?? DEFAULT_BASE_URL,
    dashboardUrl: process.env["WAPI_DASHBOARD_URL"] ?? stored.dashboardUrl ?? DEFAULT_DASHBOARD_URL,
    token: process.env["WAPI_TOKEN"] ?? stored.token,
  };
  const sessionFromEnv = Number(process.env["WAPI_SESSION"]);
  if (Number.isInteger(sessionFromEnv) && sessionFromEnv > 0) profile.sessionId = sessionFromEnv;

  return { config, name: resolved, profile };
}

/** Persist changes to one profile without disturbing the others. */
export function saveProfile(name: string, patch: Partial<Profile>): void {
  const config = readConfig();
  const existing = config.profiles[name] ?? {
    baseUrl: DEFAULT_BASE_URL,
    dashboardUrl: DEFAULT_DASHBOARD_URL,
  };
  config.profiles[name] = { ...existing, ...patch };
  config.current = config.current || name;
  writeConfig(config);
}
