import type { WhatsappSession } from "@wapi/db";
import { decryptSecret } from "./crypto.js";

/**
 * Wire serialisers.
 *
 * These exist to keep every fidelity wart in one file rather than scattered across handlers.
 * Verified against the response examples in the mirrored spec — see PLAN.md §1.
 */

/** Their timestamps are ISO-8601 with a `Z` suffix: `2025-04-01T12:00:00Z`. */
const iso = (d: Date | null | undefined): string | null =>
  d ? d.toISOString().replace(/\.\d{3}Z$/, "Z") : null;

/**
 * A session as the list endpoint returns it — **without** `api_key` or `webhook_secret`.
 *
 * Their `GET /api/whatsapp-sessions` example omits both; only the single-session detail
 * response includes them. Leaking a key into a list response would be a real problem, so the
 * two shapes are separate functions rather than one with a flag.
 */
export function sessionToWire(s: WhatsappSession) {
  return {
    id: s.id,
    name: s.name,
    phone_number: s.phoneNumber,
    status: s.status,
    account_protection: s.accountProtection,
    log_messages: s.logMessages,
    webhook_url: s.webhookUrl,
    webhook_enabled: s.webhookEnabled,
    webhook_events: s.webhookEvents,
    created_at: iso(s.createdAt),
    updated_at: iso(s.updatedAt),
  };
}

/**
 * The single-session detail shape, which additionally carries `api_key` and
 * `webhook_secret` in plaintext.
 *
 * Fidelity requires this: their documented response returns the key so a user can copy it
 * from the API as well as the dashboard. We store it encrypted rather than in the clear
 * (see `encryptSecret`), so this is the only place it is ever decrypted.
 */
export function sessionDetailToWire(s: WhatsappSession) {
  return {
    ...sessionToWire(s),
    api_key: s.apiKeyHash ? safeDecrypt(s.apiKeyEncrypted) : null,
    webhook_secret: s.webhookSecret,
  };
}

/** A decrypt failure must not 500 the whole request — surface null and log upstream. */
function safeDecrypt(v: string | null | undefined): string | null {
  if (!v) return null;
  try {
    return decryptSecret(v);
  } catch {
    return null;
  }
}

/**
 * `GET /api/user` — the WhatsApp identity behind the session key.
 *
 * Note it returns `lid` as a first-class field, which is a further reason §4 keys internal
 * identity on LID rather than phone number.
 */
export function userToWire(u: { id: string; name?: string | null; lid?: string | null }) {
  return { id: u.id, name: u.name ?? null, lid: u.lid ?? null };
}
