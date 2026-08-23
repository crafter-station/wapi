/**
 * PLAN.md §8 phase 1a — the empirical test that gates the whole project.
 *
 * Since 2026-06-30 WhatsApp has demanded a real WebAuthn assertion during device linking
 * for some accounts. whatsmeow shipped support in 31 hours; Baileys' PR #2689 was closed
 * unmerged on 2026-08-20. WasenderAPI's entire passkey surface — including a Device Link
 * Helper Chrome extension — was created 2026-07-09, nine days after the change.
 *
 * So: can Baileys still pair a real number by QR?
 *
 *   - Pairs           -> passkey stays deferred to Tier 2, the walking skeleton proceeds.
 *   - Refused a scan  -> the three-day passkey spike becomes the critical path.
 *
 * Auth state is deliberately throwaway (file-based, gitignored). The Postgres store is
 * phase 2, and it will be designed better for having watched a real session's key churn.
 *
 * Run:  cd apps/gateway && bun run pair
 *       bun run pair --resume    keep existing auth state instead of pairing fresh
 *       bun run pair --logout    unlink the device once paired, instead of leaving it
 */
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} from "baileys";
import type { ConnectionState, WASocket } from "baileys";
import type { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import pino from "pino";
import { resolve } from "node:path";
import { existsSync, rmSync } from "node:fs";

const AUTH_DIR = resolve(import.meta.dirname, "../.auth-scratch");

/**
 * Phase 1a asks whether a *fresh* link succeeds, so we start from nothing every run.
 * A half-finished previous run leaves partial creds behind, and Baileys then tries to
 * RESTORE that dead session instead of pairing — an immediate 401 with no QR, which reads
 * exactly like a refusal but is not one.
 */
const RESUME = process.argv.includes("--resume");
const LOGOUT_AFTER = process.argv.includes("--logout");

const logger = pino({ level: process.env["BAILEYS_LOG"] ?? "silent" });
const line = (s = "") => console.log(s);
const step = (s: string) => console.log(`\n── ${s}`);

const observed = {
  qrCount: 0,
  pairedAt: null as string | null,
  restartsHandled: 0,
  passkeyDemanded: false,
  reachoutTimeLock: null as unknown,
  lastDisconnect: null as { code?: number; reason?: string; message?: string } | null,
};

let saveCreds: () => Promise<void>;
let waVersion: [number, number, number];

async function connect(attempt: number): Promise<void> {
  const { state, saveCreds: save } = await useMultiFileAuthState(AUTH_DIR);
  saveCreds = save;

  const sock: WASocket = makeWASocket({
    version: waVersion,
    auth: state,
    logger,
    // PLAN.md §5: v7 silently flipped this to true; not in the migration guide.
    syncFullHistory: false,
    // WIN32/DARWIN draw a 428 before the QR is ever shown (Baileys #2677).
    browser: Browsers.ubuntu("Chrome"),
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (u: Partial<ConnectionState>) => {
    const { connection, lastDisconnect, qr, isNewLogin } = u;

    // v7 surfaces the error-463 Reachout Timelock as first-class connection state —
    // the structural rate limit that penalises unofficial clients (PLAN.md §0).
    const rtl = (u as Record<string, unknown>)["reachoutTimeLock"];
    if (rtl) {
      observed.reachoutTimeLock = rtl;
      step("Reachout Timelock reported");
      line(`  ${JSON.stringify(rtl)}`);
    }

    if (qr) {
      observed.qrCount += 1;
      step(`QR code #${observed.qrCount} — scan with WhatsApp → Linked devices`);
      qrcode.generate(qr, { small: true });
      line("  (WhatsApp rotates the QR roughly every 20s; a few regenerations are normal.)");
    }

    if (connection === "connecting") step(attempt === 1 ? "Connecting…" : `Reconnecting (attempt ${attempt})…`);

    if (connection === "open") {
      observed.pairedAt = new Date().toISOString();
      step("PAIRED — connection open");
      line(`  jid   ${sock.user?.id ?? "?"}`);
      line(`  lid   ${sock.user?.lid ?? "(none reported)"}`);
      line(`  name  ${sock.user?.name ?? "?"}`);
      line(`  new login: ${isNewLogin ? "yes" : "no (restored from saved creds)"}`);
      void finish(sock);
    }

    if (connection === "close") {
      const err = lastDisconnect?.error as Boom | undefined;
      const code = err?.output?.statusCode;
      observed.lastDisconnect = {
        code,
        reason: Object.entries(DisconnectReason).find(([, v]) => v === code)?.[0],
        message: err?.message,
      };

      /**
       * 515 is SUCCESS, not failure.
       *
       * After WhatsApp accepts a QR scan it immediately errors the stream and requires the
       * client to reconnect using the credentials it just wrote. Treating this as a failed
       * pair is a classic misread — the link is already established at this point.
       */
      if (code === DisconnectReason.restartRequired) {
        observed.restartsHandled += 1;
        step("Stream restart required (515) — this means the scan was ACCEPTED");
        line("  Reconnecting with the credentials WhatsApp just issued…");
        if (observed.restartsHandled > 3) {
          line("  Too many restarts; giving up.");
          verdict();
          process.exit(1);
        }
        setTimeout(() => void connect(attempt + 1), 1000);
        return;
      }

      step("Connection closed");
      line(`  status code : ${code ?? "unknown"}`);
      line(`  reason      : ${observed.lastDisconnect.reason ?? "unrecognised"}`);
      line(`  message     : ${err?.message ?? "(none)"}`);

      if (code === DisconnectReason.loggedOut) {
        line("  → WhatsApp rejected or ended the link.");
      } else if (code === 428 && observed.qrCount === 0) {
        observed.passkeyDemanded = true;
        line("  → 428 before any QR: the platform-enum gate (Baileys #2677).");
      }

      if (!observed.pairedAt) {
        verdict();
        process.exit(1);
      }
    }
  });
}

async function finish(sock: WASocket) {
  if (LOGOUT_AFTER) {
    step("Unlinking (--logout)");
    await sock.logout().catch(() => {});
  } else {
    line("");
    line("  Session left LINKED and credentials saved to .auth-scratch.");
    line("  Phase 1b can reuse it with `bun run pair --resume`.");
    line("  To unlink: WhatsApp → Settings → Linked devices, or rerun with --logout.");
  }
  verdict();
  process.exit(0);
}

function verdict() {
  step("VERDICT — PLAN.md §8 phase 1a");
  line(`  QR codes issued : ${observed.qrCount}`);
  line(`  paired          : ${observed.pairedAt ?? "no"}`);
  line(`  515 restarts    : ${observed.restartsHandled}`);
  line(`  passkey demanded: ${observed.passkeyDemanded ? "YES" : "no"}`);
  line(`  reachoutTimeLock: ${observed.reachoutTimeLock ? JSON.stringify(observed.reachoutTimeLock) : "none"}`);
  line(`  last disconnect : ${observed.lastDisconnect ? JSON.stringify(observed.lastDisconnect) : "none"}`);
  line("");

  const code = observed.lastDisconnect?.code;
  if (observed.pairedAt) {
    line("  QR PAIRING WORKS. WhatsApp did not demand a WebAuthn assertion.");
    line("  Passkey stays deferred to Tier 2; no three-day spike needed.");
    line("  Next: phase 1b — walking skeleton (send one text, receive one webhook).");
  } else if (observed.qrCount === 0) {
    line("  INCONCLUSIVE — no QR was displayed, so nothing was scanned.");
    line("  This is NOT evidence about the WebAuthn gate.");
    if (code === 401) line("  401 with zero QRs = stale saved credentials. Just rerun.");
    else if (code === 428) line("  428 before any QR = platform-enum gate; try another `browser:`.");
    else line("  Check network egress and whether WA web is reachable from this host.");
  } else {
    line(`  A QR was shown (${observed.qrCount}) but the link did not complete.`);
    line("  If you scanned it and WhatsApp refused, THAT is the WebAuthn gate.");
    line("  If you did not scan in time, the QR simply expired — rerun.");
  }
  line("");
}

async function main() {
  const { version, isLatest } = await fetchLatestBaileysVersion();
  waVersion = version;

  step("Environment");
  line(`  baileys        7.0.0-rc14 (pinned)`);
  line(`  node           ${process.version}`);
  line(`  WA web version ${version.join(".")}${isLatest ? " (latest)" : " (NOT latest)"}`);
  line(`  auth dir       ${AUTH_DIR}`);

  if (existsSync(AUTH_DIR) && !RESUME) {
    rmSync(AUTH_DIR, { recursive: true, force: true });
    line(`  cleared previous auth state (pass --resume to keep it)`);
  } else if (existsSync(AUTH_DIR)) {
    line(`  --resume: reusing existing auth state`);
  }

  process.on("SIGINT", () => {
    step("Interrupted");
    verdict();
    process.exit(130);
  });

  await connect(1);
}

main().catch((e) => {
  console.error("pair harness failed:", e);
  process.exit(1);
});
