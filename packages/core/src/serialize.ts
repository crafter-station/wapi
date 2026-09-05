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

/** Safety controls omitted by the cloned detail shape. */
export function sessionSettingsToWire(s: WhatsappSession) {
  return {
    read_incoming_messages: s.readIncomingMessages,
    ignore_groups: s.ignoreGroups,
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

/**
 * Group wire shapes.
 *
 * Their documented group is keyed on `jid` and carries `name` and `imgUrl`; ours was the raw
 * Baileys metadata keyed on `id` with `subject`. Both are emitted: a client reading their
 * documented keys works, and nothing our own callers already read is removed.
 *
 * `imgUrl` is null rather than fetched. A group picture is a separate round-trip to WhatsApp,
 * and doing it per row would turn a list call into N of them; their own example ships null.
 */
export function participantToWire(p: { id: string; admin?: string | null }) {
  return {
    // Their documented participant keys.
    jid: p.id,
    isAdmin: p.admin === "admin" || p.admin === "superadmin",
    isSuperAdmin: p.admin === "superadmin",
    // Ours, kept so the raw role string is not lost.
    id: p.id,
    admin: p.admin ?? null,
  };
}

export function groupToWire(g: {
  id: string;
  subject: string;
  owner?: string | null;
  creation?: number | null;
  desc?: string | null;
  participants?: { id: string; admin?: string | null }[];
}) {
  return {
    jid: g.id,
    id: g.id,
    name: g.subject,
    subject: g.subject,
    imgUrl: null,
    owner: g.owner ?? null,
    creation: g.creation ?? null,
    desc: g.desc ?? null,
    participants: (g.participants ?? []).map(participantToWire),
  };
}

/**
 * Contact wire shape.
 *
 * Their list keys each row on `jid` and their single-contact detail keys it on `id`; both are
 * emitted with the same value so a client reading either documented key works. `verifiedName`,
 * `imgUrl` and `status` are documented keys we cannot fill — a picture and an "about" string
 * are per-contact round-trips to WhatsApp, and doing them per row would turn one list call into
 * N. Their own examples ship these as null, so null is the documented shape for "not known";
 * omitting the key is what breaks a typed client.
 */
export function contactToWire(x: {
  jid: string;
  name: string | null;
  notify: string | null;
  phoneNumber?: string | null;
  lid?: string | null;
}) {
  return {
    jid: x.jid,
    id: x.jid,
    name: x.name,
    notify: x.notify,
    verifiedName: null,
    imgUrl: null,
    status: null,
    phoneNumber: x.phoneNumber ?? null,
    lid: x.lid ?? null,
  };
}
