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

    /**
     * Routes this session to the fake engine instead of Baileys.
     *
     * A column rather than a phone-number convention: `phone_number` is unvalidated free text,
     * so any prefix convention would eventually match a real number. Set only by
     * `POST /api/sandbox/sessions`; the documented create route cannot reach it, because
     * extending a cloned route is a line this project does not cross.
     */
    sandbox: boolean("sandbox").notNull().default(false),
    accountProtection: boolean("account_protection").notNull().default(false),
    logMessages: boolean("log_messages").notNull().default(true),
    readIncomingMessages: boolean("read_incoming_messages").notNull().default(false),
    autoRejectCalls: boolean("auto_reject_calls").notNull().default(false),
    alwaysOnline: boolean("always_online").notNull().default(false),
    ignoreGroups: boolean("ignore_groups").notNull().default(false),
    ignoreChannels: boolean("ignore_channels").notNull().default(false),
    ignoreBroadcasts: boolean("ignore_broadcasts").notNull().default(false),
    /**
     * http, https or socks5. Validated on write (including an SSRF guard against private ranges)
     * and applied at connect: `BaileysEngine` builds a tunnelling agent from this and gives it to
     * both the WebSocket and the media transfers.
     *
     * Read at connect rather than cached, so a change takes effect on the next connect. A live
     * socket cannot be re-pointed at a different exit without rebuilding it, and pretending
     * otherwise would be the same silent lie this column used to tell — it was stored and read by
     * nothing for its whole existence, which is how an egress IP leaks while a dashboard says
     * "proxied".
     */
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

/**
 * The most recent doctor run, one row per session, overwritten each time.
 *
 * Persisted rather than ephemeral so the sessions list can say which session is actually
 * healthy instead of only what it is called — that is the difference between a diagnostic
 * button and an operator feature. Deliberately not a history: a trend nobody has asked to read
 * is storage built on speculation, and the row count here stays equal to the session count.
 *
 * `checks` holds the per-step results as JSON rather than columns, because the set of checks
 * will change and a migration per check would be the wrong trade for a display-only field.
 */
export const doctorRuns = pgTable("doctor_runs", {
  sessionId: integer("session_id")
    .primaryKey()
    .references(() => whatsappSessions.id, { onDelete: "cascade" }),
  /** `ok` | `degraded` | `failed` — degraded means something was skipped, not broken. */
  verdict: text("verdict").notNull(),
  checks: jsonb("checks").$type<DoctorCheck[]>().notNull().default(sql`'[]'::jsonb`),
  durationMs: integer("duration_ms"),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One step of a doctor run.
 *
 * `skipped` exists because "not configured" is not a failure: a session with no webhook is not
 * broken, and reporting it as broken is how a health check earns the reputation of crying wolf
 * and stops being read.
 */
export type DoctorCheck = {
  name: string;
  state: "pass" | "fail" | "skipped";
  detail: string;
  ms?: number;
};

/**
 * Every API request, after redaction.
 *
 * The point of an audit trail is answering "who did what, when, and what did we say back" —
 * which means it necessarily holds the most sensitive data in the system. `packages/core/redact`
 * is what makes that safe, and it is the thing to read before changing anything here: headers
 * are allow-listed, bodies are deny-listed recursively, and credentials are dropped rather than
 * truncated or hashed.
 *
 * `credentialKind` and the account/session columns are stored *instead of* the token that
 * authenticated the call. That answers the audit question — which credential acted — without the
 * table becoming a list of live keys.
 *
 * Not nullable-by-accident: an unauthenticated or rejected request still gets a row, so a 401
 * sweep is visible. Those rows have no account.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id").references(() => accounts.id, { onDelete: "set null" }),
    sessionId: integer("session_id").references(() => whatsappSessions.id, {
      onDelete: "set null",
    }),
    /** `session` | `pat` | null when the request never authenticated. */
    credentialKind: text("credential_kind"),
    method: text("method").notNull(),
    /** The concrete path, e.g. `/api/groups/1203@g.us/metadata`. */
    path: text("path").notNull(),
    /** The pattern, e.g. `/api/groups/{groupJid}/metadata`, so rows can be grouped by endpoint. */
    route: text("route"),
    status: integer("status").notNull(),
    durationMs: integer("duration_ms"),
    requestHeaders: jsonb("request_headers").$type<Record<string, string>>(),
    requestBody: text("request_body"),
    responseBody: text("response_body"),
    ip: text("ip"),
    /** Only ever populated when an upstream proxy supplies it; never inferred locally. */
    country: text("country"),
    userAgent: text("user_agent"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The two queries the UI makes: one account newest-first, and one session newest-first.
    index("audit_logs_account_idx").on(t.accountId, t.createdAt),
    index("audit_logs_session_idx").on(t.sessionId, t.createdAt),
    // Retention sweeps by age.
    index("audit_logs_age_idx").on(t.createdAt),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type DoctorRun = typeof doctorRuns.$inferSelect;
export type WebhookDispatch = typeof webhookDispatches.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type BackupRun = typeof backupRuns.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type PersonalAccessToken = typeof personalAccessTokens.$inferSelect;
export type WhatsappSession = typeof whatsappSessions.$inferSelect;
export type Message = typeof messages.$inferSelect;
