/**
 * PLAN.md §8 phase 1a — the one-hour empirical test that gates the whole project.
 *
 * Since 2026-06-30 WhatsApp has demanded a real WebAuthn assertion during device linking
 * for some accounts. whatsmeow shipped support in 31 hours; Baileys' PR #2689 was closed
 * unmerged on 2026-08-20. WasenderAPI's entire passkey surface — including a Device Link
 * Helper Chrome extension — was created 2026-07-09, nine days after the change.
 *
 * So: can Baileys still pair a real number by QR?
 *
 *   - Pairs           -> passkey stays deferred to Tier 2, the walking skeleton proceeds.
 *   - Demands passkey -> the three-day passkey spike becomes the critical path.
 *
 * This script answers that and nothing else. Auth state is deliberately throwaway
 * (file-based, gitignored) — the Postgres store is phase 2, and it will be designed better
 * for having watched a real session's key churn first.
 *
 * Run:  cd apps/gateway && bun run pair
 */
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} from "baileys";
import type { ConnectionState } from "baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import pino from "pino";
import { resolve } from "node:path";
import { existsSync, rmSync } from "node:fs";

const AUTH_DIR = resolve(import.meta.dirname, "../.auth-scratch");

/**
 * Phase 1a asks whether a *fresh* link succeeds, so we start from nothing every run.
 *
 * This matters more than it looks: a half-finished previous run leaves unregistered creds
 * behind, and Baileys will then try to RESTORE that dead session instead of pairing. The
 * symptom is an immediate 401 with no QR ever shown, which reads exactly like a refusal
 * but is not one.
 *
 * Pass --resume to keep existing state (useful later for testing that a session survives
 * a restart, which is what phase 2 is actually about).
 */
const RESUME = process.argv.includes("--resume");

/** Baileys is extremely chatty at debug level; we want our own narration to be readable. */
const logger = pino({ level: process.env["BAILEYS_LOG"] ?? "silent" });

const line = (s = "") => console.log(s);
const step = (s: string) => console.log(`\n── ${s}`);

/** Records everything phase 1a needs to conclude, so the verdict isn't guesswork. */
const observed = {
  qrCount: 0,
  pairedAt: null as string | null,
  passkeyDemanded: false,
  reachoutTimeLock: null as unknown,
  lastDisconnect: null as { code?: number; reason?: string; message?: string } | null,
};

async function main() {
  const { version, isLatest } = await fetchLatestBaileysVersion();
  step("Environment");
  line(`  baileys        7.0.0-rc14 (pinned)`);
  line(`  node           ${process.version}`);
  line(`  WA web version ${version.join(".")}${isLatest ? " (latest)" : " (NOT latest)"}`);
  line(`  auth dir       ${AUTH_DIR}`);

  const hadState = existsSync(AUTH_DIR);
  if (hadState && !RESUME) {
    rmSync(AUTH_DIR, { recursive: true, force: true });
    line(`  cleared previous auth state (pass --resume to keep it)`);
  } else if (hadState) {
    line(`  --resume: reusing existing auth state`);
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  line(`  registered     ${state.creds.registered ? "yes (restoring)" : "no (fresh pair)"}`);

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    // PLAN.md §5: v7 silently flipped this to true. It is a large startup-memory and
    // time regression, and is not mentioned in the migration guide.
    syncFullHistory: false,
    // The advertised platform matters: WIN32/DARWIN now get a 428 before the QR is shown
    // (Baileys #2677). Ubuntu/Chrome is the combination that still works.
    browser: Browsers.ubuntu("Chrome"),
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (u: Partial<ConnectionState>) => {
    const { connection, lastDisconnect, qr, isNewLogin } = u;

    // v7 surfaces error-463 Reachout Timelock as first-class connection state.
    // If this is present we want it in the record — it is the structural rate limit
    // that penalises unofficial clients regardless of send behaviour (PLAN.md §0).
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

    if (connection === "connecting") step("Connecting…");

    if (connection === "open") {
      observed.pairedAt = new Date().toISOString();
      step("PAIRED");
      line(`  jid   ${sock.user?.id ?? "?"}`);
      line(`  lid   ${sock.user?.lid ?? "(none reported)"}`);
      line(`  name  ${sock.user?.name ?? "?"}`);
      line(`  new login: ${isNewLogin ? "yes" : "no (restored from saved creds)"}`);
      verdict();
      void sock.logout().catch(() => {});
      setTimeout(() => process.exit(0), 1500);
    }

    if (connection === "close") {
      const err = lastDisconnect?.error as Boom | undefined;
      const code = err?.output?.statusCode;
      observed.lastDisconnect = {
        code,
        reason: Object.entries(DisconnectReason).find(([, v]) => v === code)?.[0],
        message: err?.message,
      };

      step("Connection closed");
      line(`  status code : ${code ?? "unknown"}`);
      line(`  reason      : ${observed.lastDisconnect.reason ?? "unrecognised"}`);
      line(`  message     : ${err?.message ?? "(none)"}`);

      // 401 on a fresh pair attempt is the signature of the link being refused rather
      // than a normal restart; 428 before any QR is the platform-enum gate.
      if (code === DisconnectReason.loggedOut) {
        line("  → WhatsApp rejected/ended the link.");
      } else if (code === 428 && observed.qrCount === 0) {
        observed.passkeyDemanded = true;
        line("  → 428 before any QR appeared: the platform-enum gate (Baileys #2677).");
      }

      if (!observed.pairedAt) verdict();
      process.exit(observed.pairedAt ? 0 : 1);
    }
  });

  process.on("SIGINT", () => {
    step("Interrupted");
    verdict();
    process.exit(130);
  });
}

function verdict() {
  step("VERDICT — PLAN.md §8 phase 1a");
  line(`  QR codes issued : ${observed.qrCount}`);
  line(`  paired          : ${observed.pairedAt ?? "no"}`);
  line(`  passkey demanded: ${observed.passkeyDemanded ? "YES" : "no"}`);
  line(`  reachoutTimeLock: ${observed.reachoutTimeLock ? JSON.stringify(observed.reachoutTimeLock) : "none"}`);
  line(`  last disconnect : ${observed.lastDisconnect ? JSON.stringify(observed.lastDisconnect) : "none"}`);
  line("");
  const code = observed.lastDisconnect?.code;

  if (observed.pairedAt) {
    line("  QR pairing WORKS. Passkey stays deferred to Tier 2.");
    line("  Next: phase 1b — walking skeleton (send one text, receive one webhook).");
  } else if (observed.qrCount === 0) {
    // No QR means nothing was ever offered to scan, so this says nothing about whether
    // WhatsApp would accept a scan. Do not let it read as a verdict.
    line("  INCONCLUSIVE — no QR code was ever displayed, so nothing was scanned.");
    line("  This is NOT evidence about the WebAuthn gate.");
    if (code === 401) {
      line("  A 401 with zero QRs means stale saved credentials were being restored.");
      line("  This run clears state by default, so a plain rerun should now show a QR.");
    } else if (code === 428) {
      line("  428 before any QR is the platform-enum gate (Baileys #2677) — try a");
      line("  different `browser:` value.");
    } else {
      line("  Check network egress and whether WA web is reachable from this host.");
    }
  } else {
    line(`  A QR was shown (${observed.qrCount}) but the link did not complete.`);
    line("  If you scanned it and WhatsApp refused, THAT is the WebAuthn gate: the");
    line("  three-day passkey spike becomes the critical path, with a headed-browser");
    line("  onboarding fallback the likely shape.");
    line("  If you did not scan in time, the QR simply expired — just rerun.");
  }
  line("");
}

main().catch((e) => {
  console.error("pair harness failed:", e);
  process.exit(1);
});
