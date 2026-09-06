/**
 * Record the demo the film plays back.
 *
 * Nothing in the film is hand-authored. This drives the *real* CLI and writes down what actually
 * happened — every command, its verbatim output, and what WhatsApp said about each message.
 * Remotion then animates that transcript. Convincing-looking terminal output written by hand works
 * exactly until the CLI changes and then quietly lies, and this is the one artifact people see
 * before they can check.
 *
 * Two passes, because the film has two halves:
 *
 *   **real** — a live WhatsApp session. Messages go to the session's *own number*, which is real
 *   delivery through real WhatsApp while touching nobody else, plus one send to a group named on
 *   the command line. Delivery status is read back per message with `messages info`, so the film
 *   shows WhatsApp's own acknowledgement rather than our claim about it.
 *
 *   **sandbox** — a throwaway sandbox session, for the closing section that shows a fabricated
 *   inbound message firing a genuine webhook. There is no way to fake an inbound on a real
 *   session, and that is exactly the gap the sandbox exists to fill.
 *
 *   node ops/capture-demo.mjs --session 3 --group 120363...@g.us
 *   node ops/capture-demo.mjs --sandbox-only
 *
 * **A real session sends real messages.** Everything targets the session's own number except the
 * one group send, which is why the group has to be named explicitly rather than guessed at — a
 * group send reaches every member.
 *
 * **node, not bun** — and this is not a preference. Playwright drives the browser over a pipe that
 * never connects under Bun: every `chromium.launch()` variant times out after three minutes having
 * apparently started the process, while all three connect immediately under node. The CLI still
 * runs through `bun` as a child process, which is unaffected.
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
const OUT = "apps/video/public/captures";
const ASSETS = "apps/video/public/assets";

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const REAL_SESSION = arg("session");
const GROUP_JID = arg("group");
const SANDBOX_ONLY = argv.includes("--sandbox-only");
const LANDING_ONLY = argv.includes("--landing-only");

if (!TOKEN) {
  console.error("WAPI_TOKEN is required — a Personal Access Token. Mint one with `wapi tokens create`.");
  process.exit(2);
}

/** A throwaway HOME, so a capture run cannot read or disturb a real ~/.wapi/config/config.json. */
const home = mkdtempSync(join(tmpdir(), "wapi-capture-"));
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;

let steps = [];
let sandboxSessionId = 0;

/**
 * Digits that must never reach a capture file.
 *
 * Masking the command label is not enough, and the first real run proved it: a send prints
 * `✓ Sent. msgId 102132 → +51922471582`, so the number went straight into the transcript through
 * the *output* while the label beside it was politely masked. Redaction has to happen on
 * everything captured, not on the parts that were obviously about the number.
 *
 * Populated once the session's identity is known, and applied in `wapi()` to every recorded step.
 */
const redactions = [];

const redact = (text) => {
  let out = text;
  for (const [pattern, replacement] of redactions) out = out.replaceAll(pattern, replacement);
  return out;
};

function cleanup() {
  if (sandboxSessionId) {
    spawnSync("bun", ["apps/cli/src/index.ts", "sessions", "delete", String(sandboxSessionId), "--yes"], {
      env: { ...process.env, HOME: home, USERPROFILE: home, WAPI_BASE_URL: BASE, WAPI_TOKEN: TOKEN },
      stdio: "ignore",
    });
  }
  rmSync(home, { force: true, recursive: true });
}

/**
 * Run one CLI command and write down what happened.
 *
 * `label` is what the film shows being typed, which is not always what runs: a group send needs a
 * JID resolved at runtime, and a raw `120363…@g.us` on screen teaches nobody anything. It is also
 * where the real number is masked, so the film never publishes it.
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

  /*
   * Redact only what gets stored.
   *
   * Redaction exists to keep identifiers out of the capture files, and `capture: false` calls are
   * never written — they exist to be parsed. Redacting them corrupts the thing being parsed: the
   * group JID inside a `messages info` response became `"Bots"`, which is not valid JSON, and the
   * run died one command from the end having already sent every message.
   */
  const stored = capture !== false;
  const raw = stored ? redact(`${proc.stdout ?? ""}${proc.stderr ?? ""}`) : `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  const step = {
    command: stored ? redact(label ?? `wapi ${args.join(" ")}`) : (label ?? `wapi ${args.join(" ")}`),
    durationMs: Date.now() - startedAt,
    exitCode: proc.status ?? -1,
    stdout: raw,
    stdoutPlain: raw.replace(ANSI, ""),
  };
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

/**
 * Upload through the CLI, on camera.
 *
 * The human output of `media upload` is the URL on its own line, so one captured run gives both the
 * frames the film shows and the value the next command needs — no second, invisible upload.
 */
function upload(file, session) {
  const step = wapi(["media", "upload", `${ASSETS}/${file}`, ...session], {
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

/** WhatsApp's numeric acknowledgement, in words. `/info` reports its record, not ours. */
const ACK = { 0: "error", 1: "pending", 2: "sent", 3: "delivered", 4: "read" };

/**
 * The masked form of the session's own number.
 *
 * The film shows a real conversation on a real account, so the digits would otherwise be published
 * permanently. Masked at capture time rather than in the composition: a number that never enters
 * the transcript cannot be leaked by a later change to how the film renders it.
 */
const mask = (number) => {
  const digits = number.replace(/[^\d]/g, "");
  return `+${digits.slice(0, 2)} ${"•".repeat(Math.max(0, digits.length - 5))}${digits.slice(-3)}`;
};

mkdirSync(OUT, { recursive: true });

// --------------------------------------------------------------------------------- the real half
if (REAL_SESSION && !SANDBOX_ONLY && !LANDING_ONLY) {
  console.log(`recording the real demo on session ${REAL_SESSION}…`);
  steps = [];
  const sess = ["--session", REAL_SESSION];
  const thread = [];

  const me = json(["user", ...sess]);
  // `id`, not `jid` — this response is keyed the way WhatsApp's is.
  const own = `+${String(me.id ?? "").split("@")[0]}`;
  const masked = mask(own);
  console.log(`  session identity: ${masked}`);

  /*
   * Register the redactions before a single command runs.
   *
   * Every form the number can appear in: with a `+`, bare, and as a JID. Registered up front rather
   * than filtered afterwards, because a capture file that was written wrong and then cleaned has
   * still existed on disk in the wrong state — and would have been committed if the cleanup step
   * were the thing that got forgotten.
   */
  const digits = own.replace(/[^\d]/g, "");
  redactions.push(
    [`+${digits}`, masked],
    [`${digits}@s.whatsapp.net`, `${masked}@s.whatsapp.net`],
    [digits, masked],
  );

  /** Send, then ask WhatsApp what became of it. */
  const send = (args, { kind, mediaUrl = null, fileName = null, text = null, to, label }) => {
    const step = wapi(["send", "--to", to, ...args, ...sess], { label });
    const msgId = Number(/msgId (\d+)/.exec(step.stdoutPlain)?.[1] ?? 0);
    let ack = null;
    if (msgId) {
      // Read-back, so the film shows WhatsApp's acknowledgement rather than our claim of one.
      const info = json(["messages", "info", String(msgId), ...sess]);
      ack = ACK[info.status] ?? null;
    }
    thread.push({
      ack,
      at: new Date().toISOString(),
      file_name: fileName,
      from_me: true,
      id: String(msgId || thread.length + 1),
      kind,
      media_url: mediaUrl,
      text,
    });
  };

  send(["--text", "hello from wapi"], {
    kind: "text",
    label: `wapi send --to ${masked} --text "hello from wapi"`,
    text: "hello from wapi",
    to: own,
  });

  const photo = upload("photo.png", sess);
  send(["--image", photo, "--text", "the roadmap"], {
    kind: "image",
    label: `wapi send --to ${masked} --image photo.png --text "the roadmap"`,
    mediaUrl: photo,
    text: "the roadmap",
    to: own,
  });

  const sticker = upload("sticker.webp", sess);
  send(["--sticker", sticker], {
    kind: "sticker",
    label: `wapi send --to ${masked} --sticker sticker.webp`,
    mediaUrl: sticker,
    to: own,
  });

  const clip = upload("clip.mp4", sess);
  send(["--video", clip, "--text", "three seconds of proof"], {
    kind: "video",
    label: `wapi send --to ${masked} --video clip.mp4`,
    mediaUrl: clip,
    text: "three seconds of proof",
    to: own,
  });

  const doc = upload("invoice.pdf", sess);
  send(["--document", doc], {
    fileName: "invoice.pdf",
    kind: "document",
    label: `wapi send --to ${masked} --document invoice.pdf`,
    mediaUrl: doc,
    to: own,
  });

  if (GROUP_JID) {
    /*
     * The group list is read but never shown.
     *
     * `wapi groups list` on a real account prints every group it is in — thirteen real group names
     * on the first run of this. The beat exists to say "a group is just another recipient", and the
     * send says that on its own; publishing somebody's group list to make the point is a bad trade.
     * The sandbox section later shows a groups table with invented ones, which is the same beat
     * without the cost.
     */
    const groups = json(["groups", "list", ...sess]);
    const group = groups.find((g) => g.jid === GROUP_JID);
    const name = group?.subject ?? group?.name ?? "the group";
    // The JID appears in the send's own output too, where it is just as identifying.
    redactions.push([GROUP_JID, name]);
    send(["--text", "shipping Friday"], {
      kind: "text",
      label: `wapi send --to "${name}" --text "shipping Friday"`,
      text: "shipping Friday",
      to: GROUP_JID,
    });
  }

  writeFileSync(
    join(OUT, "real-transcript.json"),
    `${JSON.stringify({ base: BASE, capturedAt: new Date().toISOString(), masked, steps }, null, 2)}\n`,
  );
  writeFileSync(join(OUT, "real-thread.json"), `${JSON.stringify(thread, null, 2)}\n`);
  console.log(`  wrote real-transcript.json (${steps.length} steps) and real-thread.json (${thread.length})`);
}

// ------------------------------------------------------------------------------ the sandbox half
if (!LANDING_ONLY) {
console.log("recording the sandbox section…");
steps = [];

const created = json(["sandbox", "create", "--name", "demo-capture", "--use"]);
sandboxSessionId = created.id;
steps.push({
  command: "wapi sandbox create --use",
  durationMs: 0,
  exitCode: 0,
  stdout: `✓ Sandbox session ${created.id} created.\n  ${created.phone_number ?? ""}\n`,
  stdoutPlain: `✓ Sandbox session ${created.id} created.\n  ${created.phone_number ?? ""}\n`,
});

wapi(["sessions", "connect", String(sandboxSessionId)]);
// The groups beat lives here rather than on the real session, where the same command prints every
// group the account is in. These two are invented, and printing them costs nothing.
wapi(["groups", "list"]);
wapi(["sandbox", "inbound", "and a reply"], { label: `wapi sandbox inbound "and a reply"` });
const sandboxThread = json(["sandbox", "thread"]);

writeFileSync(
  join(OUT, "sandbox-transcript.json"),
  `${JSON.stringify({ base: BASE, capturedAt: new Date().toISOString(), steps }, null, 2)}\n`,
);
writeFileSync(join(OUT, "sandbox-thread.json"), `${JSON.stringify(sandboxThread, null, 2)}\n`);
console.log(`  wrote sandbox-transcript.json (${steps.length} steps) and sandbox-thread.json`);
}

// ------------------------------------------------------------------------ the site, as it renders
try {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  /*
   * 1440 CSS pixels at 2x, so 2880 real ones.
   *
   * This was 1x when the film showed the page as a small tilted plane. It now opens full bleed at
   * 2560 wide, where a 1440px capture is upscaled 1.8x and visibly soft — the first thing anybody
   * sees, blurred. JPEG keeps it near 700 KB rather than the 866 KB the PNG cost at this size.
   */
  const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { height: 900, width: 1440 } });
  await page.goto(WEB, { waitUntil: "networkidle" });
  await page.screenshot({ fullPage: true, path: join(OUT, "landing.jpg"), quality: 82, type: "jpeg" });
  await browser.close();
  console.log(`  wrote landing.jpg`);
} catch (err) {
  // Not fatal: the transcript is the part that cannot be recreated by hand.
  console.error(`  landing capture skipped — ${err instanceof Error ? err.message : String(err)}`);
}

cleanup();
console.log("\nok — the demo is recorded");
