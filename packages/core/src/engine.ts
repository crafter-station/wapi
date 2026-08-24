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

export type SendOptions = {
  quoted?: Record<string, unknown>;
  /** JIDs to @-mention. Rendered by the client only if the text also contains the @handle. */
  mentions?: string[];
  /** Media that self-destructs after one view. */
  viewOnce?: boolean;
};

/** Exactly one of these carries the payload; the API validates that before calling. */
export type SendContent =
  | { kind: "text"; text: string }
  | { kind: "image"; url: string; caption?: string }
  | { kind: "video"; url: string; caption?: string }
  | { kind: "audio"; url: string }
  | { kind: "document"; url: string; fileName?: string; caption?: string }
  | { kind: "sticker"; url: string }
  | { kind: "location"; latitude: number; longitude: number; name?: string; address?: string }
  | { kind: "contact"; displayName: string; vcard: string }
  | { kind: "poll"; question: string; options: string[]; multiSelect?: boolean };

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
  connect(sessionId: number, opts?: { accountProtection?: boolean }): Promise<{ status: SessionStatus; qr?: string }>;
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
  sendText(sessionId: number, to: string, text: string, opts?: SendOptions): Promise<SendResult>;
  /**
   * The polymorphic send. One endpoint, one method — their API documents fourteen variants of
   * `POST /api/send-message` but it is a single route, so the engine mirrors that rather than
   * growing a method per media type.
   */
  send(sessionId: number, to: string, content: SendContent, opts?: SendOptions): Promise<SendResult>;
  readMessages(sessionId: number, keys: Record<string, unknown>[]): Promise<void>;

  /**
   * Decrypt a media node into bytes.
   *
   * Baileys hands you the *encrypted* CDN blob plus a mediaKey; without this step every
   * inbound image is a dead link, which is why PLAN.md §1 calls decrypt-media
   * non-negotiable rather than a nice-to-have.
   */
  downloadMedia(
    sessionId: number,
    message: Record<string, unknown>,
  ): Promise<{ data: Buffer; mimetype: string; fileName: string } | null>;

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
