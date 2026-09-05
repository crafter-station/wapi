import type { Transport } from "../http.js";
import type {
  DeleteApiTokensTokenResponse,
  GetApiAuditLogsAuditLogResponse,
  GetApiAuditLogsResponse,
  GetApiDispatchesResponse,
  GetApiSandboxThreadResponse,
  GetApiTokensResponse,
  PostApiTokensResponse,
} from "../types.gen.js";

const data = <T extends { data: unknown }>(res: T) => res.data;

/**
 * Personal Access Tokens — the account-level credential.
 *
 * These are wapi extensions; WasenderAPI has no equivalent, because it mints tokens only through
 * its dashboard. They exist so a CLI can manage its own credentials.
 */
export class TokensResource {
  constructor(private readonly http: Transport) {}

  /**
   * Mint a token. **The plaintext is returned exactly once** — only the hash is stored, so there
   * is no call that can show it again and `list()` deliberately cannot.
   */
  async create(name: string) {
    return data(
      await this.http.request<PostApiTokensResponse>("POST", "/api/tokens", { body: { name } }),
    );
  }

  /** Every token on the account, including revoked ones. Never the secret. */
  async list() {
    return data(await this.http.request<GetApiTokensResponse>("GET", "/api/tokens"));
  }

  /**
   * Revoke a token.
   *
   * Revoking the one you are holding works, and is how a machine logs itself out: the call
   * authenticates first, and the credential stops working immediately afterwards. The row is
   * marked revoked rather than deleted so the audit trail keeps pointing at something.
   */
  async revoke(id: number) {
    const res = await this.http.request<DeleteApiTokensTokenResponse>(
      "DELETE",
      `/api/tokens/${id}`,
    );
    return res.message;
  }
}

/** The record of every call made with this account's credentials. */
export class AuditResource {
  constructor(private readonly http: Transport) {}

  /**
   * One page of calls, newest first.
   *
   * Account-scoped rather than session-scoped: calls made with a PAT — creating a session,
   * rotating a key — have no session at all, so filing them under one would hide exactly the
   * actions most worth auditing. `sessionId` narrows to one when that is what you want.
   */
  async page(options: { page?: number; perPage?: number; sessionId?: number } = {}) {
    return data(
      await this.http.request<GetApiAuditLogsResponse>("GET", "/api/audit-logs", {
        query: { page: options.page, per_page: options.perPage, session_id: options.sessionId },
      }),
    );
  }

  /**
   * One call, with the request and response bodies the list omits.
   *
   * Bodies are present only if body capture was enabled when the call happened, and the retention
   * sweep nulls them after a week — so absent is normal rather than an error.
   */
  async get(id: number) {
    return data(
      await this.http.request<GetApiAuditLogsAuditLogResponse>("GET", `/api/audit-logs/${id}`),
    );
  }
}

/** What the webhook worker actually sent, for the session this key belongs to. */
export class DispatchesResource {
  constructor(private readonly http: Transport) {}

  /**
   * One page of delivery attempts, most recent first.
   *
   * One row per event, **updated in place** across retries — so `attempts` climbing to five is
   * the same row changing, not five rows appearing. Session-scoped, unlike the audit log.
   */
  async page(options: { page?: number; perPage?: number } = {}) {
    return data(
      await this.http.request<GetApiDispatchesResponse>("GET", "/api/dispatches", {
        query: { page: options.page, per_page: options.perPage },
      }),
    );
  }
}

/** Reading a sandbox's fake conversation. See `SandboxResource` for driving one. */
export class SandboxThread {
  constructor(private readonly http: Transport) {}

  /**
   * The conversation so far, oldest first — both directions.
   *
   * Held in the gateway's memory and bounded at 200 entries, so there is no pagination and a
   * gateway restart returns the sandbox to its fixtures.
   */
  async list() {
    return data(await this.http.request<GetApiSandboxThreadResponse>("GET", "/api/sandbox/thread"));
  }
}
