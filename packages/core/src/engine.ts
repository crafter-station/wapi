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

/**
 * The mutable parts of a group.
 *
 * WhatsApp exposes these as five unrelated calls; the API documents them as one body, so the
 * engine takes one object and the adapter fans it out. Undefined means "leave alone" — distinct
 * from `false`, which is a real setting.
 */
export type GroupSettings = {
  subject?: string;
  description?: string;
  /** Only admins may post. */
  announce?: boolean;
  /** Only admins may edit group info. */
  restrict?: boolean;
  joinApproval?: boolean;
  /** Whether ordinary members may add participants. */
  memberAdd?: boolean;
};

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
  /**
   * React to a message, or clear a reaction with an empty string.
   *
   * Takes the WhatsApp `key` rather than our `msgId` because the useful case is reacting to a
   * message someone else sent, and inbound messages have no row in our table — the same reason
   * `readMessages` is keyed this way.
   */
  reactToMessage(
    sessionId: number,
    key: Record<string, unknown>,
    emoji: string,
  ): Promise<{ id: string | null }>;
  readMessages(sessionId: number, keys: Record<string, unknown>[]): Promise<void>;
  /**
   * Edit a message already sent.
   *
   * WhatsApp allows this only for a short window after sending and gives no way to ask how long
   * is left, so a refusal here is an ordinary outcome rather than a bug.
   */
  editMessage(sessionId: number, key: Record<string, unknown>, text: string): Promise<SendResult>;
  /** Delete a message for everyone. Subject to the same short window as editing. */
  deleteMessage(sessionId: number, key: Record<string, unknown>): Promise<void>;

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
  /**
   * Block or unblock a contact.
   *
   * One method rather than two, because WhatsApp models it as one call with a direction and a
   * pair would invite them drifting apart.
   */
  blockContact(sessionId: number, jid: string, action: "block" | "unblock"): Promise<void>;
  /**
   * Save a display name for a contact.
   *
   * On the port rather than written straight to the table by the API, because each engine owns
   * where its contacts come from — Baileys reads the cache table, the sandbox derives them. A
   * direct DB write would be invisible to a sandbox, so "save then list" would work against one
   * engine and silently do nothing against the other.
   */
  saveContact(sessionId: number, jid: string, fullName: string | null): Promise<void>;
  /**
   * A contact's or group's profile picture URL, or null when there is none.
   *
   * Null is a real answer here and not an error: most WhatsApp accounts have no picture, or
   * restrict it to contacts. Throwing would make the common case look like a failure.
   */
  profilePicture(sessionId: number, jid: string): Promise<string | null>;
  groups(sessionId: number): Promise<GroupRecord[]>;
  groupMetadata(sessionId: number, jid: string): Promise<GroupRecord | null>;
  createGroup(sessionId: number, subject: string, participants: string[]): Promise<GroupRecord>;
  /** Leave a group. Irreversible without a fresh invite, so callers should confirm first. */
  leaveGroup(sessionId: number, jid: string): Promise<void>;
  /**
   * The group's invite link.
   *
   * Returns the bare code, not the URL — the `https://chat.whatsapp.com/` prefix is presentation
   * and belongs to whoever renders it, not to the engine.
   */
  groupInviteCode(sessionId: number, jid: string): Promise<string | null>;
  /** Metadata for a group from an invite code, without joining it. */
  groupByInvite(sessionId: number, code: string): Promise<GroupRecord | null>;
  /** Join a group by invite code. Resolves to the group's JID. */
  acceptGroupInvite(sessionId: number, code: string): Promise<string | null>;
  /**
   * Update group settings. Every field is optional and only the supplied ones are touched, so a
   * caller changing the subject cannot accidentally reset the description.
   */
  updateGroupSettings(sessionId: number, jid: string, settings: GroupSettings): Promise<void>;
  updateParticipants(
    sessionId: number,
    jid: string,
    participants: string[],
    action: "add" | "remove" | "promote" | "demote",
  ): Promise<{ jid: string; status: string }[]>;

  /** Subscribe to everything the engine emits. */
  on(handler: (e: EngineEvent) => void): void;
}
