/**
 * Record the demo the video plays back.
 *
 * Nothing in the film is hand-authored. This drives the *real* CLI against a *real* sandbox
 * session and writes down what actually happened — every command, its real output, and how long
 * it took — plus the resulting sandbox thread and a capture of the live landing page. Remotion
 * then animates that transcript.
 *
 * The alternative is writing convincing-looking terminal output by hand, which works exactly
 * until the CLI changes and then quietly becomes a lie. This repo already refuses that trade for
 * the SDKs, the CLI and the docs; a marketing video is a worse place to start making it, because
 * it is the one artifact people see before they can check.
 *
 * **Safe to run against production.** Everything happens on a sandbox session: invented contacts,
 * invented groups, numbers in the unassigned `+999` range. It creates one and deletes it at the
 * end. It never touches a real session, and it captures only the public landing page — no
 * dashboard, so no real number can appear on screen.
 *
 *   node ops/capture-demo.mjs
 *
 * **node, not bun** — and this is not a preference. Playwright drives the browser over a pipe, and
 * under Bun that transport never connects: every `chromium.launch()` variant here times out after
 * three minutes having apparently started the process. Under node all three connect immediately.
 * The CLI still runs through `bun` as a child process, which is unaffected.
 *
 * Env: WAPI_TOKEN (a Personal Access Token, required), WAPI_BASE_URL, WEB_URL.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env["WAPI_BASE_URL"] ?? "https://api.wapi.crafter.run";
const WEB = process.env["WEB_URL"] ?? "https://wapi.crafter.run";
const TOKEN = process.env["WAPI_TOKEN"] ?? "";
const OUT = "apps/video/captures";
const ASSETS = "apps/video/assets";

if (!TOKEN) {
  console.error("WAPI_TOKEN is required — a Personal Access Token. Mint one with `wapi tokens create`.");
  process.exit(2);
}

/** A throwaway HOME, so a capture run cannot read or disturb a real ~/.wapi/config/config.json. */
const home = mkdtempSync(join(tmpdir(), "wapi-capture-"));

/** ANSI, stripped. Kept alongside the raw output rather than replacing it: the raw form carries
 * the CLI's own emphasis, and the film may want to honour or ignore it. */
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;

const steps = [];

/**
 * Run one CLI command and write down what happened.
 *
 * `label` is what the film shows being typed, which is not always what runs: the group send needs
 * a JID resolved at runtime, and showing a raw `120363…@g.us` on screen teaches nobody anything.
 */
function wapi(args, { label, capture } = {}) {
  const startedAt = Date.now();
  const proc = spawnSync("bun", ["apps/cli/src/index.ts", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      // MSYS rewrites `/api/...` arguments on Windows; the CLI recovers but warns, and the warning
      // would end up on screen.
      MSYS_NO_PATHCONV: "1",
      USERPROFILE: home,
      WAPI_BASE_URL: BASE,
      WAPI_TOKEN: TOKEN,
    },
  });

  const raw = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  const step = {
    command: label ?? `wapi ${args.join(" ")}`,
    durationMs: Date.now() - startedAt,
    exitCode: proc.status ?? -1,
    stdout: raw,
    stdoutPlain: raw.replace(ANSI, ""),
  };

  // `capture: false` marks plumbing the film does not show — resolving a JID, reading ids back.
  if (capture !== false) steps.push(step);

  if (step.exitCode !== 0) {
    console.error(`  FAILED  ${step.command}\n${step.stdoutPlain}`);
    cleanup();
    process.exit(1);
  }
  console.log(`  ok  ${step.command}`);
  return step;
}

/** The same, but parsed — for values the script needs rather than values the film shows. */
function json(args) {
  const step = wapi([...args, "--json"], { capture: false });
  try {
    return JSON.parse(step.stdoutPlain);
  } catch {
    console.error(`could not parse --json from: wapi ${args.join(" ")}\n${step.stdoutPlain}`);
    cleanup();
    process.exit(1);
  }
}

let sessionId = 0;

function cleanup() {
  if (sessionId) {
    spawnSync("bun", ["apps/cli/src/index.ts", "sessions", "delete", String(sessionId), "--yes"], {
      env: { ...process.env, HOME: home, USERPROFILE: home, WAPI_BASE_URL: BASE, WAPI_TOKEN: TOKEN },
      stdio: "ignore",
    });
  }
  rmSync(home, { force: true, recursive: true });
}

mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------------------- the demo itself
console.log("recording the demo…");

const created = json(["sandbox", "create", "--name", "demo-capture", "--use"]);
sessionId = created.id;
steps.push({
  command: "wapi sandbox create --use",
  durationMs: 0,
  exitCode: 0,
  stdout: `✓ Sandbox session ${created.id} created.\n  ${created.phone_number ?? ""}\n`,
  stdoutPlain: `✓ Sandbox session ${created.id} created.\n  ${created.phone_number ?? ""}\n`,
});

wapi(["sessions", "connect", String(sessionId)]);

const to = `+999${String(sessionId).padStart(8, "0")}001`;
wapi(["send", "--to", to, "--text", "hello from wapi"]);

/**
 * Upload through the CLI, on camera.
 *
 * The human output of `media upload` is the URL on its own line, so one captured run gives both
 * the frames the film shows and the value the next command needs — no second, invisible upload.
 */
function upload(file) {
  const step = wapi(["media", "upload", `${ASSETS}/${file}`], {
    label: `wapi media upload ${file}`,
  });
  const lines = step.stdoutPlain.trim().split(/\r?\n/);
  const url = lines[lines.length - 1]?.trim() ?? "";
  if (!url.startsWith("http")) {
    console.error(`upload of ${file} returned no URL:\n${step.stdoutPlain}`);
    cleanup();
    process.exit(1);
  }
  return url;
}

wapi(["send", "--to", to, "--image", upload("photo.png"), "--text", "the roadmap"]);
wapi(["send", "--to", to, "--sticker", upload("sticker.webp")]);
wapi(["send", "--to", to, "--video", upload("clip.mp4"), "--text", "three seconds of proof"]);
wapi(["send", "--to", to, "--document", upload("invoice.pdf")]);

// Groups: the JID is resolved here but never shown, because a raw @g.us teaches nobody anything.
const groupsStep = wapi(["groups", "list"]);
// Parsed separately rather than running the command twice: the film shows the table a person
// sees, and the script needs the JID behind it.
const groups = json(["groups", "list"]);
const group = groups[0];
if (!group) {
  console.error(`no groups in the sandbox directory:\n${groupsStep.stdoutPlain}`);
  cleanup();
  process.exit(1);
}
wapi(["send", "--to", group.jid, "--text", "shipping Friday"], {
  label: `wapi send --to "${group.subject ?? "Sandbox Team"}" --text "shipping Friday"`,
});

wapi(["sandbox", "inbound", "and a reply"]);

const thread = json(["sandbox", "thread"]);

writeFileSync(
  join(OUT, "transcript.json"),
  `${JSON.stringify({ base: BASE, capturedAt: new Date().toISOString(), sessionId, steps }, null, 2)}\n`,
);
writeFileSync(join(OUT, "thread.json"), `${JSON.stringify(thread, null, 2)}\n`);
console.log(`  wrote ${OUT}/transcript.json (${steps.length} steps) and thread.json (${thread.length} messages)`);

// ------------------------------------------------------------------------ the site, as it renders
try {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  /*
   * 1440 wide at 1x, as JPEG.
   *
   * At 2x this came out 2880x6264 and 866 KB, which is a lot of binary to carry in git for a plane
   * the film shows tilted and partly blurred. 1440 leaves headroom for a slight push-in at the
   * film's 1120px width and lands around 320 KB. JPEG rather than PNG because a page of
   * anti-aliased text photographs fine and PNG does not compress it.
   */
  const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { height: 900, width: 1440 } });
  await page.goto(WEB, { waitUntil: "networkidle" });
  // Full page, so the film can pan down it rather than recording a scroll whose cadence it would
  // then have to fight.
  await page.screenshot({ fullPage: true, path: join(OUT, "landing.jpg"), quality: 82, type: "jpeg" });
  await browser.close();
  console.log(`  wrote ${OUT}/landing.jpg`);
} catch (err) {
  // Not fatal: the transcript is the part that cannot be recreated by hand.
  console.error(`  landing capture skipped — ${err instanceof Error ? err.message : String(err)}`);
}

cleanup();
console.log("\nok — the demo is recorded");
