import {
  pgTable,
  text,
  boolean,
  integer,
  bigint,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  serial,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Application tables. Auth-state tables live in `schema.ts`.
 *
 * Column naming follows the *public* API's casing (PLAN.md §1.3): session objects are
 * snake_case on the wire, so keeping the columns snake_case means the serialiser is close to
 * a pass-through and there is one less place to get the fidelity wrong.
 */

/** A tenant. Clerk owns the human identity; we own everything machine-facing (PLAN.md §3). */
export const accounts = pgTable(
  "accounts",
  {
    id: serial("id").primaryKey(),
    clerkUserId: text("clerk_user_id").notNull(),
    /**
     * Nullable from day one so Organizations later is a backfill rather than a re-parenting
     * of every foreign key. Personal accounts only in V1 (PLAN.md §3).
     */
    clerkOrgId: text("clerk_org_id"),
    /** Their plan vocabulary. Everyone is on one tier; the seam exists, priced at zero (§4). */
    plan: text("plan").notNull().default("pro"),
    sessionQuota: integer("session_quota").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("accounts_clerk_user_idx").on(t.clerkUserId)],
);

/**
 * Account-scoped credential. Required for session CRUD, proxy_url and regenerate-key.
 *
 * Stored hashed and verified locally — never via Clerk. A Clerk API key's subject must be a
 * user or org, verification is a billed network call, and it would put a Clerk round-trip on
 * every request. See PLAN.md §3.
 */
export const personalAccessTokens = pgTable(
  "personal_access_tokens",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("pat_token_hash_idx").on(t.tokenHash)],
);

/**
 * A linked WhatsApp account.
 *
 * `id` is an integer and is exposed in the public API. `phone_number` stays required on the
 * wire for fidelity, but `lid` is the canonical internal identity — v7 creates all new Signal
 * sessions in LID format and inbound messages arrive LID-addressed (PLAN.md §4).
 */
export const whatsappSessions = pgTable(
  "whatsapp_sessions",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    phoneNumber: text("phone_number").notNull(),
    /** Learned on connect. Nullable until then. */
    lid: text("lid"),
    /** connecting | connected | disconnected | need_scan | need_passkey | logged_out | expired */
    status: text("status").notNull().default("disconnected"),
    /**
     * Two columns for one secret, on purpose.
     *
     * `api_key_hash` is the lookup column, so authentication never decrypts anything.
     * `api_key_encrypted` exists only because GET /api/whatsapp-sessions/{id} returns the
     * key in plaintext (PLAN.md §1) — fidelity forbids hash-only storage, but storing it
     * in the clear is avoidable. Both die with the session.
     */
    apiKeyHash: text("api_key_hash"),
    apiKeyEncrypted: text("api_key_encrypted"),

    accountProtection: boolean("account_protection").notNull().default(false),
    logMessages: boolean("log_messages").notNull().default(true),
    readIncomingMessages: boolean("read_incoming_messages").notNull().default(false),
    autoRejectCalls: boolean("auto_reject_calls").notNull().default(false),
    alwaysOnline: boolean("always_online").notNull().default(false),
    ignoreGroups: boolean("ignore_groups").notNull().default(false),
    ignoreChannels: boolean("ignore_channels").notNull().default(false),
    ignoreBroadcasts: boolean("ignore_broadcasts").notNull().default(false),
    /** http, https or socks5. Wired but off by default (PLAN.md §5). */
    proxyUrl: text("proxy_url"),

    webhookUrl: text("webhook_url"),
    webhookEnabled: boolean("webhook_enabled").notNull().default(false),
    webhookSecret: text("webhook_secret"),
    /** Opt-in HMAC. Default is their plain-string compare, for compatibility (PLAN.md §1). */
    webhookHmac: boolean("webhook_hmac").notNull().default(false),
    webhookEvents: jsonb("webhook_events").$type<string[]>().notNull().default(sql`'[]'::jsonb`),

    /** Touched on every inbound event. Staleness is dashboard-only, never in GET /api/status. */
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sessions_account_idx").on(t.accountId),
    uniqueIndex("sessions_api_key_hash_idx").on(t.apiKeyHash),
  ],
);

/**
 * Messages.
 *
 * `msgId` is the integer the public API returns — a single global sequence seeded at 100000,
 * not the WhatsApp `key.id`. Both are surfaced by GET /api/messages/{msgId}/info, and
 * `replyTo` takes the integer. One global sequence rather than per-session because `replyTo`
 * carries no session qualifier, so the id has to be globally unique (PLAN.md §1.2).
 */
export const messages = pgTable(
  "messages",
  {
    msgId: bigint("msg_id", { mode: "number" })
      .primaryKey()
      .default(sql`nextval('wapi_msg_id_seq')`),
    sessionId: integer("session_id")
      .notNull()
      .references(() => whatsappSessions.id, { onDelete: "cascade" }),
    /** The full WhatsApp key: { id, remoteJid, fromMe, participant, remoteJidAlt }. */
    waKey: jsonb("wa_key").$type<Record<string, unknown>>(),
    remoteJid: text("remote_jid").notNull(),
    fromMe: boolean("from_me").notNull().default(true),
    /** in_progress | sent | delivered | read | failed */
    status: text("status").notNull().default("in_progress"),
    content: jsonb("content").$type<Record<string, unknown>>(),
    mediaRef: text("media_ref"),
    failedReason: text("failed_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("messages_session_idx").on(t.sessionId, t.createdAt),
    index("messages_wa_key_idx").on(t.remoteJid),
  ],
);

/**
 * Contact cache.
 *
 * Baileys v7 removed the in-memory store, so a live socket cannot be asked "what contacts do
 * you know". The only source is the `contacts.upsert` / `contacts.update` event stream, which
 * the webhook worker persists here. PLAN.md §4 always called for this table; v7 makes it
 * mandatory rather than an optimisation.
 *
 * Keyed on LID where known, matching §4's decision to treat LID as canonical identity.
 */
export const contacts = pgTable(
  "contacts",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => whatsappSessions.id, { onDelete: "cascade" }),
    jid: text("jid").notNull(),
    name: text("name"),
    notify: text("notify"),
    phoneNumber: text("phone_number"),
    lid: text("lid"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.jid] })],
);

/**
 * Backup outcomes.
 *
 * The backup container's logs are not reachable through the VPS CLI, so it writes here
 * instead. That also turns PLAN.md §7's "test a restore before launch" from a one-off chore
 * into a property checked on every run: each backup is restored into a scratch database and
 * its row counts compared against the source.
 */
export const backupRuns = pgTable("backup_runs", {
  id: serial("id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  archive: text("archive"),
  bytes: bigint("bytes", { mode: "number" }),
  ok: boolean("ok").notNull().default(false),
  /** Null when restore verification is disabled; false means the archive did not restore. */
  restoreOk: boolean("restore_ok"),
  credsRows: integer("creds_rows"),
  keyRows: integer("key_rows"),
  sessionRows: integer("session_rows"),
  error: text("error"),
});

/**
 * What our own webhook sink received.
 *
 * Webhook HTTP delivery was the last unproven path in the system. Proving it needs a
 * receiver, and pointing one at a third-party inspector would ship real message content to
 * someone else's server — so the sink is ours and the record lands here.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id"),
    event: text("event").notNull(),
    /** Their scheme is a plain shared secret in this header, not an HMAC (PLAN.md §1). */
    signature: text("signature"),
    payload: text("payload"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webhook_deliveries_event_idx").on(t.event, t.receivedAt)],
);

/**
 * What the worker *sent*, as opposed to what our sink *received*.
 *
 * `webhook_deliveries` above is the test sink: it only ever sees traffic for a session
 * deliberately pointed at us, so it says nothing about a production session delivering to a
 * customer's app. The worker itself recorded nothing at all — it logged to pino and moved on —
 * which meant there was no way to answer "are my webhooks landing?" for any real session.
 *
 * One row per event, updated in place rather than one row per attempt. BullMQ retries up to
 * five times with exponential backoff, so per-attempt rows would multiply by five exactly on
 * the sessions that are failing, which is where the volume already is. `attempts` and
 * `lastError` answer the diagnostic question — did it land, and if not why — without that.
 *
 * Keyed on the BullMQ job id because that is the only identifier shared between the enqueue
 * and the attempt that eventually resolves it.
 */
export const webhookDispatches = pgTable(
  "webhook_dispatches",
  {
    id: serial("id").primaryKey(),
    jobId: text("job_id").notNull().unique(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => whatsappSessions.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    /** Where it was sent. Recorded per row because the session's URL can change later. */
    url: text("url"),
    /** `retrying` while attempts remain, then `delivered` or `failed`. */
    status: text("status").notNull().default("retrying"),
    statusCode: integer("status_code"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** Nulled by retention well before the row is deleted — it carries real message content. */
    payload: text("payload"),
    durationMs: integer("duration_ms"),
    firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The inspector's only query: one session, newest first.
    index("webhook_dispatches_session_idx").on(t.sessionId, t.lastAttemptAt),
    // Retention sweeps by age across all sessions.
    index("webhook_dispatches_age_idx").on(t.lastAttemptAt),
  ],
);

export type WebhookDispatch = typeof webhookDispatches.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type BackupRun = typeof backupRuns.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type PersonalAccessToken = typeof personalAccessTokens.$inferSelect;
export type WhatsappSession = typeof whatsappSessions.$inferSelect;
export type Message = typeof messages.$inferSelect;
