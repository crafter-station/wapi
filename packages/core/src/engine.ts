/**
 * The WhatsApp engine seam.
 *
 * PLAN.md §2 treats Baileys as a twelve-month bridge, not a foundation: upstream managed 8
 * commits in 60 days against whatsmeow's 43, has not merged the WebAuthn fix in eight weeks,
 * and its own v8 plan names "whatsmeow integration". `@oxidezap/baileyrs` advertises a
 * Baileys-compatible API and accepts upstream auth state.
 *
 * So this interface exists — but deliberately covers **only what the gateway calls**, not the
 * Baileys surface. Abstracting more would be inventing requirements. `crafter-status` made the
 * same move and it is the only reason moving off puppeteer is thinkable there.
 */

export type SessionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "need_scan"
  | "need_passkey"
  | "logged_out"
  | "expired";

export type EngineEvent =
  | { type: "status"; sessionId: number; status: SessionStatus }
  | { type: "qr"; sessionId: number; qr: string }
  | { type: "identity"; sessionId: number; jid: string; lid: string | null; name: string | null }
  /** Raw Baileys event, forwarded to the webhook pipeline under its documented name. */
  | { type: "wa"; sessionId: number; event: string; payload: unknown };

export type SendResult = {
  /** WhatsApp's own message id. The integer `msgId` is assigned by the API, not here. */
  waKeyId: string;
  remoteJid: string;
  key: Record<string, unknown>;
};

export type EngineIdentity = { id: string; name: string | null; lid: string | null };

export type ContactRecord = {
  jid: string;
  name: string | null;
  notify: string | null;
  /** v7 makes these alternates first-class: Contact.id is primary, these are the pair. */
  phoneNumber: string | null;
  lid: string | null;
};

export type GroupRecord = {
  id: string;
  subject: string;
  owner: string | null;
  creation: number | null;
  desc: string | null;
  participants: { id: string; admin: string | null }[];
};

export interface WhatsAppEngine {
  /** Begin linking or restore an existing session. Idempotent per sessionId. */
  connect(sessionId: number): Promise<{ status: SessionStatus; qr?: string }>;
  /** Close the socket without unlinking the device. */
  disconnect(sessionId: number): Promise<void>;
  /** Close and immediately reconnect using the stored credentials. */
  restart(sessionId: number): Promise<{ status: SessionStatus }>;
  /** Unlink the device on WhatsApp's side and drop stored credentials. */
  logout(sessionId: number): Promise<void>;
  status(sessionId: number): SessionStatus;
  /** Latest QR string, if the session is waiting to be scanned. */
  currentQr(sessionId: number): string | null;
  identity(sessionId: number): EngineIdentity | null;
  sendText(sessionId: number, to: string, text: string, opts?: { quoted?: Record<string, unknown> }): Promise<SendResult>;
  readMessages(sessionId: number, keys: Record<string, unknown>[]): Promise<void>;

  /** Contacts. `onWhatsApp` no longer returns LIDs in v7 — see PLAN.md §1. */
  onWhatsApp(sessionId: number, identifier: string): Promise<{ exists: boolean; jid: string | null }>;
  contacts(sessionId: number): Promise<ContactRecord[]>;
  /** Force an app-state resync so contacts.upsert is re-emitted. */
  syncContacts(sessionId: number): Promise<void>;
  contact(sessionId: number, jid: string): Promise<ContactRecord | null>;
  lidFromPn(sessionId: number, pn: string): Promise<string | null>;
  pnFromLid(sessionId: number, lid: string): Promise<string | null>;

  /** Groups. */
  groups(sessionId: number): Promise<GroupRecord[]>;
  groupMetadata(sessionId: number, jid: string): Promise<GroupRecord | null>;
  createGroup(sessionId: number, subject: string, participants: string[]): Promise<GroupRecord>;
  updateParticipants(
    sessionId: number,
    jid: string,
    participants: string[],
    action: "add" | "remove" | "promote" | "demote",
  ): Promise<{ jid: string; status: string }[]>;

  /** Subscribe to everything the engine emits. */
  on(handler: (e: EngineEvent) => void): void;
}
