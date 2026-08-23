/**
 * Baileys implementation of `WhatsAppEngine`.
 *
 * Everything hard about this file comes from one fact (PLAN.md §2): a WhatsApp session is a
 * WebSocket owned by exactly one process, and two live sockets on one session escalates to a
 * WhatsApp restriction. So the registry below is authoritative and every entry point is
 * guarded against opening a second socket for the same id.
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
import type { Logger } from "pino";
import { usePostgresAuthState } from "@wapi/baileys-auth";
import type { Db } from "@wapi/db";
import type {
  WhatsAppEngine,
  EngineEvent,
  SessionStatus,
  SendResult,
  EngineIdentity,
} from "@wapi/core";

/** Baileys events forwarded verbatim; their names are already our public webhook names. */
const FORWARDED = [
  "messages.upsert",
  "messages.update",
  "messages.delete",
  "messages.reaction",
  "message-receipt.update",
  "chats.upsert",
  "chats.update",
  "chats.delete",
  "contacts.upsert",
  "contacts.update",
  "groups.upsert",
  "groups.update",
  "group-participants.update",
  "call",
] as const;

type Entry = {
  sock: WASocket;
  status: SessionStatus;
  qr: string | null;
  identity: EngineIdentity | null;
  /** Guards `account_protection` pacing. */
  lastSendAt: number;
  accountProtection: boolean;
  /** Set while we are closing on purpose, so the close handler does not auto-reconnect. */
  closing: boolean;
};

export class BaileysEngine implements WhatsAppEngine {
  private readonly sessions = new Map<number, Entry>();
  private readonly starting = new Set<number>();
  private handlers: ((e: EngineEvent) => void)[] = [];

  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  on(handler: (e: EngineEvent) => void) {
    this.handlers.push(handler);
  }

  private emit(e: EngineEvent) {
    for (const h of this.handlers) {
      try {
        h(e);
      } catch (err) {
        this.logger.error({ err }, "engine event handler threw");
      }
    }
  }

  private setStatus(sessionId: number, status: SessionStatus) {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.status = status;
    this.emit({ type: "status", sessionId, status });
  }

  status(sessionId: number): SessionStatus {
    return this.sessions.get(sessionId)?.status ?? "disconnected";
  }

  currentQr(sessionId: number): string | null {
    return this.sessions.get(sessionId)?.qr ?? null;
  }

  identity(sessionId: number): EngineIdentity | null {
    return this.sessions.get(sessionId)?.identity ?? null;
  }

  async connect(sessionId: number, opts: { accountProtection?: boolean } = {}) {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.status === "connected") {
      return { status: existing.status };
    }
    // Two sockets on one session is a restriction risk, not just a bug.
    if (this.starting.has(sessionId)) {
      return { status: this.status(sessionId), qr: this.currentQr(sessionId) ?? undefined };
    }
    this.starting.add(sessionId);
    try {
      await this.open(sessionId, opts.accountProtection ?? false);
      // Give WhatsApp a moment to emit the first QR so `connect` can return it inline,
      // which is what their documented response does.
      await new Promise((r) => setTimeout(r, 1500));
      return { status: this.status(sessionId), qr: this.currentQr(sessionId) ?? undefined };
    } finally {
      this.starting.delete(sessionId);
    }
  }

  private async open(sessionId: number, accountProtection: boolean) {
    const auth = await usePostgresAuthState(this.db, String(sessionId));
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: auth.state.creds,
        // Auth reads sit inside Baileys' per-socket ordering mutexes, so a slow round-trip
        // stalls the whole inbound pipeline for this session (PLAN.md §4).
        keys: makeCacheableSignalKeyStore(auth.state.keys, this.logger),
      },
      logger: this.logger,
      // v7 silently flipped this to true and it is not in the migration guide (PLAN.md §5).
      syncFullHistory: false,
      // WIN32/DARWIN draw a 428 before any QR appears (Baileys #2677).
      browser: Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
    });

    const entry: Entry = {
      sock,
      status: auth.isPaired() ? "connecting" : "need_scan",
      qr: null,
      identity: null,
      lastSendAt: 0,
      accountProtection,
      closing: false,
    };
    this.sessions.set(sessionId, entry);

    sock.ev.on("creds.update", auth.saveCreds);

    sock.ev.on("connection.update", (u: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = u;

      if (qr) {
        entry.qr = qr;
        this.setStatus(sessionId, "need_scan");
        this.emit({ type: "qr", sessionId, qr });
      }

      if (connection === "connecting") this.setStatus(sessionId, "connecting");

      if (connection === "open") {
        entry.qr = null;
        entry.identity = {
          id: jidNormalizedUser(sock.user!.id),
          name: sock.user?.name ?? null,
          lid: sock.user?.lid ?? null,
        };
        this.setStatus(sessionId, "connected");
        this.emit({ type: "identity", sessionId, ...entry.identity, jid: entry.identity.id });
      }

      if (connection === "close") {
        const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;

        if (entry.closing) {
          this.sessions.delete(sessionId);
          this.setStatus(sessionId, "disconnected");
          return;
        }

        /**
         * 515 is a SUCCESSFUL pair, not a failure: WhatsApp accepts the scan, errors the
         * stream, and requires a reconnect with the credentials it just issued. Reading it
         * as a refusal is the single easiest way to conclude pairing is broken when it is not.
         */
        if (code === DisconnectReason.restartRequired) {
          this.logger.info({ sessionId }, "515 restart required — reconnecting");
          this.sessions.delete(sessionId);
          void this.open(sessionId, accountProtection);
          return;
        }

        if (code === DisconnectReason.loggedOut) {
          this.sessions.delete(sessionId);
          this.setStatus(sessionId, "logged_out");
          return;
        }

        this.sessions.delete(sessionId);
        this.setStatus(sessionId, "disconnected");
      }
    });

    for (const name of FORWARDED) {
      sock.ev.on(name as never, (payload: unknown) => {
        this.emit({ type: "wa", sessionId, event: name, payload });
      });
    }
  }

  async disconnect(sessionId: number) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.closing = true;
    await entry.sock.end(undefined);
    this.sessions.delete(sessionId);
    this.setStatus(sessionId, "disconnected");
  }

  async restart(sessionId: number) {
    await this.disconnect(sessionId);
    return this.connect(sessionId);
  }

  async logout(sessionId: number) {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.closing = true;
      await entry.sock.logout().catch(() => {});
      this.sessions.delete(sessionId);
    }
    const auth = await usePostgresAuthState(this.db, String(sessionId));
    await auth.clearAll();
    this.setStatus(sessionId, "logged_out");
  }

  async sendText(
    sessionId: number,
    to: string,
    text: string,
    opts: { quoted?: Record<string, unknown> } = {},
  ): Promise<SendResult> {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.status !== "connected") {
      throw new SessionNotConnectedError();
    }

    /**
     * `account_protection` pacing — the one rate limit implemented for real (PLAN.md §1).
     *
     * It is not protecting the server from users; it is protecting the phone number from
     * WhatsApp's ban heuristics, and a banned number is the one resource here that cannot
     * just be redeployed.
     */
    if (entry.accountProtection) {
      const wait = 5000 - (Date.now() - entry.lastSendAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    entry.lastSendAt = Date.now();

    const sent = await entry.sock.sendMessage(
      to,
      { text },
      // Baileys needs a whole WAMessage here, not just a key: it dereferences
      // message[type] and fails with "Cannot read properties of undefined" otherwise.
      opts.quoted ? { quoted: opts.quoted as never } : undefined,
    );
    if (!sent?.key.id) throw new Error("send produced no message key");

    return {
      waKeyId: sent.key.id,
      remoteJid: String(sent.key.remoteJid ?? to),
      key: sent.key as unknown as Record<string, unknown>,
    };
  }
}

export class SessionNotConnectedError extends Error {
  constructor() {
    super("Your Whatsapp Session is not connected please connect your session first.");
    this.name = "SessionNotConnectedError";
  }
}
