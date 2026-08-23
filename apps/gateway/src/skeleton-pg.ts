/**
 * PLAN.md §8 phase 2 — prove a session survives on Postgres alone.
 *
 * The whole point: connect with NO filesystem auth state. If this reaches `connection: open`
 * then a container recreate no longer costs every user a re-pair, which is the single failure
 * this plan is most concerned with.
 *
 * Run:  cd apps/gateway && bun run skeleton:pg              # connect only
 *       cd apps/gateway && bun run skeleton:pg --send       # also send yourself a text
 *       SESSION_ID=phase1a  (default)
 */
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
} from "baileys";
import type { ConnectionState, WASocket } from "baileys";
import type { Boom } from "@hapi/boom";
import pino from "pino";
import { createDb } from "@wapi/db";
import { usePostgresAuthState } from "@wapi/baileys-auth";
import { quietSignal, write } from "./quiet-signal.js";

const SESSION_ID = process.env["SESSION_ID"] ?? "phase1a";
const DATABASE_URL = process.env["DATABASE_URL"];
const DO_SEND = process.argv.includes("--send");

/** Set before we close the socket ourselves, so the close handler does not flag success as failure. */
let closingIntentionally = false;

const logger = pino({ level: process.env["BAILEYS_LOG"] ?? "silent" });
quietSignal(logger);
const line = write;
const step = (s: string) => write(`\n── ${s}`);

async function main() {
  if (!DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const { db, close } = createDb(DATABASE_URL);
  const auth = await usePostgresAuthState(db, SESSION_ID);

  step("Postgres auth state");
  line(`  session id : ${SESSION_ID}`);
  line(`  paired     : ${auth.isPaired() ? "yes" : "no"}`);
  line(`  me         : ${auth.state.creds.me?.id ?? "(none)"}`);
  line(`  lid        : ${auth.state.creds.me?.lid ?? "(none)"}`);

  if (!auth.isPaired()) {
    console.error("No paired session in Postgres. Run `bun run auth:import` first.");
    await close();
    process.exit(1);
  }

  const { version } = await fetchLatestBaileysVersion();
  const t0 = Date.now();

  const sock: WASocket = makeWASocket({
    version,
    auth: {
      creds: auth.state.creds,
      /**
       * PLAN.md §4: auth reads sit inside Baileys' per-socket ordering mutexes, so a slow
       * round-trip stalls that session's whole inbound pipeline. This is the cache upstream
       * provides; a Redis tier goes in front of it when more than a handful of sessions run.
       */
      keys: makeCacheableSignalKeyStore(auth.state.keys, logger),
    },
    logger,
    syncFullHistory: false,
    browser: Browsers.ubuntu("Chrome"),
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", auth.saveCreds);

  sock.ev.on("connection.update", async (u: Partial<ConnectionState>) => {
    const { connection, lastDisconnect } = u;

    if (connection === "connecting") step("Connecting from Postgres state…");

    if (connection === "open") {
      const ms = Date.now() - t0;
      step("PHASE 2 PASSED — connected with zero filesystem auth state");
      line(`  jid            ${jidNormalizedUser(sock.user!.id)}`);
      line(`  lid            ${sock.user?.lid ?? "(none)"}`);
      line(`  time to open   ${ms}ms`);

      if (DO_SEND) {
        const me = jidNormalizedUser(sock.user!.id);
        const sent = await sock.sendMessage(me, {
          text: `wapi phase 2 · postgres auth · ${new Date().toISOString()}`,
        });
        line(`  sent key.id    ${sent?.key.id}`);
      }

      line("");
      line("  A container recreate no longer costs a re-pair.");
      line("  Next: phase 3 — api token auth + session CRUD + send-message.");
      setTimeout(async () => {
        closingIntentionally = true;
        void sock.end(undefined);
        await close();
        process.exitCode = 0;
      }, 3000);
    }

    if (connection === "close") {
      if (closingIntentionally) return;
      const err = lastDisconnect?.error as Boom | undefined;
      const code = err?.output?.statusCode;
      const reason = Object.entries(DisconnectReason).find(([, v]) => v === code)?.[0];
      step("Connection closed");
      line(`  code ${code ?? "?"} — ${reason ?? "?"}`);
      if (code === DisconnectReason.restartRequired) {
        line("  515 = credentials accepted; rerun to reconnect.");
      }
      await close();
      process.exitCode = code === DisconnectReason.restartRequired ? 0 : 1;
    }
  });
}

main().catch((e) => {
  console.error("phase 2 failed:", e);
  process.exit(1);
});
