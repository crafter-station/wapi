/**
 * Client for the internal gateway RPC surface.
 *
 * Every call carries a hard deadline. Recon on `crafter-status` produced this lesson bluntly:
 * *the failure mode of a remote WhatsApp call is silence, not an error* — its ingestor hung to
 * puppeteer's 180-second protocol timeout repeatedly. An API request must never inherit that.
 */
import type {
  SessionStatus,
  EngineIdentity,
  ContactRecord,
  GroupRecord,
  SendContent,
  SendOptions,
} from "@wapi/core";

const BASE = process.env["GATEWAY_URL"] ?? "http://gateway:3002";
const TOKEN = process.env["GATEWAY_TOKEN"] ?? "";

/** Sends are slowest (WhatsApp ack, plus up to 5s of account_protection pacing). */
const DEADLINES: Record<"default" | "connect" | "send", number> = {
  default: 8_000,
  connect: 20_000,
  send: 25_000,
};

export class GatewayUnavailableError extends Error {
  constructor(cause: string) {
    super(`gateway unavailable: ${cause}`);
    this.name = "GatewayUnavailableError";
  }
}

export class SessionNotConnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionNotConnectedError";
  }
}

async function call<T>(path: string, init: RequestInit, deadlineMs: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deadlineMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "X-Gateway-Token": TOKEN, ...init.headers },
    });
    if (res.status === 409) {
      const body = (await res.json()) as { message?: string };
      throw new SessionNotConnectedError(
        body.message ?? "Your Whatsapp Session is not connected please connect your session first.",
      );
    }
    if (!res.ok) throw new GatewayUnavailableError(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof SessionNotConnectedError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new GatewayUnavailableError(`timed out after ${deadlineMs}ms`);
    }
    throw new GatewayUnavailableError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

const post = <T>(path: string, body: unknown, deadline = DEADLINES.default) =>
  call<T>(path, { method: "POST", body: JSON.stringify(body) }, deadline);

/**
 * `resolveOwner` indirection (PLAN.md §2).
 *
 * V1 runs exactly one gateway, so this is a constant. It exists as a function so sharding
 * later is a change here plus a `session_assignments` lookup, rather than a rewrite of every
 * call site.
 */
const resolveOwner = (_sessionId: number): string => BASE;

export const gateway = {
  resolveOwner,

  connect: (sessionId: number, accountProtection: boolean) =>
    post<{ status: SessionStatus; qr?: string }>(
      "/rpc/connect",
      { sessionId, accountProtection },
      DEADLINES.connect,
    ),

  disconnect: (sessionId: number) => post<{ ok: true }>("/rpc/disconnect", { sessionId }),

  restart: (sessionId: number) =>
    post<{ status: SessionStatus }>("/rpc/restart", { sessionId }, DEADLINES.connect),

  logout: (sessionId: number) => post<{ ok: true }>("/rpc/logout", { sessionId }),

  state: (sessionId: number) =>
    call<{ status: SessionStatus; qr: string | null; identity: EngineIdentity | null }>(
      `/rpc/state/${sessionId}`,
      { method: "GET" },
      DEADLINES.default,
    ),

  sendText: (sessionId: number, to: string, text: string, quoted?: Record<string, unknown>) =>
    post<{ waKeyId: string; remoteJid: string; key: Record<string, unknown> }>(
      "/rpc/send-text",
      { sessionId, to, text, quoted },
      DEADLINES.send,
    ),

  send: (sessionId: number, to: string, content: SendContent, opts: SendOptions) =>
    post<{ waKeyId: string; remoteJid: string; key: Record<string, unknown> }>(
      "/rpc/send",
      { sessionId, to, content, opts },
      DEADLINES.send,
    ),

  readMessages: (sessionId: number, keys: Record<string, unknown>[]) =>
    post<{ ok: true }>("/rpc/read-messages", { sessionId, keys }),

  reactToMessage: (sessionId: number, key: Record<string, unknown>, emoji: string) =>
    post<{ id: string | null }>("/rpc/react", { sessionId, key, emoji }),

  /** Sandbox-only; the gateway refuses a session that is not marked sandbox. */
  sandboxInbound: (sessionId: number, from: string | undefined, text: string) =>
    post<{ key: Record<string, unknown> }>("/rpc/sandbox-inbound", { sessionId, from, text }),

  sandboxScan: (sessionId: number) =>
    post<{ ok: true }>("/rpc/sandbox-scan", { sessionId }),

  onWhatsApp: (sessionId: number, identifier: string) =>
    post<{ exists: boolean; jid: string | null }>("/rpc/on-whatsapp", { sessionId, identifier }),

  contacts: (sessionId: number) =>
    call<{ contacts: ContactRecord[] }>(`/rpc/contacts/${sessionId}`, { method: "GET" }, DEADLINES.default),

  downloadMedia: (sessionId: number, message: Record<string, unknown>) =>
    post<{ media: { base64: string; mimetype: string; fileName: string } | null }>(
      "/rpc/download-media",
      { sessionId, message },
      DEADLINES.send,
    ),

  syncContacts: (sessionId: number) =>
    post<{ ok: true }>("/rpc/sync-contacts", { sessionId }, DEADLINES.connect),

  contact: (sessionId: number, jid: string) =>
    post<{ contact: ContactRecord | null }>("/rpc/contact", { sessionId, jid }),

  lidFromPn: (sessionId: number, pn: string) =>
    post<{ lid: string | null }>("/rpc/lid-from-pn", { sessionId, pn }),

  pnFromLid: (sessionId: number, lid: string) =>
    post<{ pn: string | null }>("/rpc/pn-from-lid", { sessionId, lid }),

  groups: (sessionId: number) =>
    call<{ groups: GroupRecord[] }>(`/rpc/groups/${sessionId}`, { method: "GET" }, DEADLINES.connect),

  groupMetadata: (sessionId: number, jid: string) =>
    post<{ group: GroupRecord | null }>("/rpc/group-metadata", { sessionId, jid }),

  createGroup: (sessionId: number, subject: string, participants: string[]) =>
    post<{ group: GroupRecord }>("/rpc/group-create", { sessionId, subject, participants }, DEADLINES.connect),

  updateParticipants: (
    sessionId: number,
    jid: string,
    participants: string[],
    action: "add" | "remove" | "promote" | "demote",
  ) =>
    post<{ results: { jid: string; status: string }[] }>(
      "/rpc/group-participants",
      { sessionId, jid, participants, action },
      DEADLINES.connect,
    ),
};
