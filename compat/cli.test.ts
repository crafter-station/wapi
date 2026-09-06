import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The CLI, driven as a user drives it.
 *
 * Against the **compiled binary**, not the TypeScript source, because that is the artifact people
 * install and compilation is where a Bun CLI breaks — bundling changes how dynamic imports and
 * `import.meta` behave, and a suite that ran the source would prove the wrong thing.
 *
 * This is also the only check that can catch a lying coverage table. `check-cli-in-sync.mjs`
 * proves a command *exists* for every operation; nothing there proves `groups leave` calls the
 * leave endpoint rather than sitting there printing a tick. These tests run commands and read
 * what the server did.
 *
 * Everything happens against a **sandbox**, which is what makes it safe to run unattended: the
 * contacts are invented, the groups are invented, and nothing reaches a real person.
 */
const BASE = process.env["WAPI_BASE_URL"] ?? "http://127.0.0.1:3101";
const BIN = process.env["WAPI_CLI_BIN"] ?? "";
const PAT = process.env["WAPI_PAT"] ?? "";

/**
 * Needs a built binary and a PAT. Skipping is honest — a suite that silently tested the source
 * would be worse than one that says it did not run.
 */
const CAN_RUN = Boolean(BIN && PAT);
const d = CAN_RUN ? describe : describe.skip;

/**
 * Whether this deployment has object storage.
 *
 * Probed rather than configured, exactly as `compat/sandbox.test.ts` does it. CI runs Postgres and
 * Redis but no bucket, so `/api/upload` correctly 503s there — a test that failed on it would be
 * reporting a missing dependency as a broken command.
 *
 * Top-level await: `skipIf` is evaluated when the tests are defined, not when they run.
 */
const HAS_STORAGE = CAN_RUN
  ? await fetch(`${BASE}/health`)
      .then((r) => r.json() as Promise<{ storage?: boolean }>)
      .then((h) => h.storage === true)
      .catch(() => false)
  : false;

/** A throwaway HOME, so the suite cannot read or disturb a real `~/.wapi/config/config.json`. */
let home = "";

beforeAll(() => {
  if (!CAN_RUN) return;
  home = mkdtempSync(join(tmpdir(), "wapi-cli-"));
});

afterAll(() => {
  if (home) rmSync(home, { force: true, recursive: true });
});

type Result = { code: number; stderr: string; stdout: string };

/** Run the binary with an isolated HOME and the profile pointed at the local stack. */
async function wapi(...args: string[]): Promise<Result> {
  const proc = Bun.spawn([BIN, "--profile", "test", "-y", ...args], {
    env: {
      ...process.env,
      HOME: home,
      // MSYS rewrites `/api/...` arguments on Windows; the CLI recovers, but the warning it
      // prints would be noise here.
      MSYS_NO_PATHCONV: "1",
      USERPROFILE: home,
      WAPI_BASE_URL: BASE,
      WAPI_TOKEN: PAT,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stderr, stdout };
}

/** Most assertions are about data, so most calls want the parsed `--json` payload. */
async function json<T>(...args: string[]): Promise<T> {
  const res = await wapi(...args, "--json");
  expect([args.join(" "), res.code]).toEqual([args.join(" "), 0]);
  return JSON.parse(res.stdout) as T;
}

let sessionId = 0;

d("the CLI", () => {
  beforeAll(async () => {
    const created = await json<{ id: number }>("sandbox", "create", "--name", "cli-suite", "--use");
    sessionId = created.id;
    await wapi("sessions", "connect");
  });

  test("reports a version and a helpful exit code", async () => {
    expect((await wapi("--version")).code).toBe(0);

    // Usage errors are `2`, not commander's default `1` — scripts branch on this.
    expect((await wapi("sessions", "not-a-command")).code).toBe(2);

    // A credential problem is `3`, distinct from a request that simply failed.
    const noToken = Bun.spawn([BIN, "--profile", "empty", "whoami"], {
      env: { ...process.env, HOME: home, USERPROFILE: home, WAPI_TOKEN: "" },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(await noToken.exited).toBe(3);
  });

  test("a sandbox pairs, and the CLI waits for it rather than guessing", async () => {
    const status = await json<{ status: string }>("status");
    expect(status.status).toBe("connected");
  });

  test("sends, and the message comes back in the thread", async () => {
    const to = `+999${String(sessionId).padStart(8, "0")}001`;
    const sent = await json<{ msgId: number }>("send", "--to", to, "--text", "from the suite");
    expect(sent.msgId).toBeGreaterThan(0);

    const thread = await json<{ from_me: boolean; text: string }[]>("sandbox", "thread");
    expect(thread.find((m) => m.text === "from the suite")?.from_me).toBe(true);
  });

  test("inbound arrives from the other direction", async () => {
    await wapi("sandbox", "inbound", "a reply");
    const thread = await json<{ from_me: boolean; text: string }[]>("sandbox", "thread");
    // Direction is the whole point: a thread missing inbound shows half a conversation.
    expect(thread.find((m) => m.text === "a reply")?.from_me).toBe(false);
  });

  test("the directory is real, not a stub that prints nothing", async () => {
    const contacts = await json<{ name: string }[]>("contacts", "list");
    expect(contacts.length).toBe(5);
    expect(contacts.map((c) => c.name)).toContain("Ada");

    const groups = await json<{ jid: string }[]>("groups", "list");
    expect(groups.length).toBe(2);
  });

  test("group commands reach the group endpoints, not just the exit code", async () => {
    const [group] = await json<{ jid: string }[]>("groups", "list");

    const link = await json<{ inviteLink: string }>("groups", "invite-link", group!.jid);
    expect(link.inviteLink).toStartWith("https://chat.whatsapp.com/");

    // Round trip: the code this returned has to be the code `by-invite` accepts.
    const code = link.inviteLink.split("/").pop()!;
    const found = await json<{ id: string }>("groups", "by-invite", code);
    expect(found.id).toBe(group!.jid);

    await wapi("groups", "settings", group!.jid, "--subject", "Renamed by the suite");
    const meta = await json<{ subject: string }>("groups", "metadata", group!.jid);
    expect(meta.subject).toBe("Renamed by the suite");
  });

  test("contact writes are read back", async () => {
    const contacts = await json<{ jid: string }[]>("contacts", "list");
    const target = contacts[1]!.jid;

    await wapi("contacts", "save", target, "--name", "Renamed");
    const after = await json<{ jid: string; name: string }[]>("contacts", "list");
    expect(after.find((c) => c.jid === target)?.name).toBe("Renamed");
  });

  test.skipIf(!HAS_STORAGE)("upload prints the URL, which is the whole point of the command", async () => {
    /**
     * This shipped broken. The SDK returns the URL as a string; the command cast it to
     * `{ publicUrl?: string }` and read `.publicUrl` off it, which is always `undefined` on a
     * string — so every successful upload printed "Uploaded, but no URL came back". The cast is
     * what stopped the compiler from saying so, and nothing here ran the command.
     *
     * **This does not run in CI**, which has no bucket, so be clear about what covers it. The
     * assertion below runs anywhere storage exists. In practice the standing guard is
     * `ops/capture-demo.mjs`, which uses `media upload` for real against production and aborts if
     * the output is not a URL — which is how the bug was found. `integration.test.ts` covers
     * `/api/upload` itself, but over HTTP, so it could never have seen a CLI-side cast.
     */
    const file = join(home, "upload.txt");
    writeFileSync(file, "wapi upload test", "utf8");

    const res = await json<{ publicUrl: string }>("media", "upload", file);
    expect(res.publicUrl).toMatch(/^https?:\/\//);

    // And the human form prints it bare, so it can be piped or copied.
    const human = await wapi("media", "upload", file);
    expect(human.code).toBe(0);
    expect(human.stdout.trim()).toMatch(/^https?:\/\//);
  });

  test("tokens are minted once and revoke immediately", async () => {
    const created = await json<{ id: number; token: string }>("tokens", "create", "suite");
    expect(created.token).toStartWith("wapi_pat_");

    const listed = await json<{ id: number }[]>("tokens", "list");
    expect(listed.some((t) => t.id === created.id)).toBe(true);

    expect((await wapi("tokens", "revoke", String(created.id))).code).toBe(0);
  });

  test("the audit log has recorded this suite's own calls", async () => {
    const page = await json<{ data: { path: string }[]; total: number }>("audit", "list");
    expect(page.total).toBeGreaterThan(0);
    // Proof the commands above went over HTTP rather than being faked locally.
    expect(page.data.some((r) => r.path.startsWith("/api/"))).toBe(true);
  });

  test("doctor reports on a healthy session", async () => {
    const res = await json<{ checks: { name: string; state: string }[]; verdict: string }>("doctor");
    expect(res.checks.find((c) => c.name === "Connection")?.state).toBe("ok");
    // Identity used to read a field that does not exist and reported "unknown" for a healthy
    // session, which is the kind of thing only running the command finds.
    expect(res.checks.find((c) => c.name === "Identity")?.state).toBe("ok");
  });

  test("refuses a destructive command off a TTY without --yes", async () => {
    const proc = Bun.spawn([BIN, "--profile", "test", "sessions", "delete", String(sessionId)], {
      env: { ...process.env, HOME: home, USERPROFILE: home, WAPI_BASE_URL: BASE, WAPI_TOKEN: PAT },
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    });
    // Auto-confirming in a script is how a cron job deletes a live session; refusing is the point.
    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain("--yes");
  });
});
