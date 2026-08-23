/**
 * PLAN.md §8 phase 1b — the walking skeleton.
 *
 * Phase 1a proved a number can pair. This proves the socket is actually useful end to end:
 * resume the saved session, send one text message, and observe the inbound event stream.
 * That is the thinnest slice that exercises everything the gateway will later wrap.
 *
 * It deliberately does NOT touch Postgres. Auth state stays file-based here; swapping it
 * for the real store is phase 2, and per PLAN.md that swap lands before feature #3.
 *
 * Run:  cd apps/gateway && bun run skeleton                # sends to yourself
 *       cd apps/gateway && bun run skeleton --to +51999... # sends to someone else
 *       cd apps/gateway && bun run skeleton --listen-only  # no send, just observe
 */
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  jidNormalizedUser,
  areJidsSameUser,
} from "baileys";
import type { ConnectionState, WASocket, WAMessage } from "baileys";
import type { Boom } from "@hapi/boom";
import pino from "pino";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const AUTH_DIR = resolve(import.meta.dirname, "../.auth-scratch");
const LISTEN_ONLY = process.argv.includes("--listen-only");
const TO_ARG = (() => {
  const i = process.argv.indexOf("--to");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();
/** How long to keep observing inbound events after the send, in seconds. */
const WATCH_SECONDS = Number(process.env["WATCH_SECONDS"] ?? 90);

const logger = pino({ level: process.env["BAILEYS_LOG"] ?? "silent" });
const line = (s = "") => console.log(s);
const step = (s: string) => console.log(`\n── ${s}`);

const observed = {
  sentMsgId: null as string | null,
  sendAckedAt: null as string | null,
  statusUpdates: [] as string[],
  inbound: 0,
  events: new Set<string>(),
};

/** E.164 (+51999888777) or a bare number → the JID Baileys expects. */
const toJid = (raw: string) =>
  raw.includes("@") ? jidNormalizedUser(raw) : `${raw.replace(/[^0-9]/g, "")}@s.whatsapp.net`;

/** Best-effort human-readable body across the message shapes we care about. */
const bodyOf = (m: WAMessage): string => {
  const msg = m.message;
  if (!msg) return "(no content — likely a protocol message)";
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  const kind = Object.keys(msg)[0] ?? "unknown";
  return `(${kind})`;
};

async function main() {
  if (!existsSync(AUTH_DIR)) {
    console.error("No saved session. Run `bun run pair` first (PLAN.md §8 phase 1a).");
    process.exit(1);
  }

  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  if (!state.creds.registered) {
    console.error("Saved state is not registered. Run `bun run pair` first.");
    process.exit(1);
  }

  step("Resuming saved session");
  line(`  WA web version ${version.join(".")}`);
  line(`  mode           ${LISTEN_ONLY ? "listen-only" : "send + listen"}`);

  const sock: WASocket = makeWASocket({
    version,
    auth: state,
    logger,
    syncFullHistory: false,
    browser: Browsers.ubuntu("Chrome"),
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u: Partial<ConnectionState>) => {
    const { connection, lastDisconnect } = u;

    if (connection === "open") {
      const me = jidNormalizedUser(sock.user!.id);
      step("Connected");
      line(`  jid  ${me}`);
      line(`  lid  ${sock.user?.lid ?? "(none)"}`);

      if (!LISTEN_ONLY) {
        const target = TO_ARG ? toJid(TO_ARG) : me;
        const isSelf = areJidsSameUser(target, me);
        step(`Sending text → ${target}${isSelf ? " (yourself)" : ""}`);
        const text = `wapi walking skeleton · ${new Date().toISOString()}`;
        const sent = await sock.sendMessage(target, { text });
        observed.sentMsgId = sent?.key.id ?? null;
        observed.sendAckedAt = new Date().toISOString();
        line(`  wa key.id : ${observed.sentMsgId}`);
        line(`  acked at  : ${observed.sendAckedAt}`);
        line("");
        line("  Note: this key.id is WhatsApp's. The integer `msgId` the public API returns");
        line("  is our own Postgres sequence — see PLAN.md §1.2. Both are surfaced by");
        line("  GET /api/messages/{msgId}/info.");
      }

      step(`Watching inbound events for ${WATCH_SECONDS}s — send yourself a message now`);
      setTimeout(() => {
        summary();
        process.exit(0);
      }, WATCH_SECONDS * 1000);
    }

    if (connection === "close") {
      const err = lastDisconnect?.error as Boom | undefined;
      const code = err?.output?.statusCode;
      if (code === DisconnectReason.restartRequired) {
        line("  515 restart required — rerun; the saved creds are still valid.");
      }
      step("Connection closed");
      line(`  code ${code ?? "?"} — ${Object.entries(DisconnectReason).find(([, v]) => v === code)?.[0] ?? "?"}`);
      summary();
      process.exit(observed.sendAckedAt ? 0 : 1);
    }
  });

  /**
   * messages.upsert is the event the public API exposes as the `messages.upsert` webhook,
   * and `messages.received` is the inbound-only filtered view of it (PLAN.md §1).
   */
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    observed.events.add("messages.upsert");
    for (const m of messages) {
      const from = m.key.fromMe ? "out" : "in";
      if (!m.key.fromMe) observed.inbound += 1;
      step(`messages.upsert (${type}) [${from}]`);
      line(`  key.id      ${m.key.id}`);
      line(`  remoteJid   ${m.key.remoteJid}`);
      // v7 adds the LID-side alternates; worth seeing them in the wild.
      const alt = (m.key as Record<string, unknown>)["remoteJidAlt"];
      if (alt) line(`  remoteJidAlt ${String(alt)}`);
      line(`  body        ${bodyOf(m).slice(0, 120)}`);
    }
  });

  sock.ev.on("messages.update", (updates) => {
    observed.events.add("messages.update");
    for (const u of updates) {
      const status = u.update?.status;
      if (status !== undefined && u.key.id === observed.sentMsgId) {
        observed.statusUpdates.push(String(status));
        line(`  ↳ our message status → ${status}`);
      }
    }
  });

  sock.ev.on("message-receipt.update", () => observed.events.add("message-receipt.update"));
  sock.ev.on("chats.upsert", () => observed.events.add("chats.upsert"));
  sock.ev.on("contacts.upsert", () => observed.events.add("contacts.upsert"));
  sock.ev.on("groups.upsert", () => observed.events.add("groups.upsert"));

  process.on("SIGINT", () => {
    summary();
    process.exit(130);
  });
}

function summary() {
  step("PHASE 1B SUMMARY");
  line(`  message sent     : ${observed.sentMsgId ?? "(listen-only)"}`);
  line(`  send acked       : ${observed.sendAckedAt ?? "no"}`);
  line(`  status updates   : ${observed.statusUpdates.join(" → ") || "none observed"}`);
  line(`  inbound messages : ${observed.inbound}`);
  line(`  events seen      : ${[...observed.events].join(", ") || "none"}`);
  line("");
  const sendOk = LISTEN_ONLY || Boolean(observed.sendAckedAt);
  const recvOk = observed.events.size > 0;
  if (sendOk && recvOk) {
    line("  WALKING SKELETON COMPLETE — the socket sends and receives.");
    line("  Next: phase 2 — move auth state to Postgres, before any further features.");
  } else {
    if (!sendOk) line("  Send did not ack.");
    if (!recvOk) line("  No inbound events observed — try messaging the linked number while it runs.");
  }
  line("");
}

main().catch((e) => {
  console.error("skeleton failed:", e);
  process.exit(1);
});
