/**
 * Client for the internal gateway RPC surface.
 *
 * Every call carries a hard deadline. Recon on `crafter-status` produced this lesson bluntly:
 * *the failure mode of a remote WhatsApp call is silence, not an error* — its ingestor hung to
 * puppeteer's 180-second protocol timeout repeatedly. An API request must never inherit that.
 */
import type { SessionStatus, EngineIdentity } from "@wapi/core";

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
};
