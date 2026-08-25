/**
 * Schema migration for wapi.
 *
 * Deliberately hand-written DDL rather than `drizzle-kit push`.
 *
 * `push` diffs and applies whatever it thinks is needed, and against this database that is
 * unsafe: it holds a live paired WhatsApp session (1447 signal keys), and it already tried to
 * drop NOT NULL from a column inside a composite primary key. A dev-convenience differ is the
 * wrong tool for a table whose loss costs a re-pair. Everything here is idempotent and
 * additive, and must be kept in step with `schema.ts` / `schema-app.ts`.
 *
 * Run:  bun run --cwd packages/db migrate
 */
import postgres from "postgres";

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });

const statements: [label: string, ddl: string][] = [
  [
    "wapi_msg_id_seq",
    // One global sequence, not per-session: `replyTo` takes a bare integer with no session
    // qualifier, so the id must be globally unique (PLAN.md §1.2). Seeded at 100000 to match
    // the value their documentation shows.
    `CREATE SEQUENCE IF NOT EXISTS wapi_msg_id_seq START WITH 100000 INCREMENT BY 1`,
  ],
  [
    "baileys_creds",
    `CREATE TABLE IF NOT EXISTS baileys_creds (
       session_id text NOT NULL,
       key        text NOT NULL,
       value      text NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (session_id, key)
     )`,
  ],
  [
    "signal_keys",
    `CREATE TABLE IF NOT EXISTS signal_keys (
       session_id text NOT NULL,
       type       text NOT NULL,
       id         text NOT NULL,
       value      text NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (session_id, type, id)
     )`,
  ],
  [
    "signal_keys_session_type_idx",
    `CREATE INDEX IF NOT EXISTS signal_keys_session_type_idx ON signal_keys (session_id, type)`,
  ],
  [
    "accounts",
    `CREATE TABLE IF NOT EXISTS accounts (
       id            serial PRIMARY KEY,
       clerk_user_id text NOT NULL,
       clerk_org_id  text,
       plan          text NOT NULL DEFAULT 'pro',
       session_quota integer NOT NULL DEFAULT 1,
       created_at    timestamptz NOT NULL DEFAULT now()
     )`,
  ],
  [
    "accounts_clerk_user_idx",
    `CREATE UNIQUE INDEX IF NOT EXISTS accounts_clerk_user_idx ON accounts (clerk_user_id)`,
  ],
  [
    "personal_access_tokens",
    `CREATE TABLE IF NOT EXISTS personal_access_tokens (
       id           serial PRIMARY KEY,
       account_id   integer NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
       name         text NOT NULL,
       token_hash   text NOT NULL,
       last_used_at timestamptz,
       revoked_at   timestamptz,
       created_at   timestamptz NOT NULL DEFAULT now()
     )`,
  ],
  [
    "pat_token_hash_idx",
    `CREATE UNIQUE INDEX IF NOT EXISTS pat_token_hash_idx ON personal_access_tokens (token_hash)`,
  ],
  [
    "whatsapp_sessions",
    `CREATE TABLE IF NOT EXISTS whatsapp_sessions (
       id                     serial PRIMARY KEY,
       account_id             integer NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
       name                   text NOT NULL,
       phone_number           text NOT NULL,
       lid                    text,
       status                 text NOT NULL DEFAULT 'disconnected',
       api_key_hash           text,
       api_key_encrypted      text,
       account_protection     boolean NOT NULL DEFAULT false,
       log_messages           boolean NOT NULL DEFAULT true,
       read_incoming_messages boolean NOT NULL DEFAULT false,
       auto_reject_calls      boolean NOT NULL DEFAULT false,
       always_online          boolean NOT NULL DEFAULT false,
       ignore_groups          boolean NOT NULL DEFAULT false,
       ignore_channels        boolean NOT NULL DEFAULT false,
       ignore_broadcasts      boolean NOT NULL DEFAULT false,
       proxy_url              text,
       webhook_url            text,
       webhook_enabled        boolean NOT NULL DEFAULT false,
       webhook_secret         text,
       webhook_hmac           boolean NOT NULL DEFAULT false,
       webhook_events         jsonb NOT NULL DEFAULT '[]'::jsonb,
       last_event_at          timestamptz,
       created_at             timestamptz NOT NULL DEFAULT now(),
       updated_at             timestamptz NOT NULL DEFAULT now()
     )`,
  ],
  [
    "whatsapp_sessions.api_key_encrypted",
    `ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS api_key_encrypted text`,
  ],
  [
    "sessions_account_idx",
    `CREATE INDEX IF NOT EXISTS sessions_account_idx ON whatsapp_sessions (account_id)`,
  ],
  [
    "sessions_api_key_hash_idx",
    `CREATE UNIQUE INDEX IF NOT EXISTS sessions_api_key_hash_idx ON whatsapp_sessions (api_key_hash)`,
  ],
  [
    "messages",
    `CREATE TABLE IF NOT EXISTS messages (
       msg_id        bigint PRIMARY KEY DEFAULT nextval('wapi_msg_id_seq'),
       session_id    integer NOT NULL REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
       wa_key        jsonb,
       remote_jid    text NOT NULL,
       from_me       boolean NOT NULL DEFAULT true,
       status        text NOT NULL DEFAULT 'in_progress',
       content       jsonb,
       media_ref     text,
       failed_reason text,
       created_at    timestamptz NOT NULL DEFAULT now(),
       updated_at    timestamptz NOT NULL DEFAULT now()
     )`,
  ],
  [
    "backup_runs",
    // The backup service has no log access from the CLI, so it records outcomes here. This is
    // also what makes "test a restore" an ongoing property rather than a one-off task.
    `CREATE TABLE IF NOT EXISTS backup_runs (
       id            serial PRIMARY KEY,
       started_at    timestamptz NOT NULL DEFAULT now(),
       finished_at   timestamptz,
       archive       text,
       bytes         bigint,
       ok            boolean NOT NULL DEFAULT false,
       restore_ok    boolean,
       creds_rows    integer,
       key_rows      integer,
       session_rows  integer,
       error         text
     )`,
  ],
  [
    "webhook_deliveries",
    `CREATE TABLE IF NOT EXISTS webhook_deliveries (
       id          serial PRIMARY KEY,
       session_id  integer,
       event       text NOT NULL,
       signature   text,
       payload     text,
       received_at timestamptz NOT NULL DEFAULT now()
     )`,
  ],
  [
    "webhook_deliveries_event_idx",
    `CREATE INDEX IF NOT EXISTS webhook_deliveries_event_idx ON webhook_deliveries (event, received_at)`,
  ],
  [
    "contacts",
    `CREATE TABLE IF NOT EXISTS contacts (
       session_id   integer NOT NULL REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
       jid          text NOT NULL,
       name         text,
       notify       text,
       phone_number text,
       lid          text,
       updated_at   timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (session_id, jid)
     )`,
  ],
  [
    "messages_session_idx",
    `CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (session_id, created_at)`,
  ],
  [
    "messages_wa_key_idx",
    `CREATE INDEX IF NOT EXISTS messages_wa_key_idx ON messages (remote_jid)`,
  ],
  [
    "webhook_dispatches",
    // What the worker sent, one row per event, updated in place as attempts resolve.
    // Keyed on the BullMQ job id so the enqueue and the attempt that resolves it agree.
    `CREATE TABLE IF NOT EXISTS webhook_dispatches (
       id               serial PRIMARY KEY,
       job_id           text NOT NULL UNIQUE,
       session_id       integer NOT NULL REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
       event            text NOT NULL,
       url              text,
       status           text NOT NULL DEFAULT 'retrying',
       status_code      integer,
       attempts         integer NOT NULL DEFAULT 0,
       last_error       text,
       payload          text,
       duration_ms      integer,
       first_attempt_at timestamptz NOT NULL DEFAULT now(),
       last_attempt_at  timestamptz NOT NULL DEFAULT now()
     )`,
  ],
  [
    "webhook_dispatches_session_idx",
    `CREATE INDEX IF NOT EXISTS webhook_dispatches_session_idx
       ON webhook_dispatches (session_id, last_attempt_at)`,
  ],
  [
    "webhook_dispatches_age_idx",
    `CREATE INDEX IF NOT EXISTS webhook_dispatches_age_idx
       ON webhook_dispatches (last_attempt_at)`,
  ],
  [
    "doctor_runs",
    // One row per session, overwritten: the last verdict, not a history.
    `CREATE TABLE IF NOT EXISTS doctor_runs (
       session_id  integer PRIMARY KEY REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
       verdict     text NOT NULL,
       checks      jsonb NOT NULL DEFAULT '[]'::jsonb,
       duration_ms integer,
       ran_at      timestamptz NOT NULL DEFAULT now()
     )`,
  ],
];

for (const [label, ddl] of statements) {
  await sql.unsafe(ddl);
  console.log(`  ok  ${label}`);
}

const tables = await sql.unsafe(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`,
);
console.log(`\ntables: ${tables.map((r) => r["table_name"]).join(", ")}`);

const [seq] = await sql.unsafe(`SELECT last_value, is_called FROM wapi_msg_id_seq`);
console.log(`wapi_msg_id_seq last_value=${seq!["last_value"]} is_called=${seq!["is_called"]}`);

const [keys] = await sql.unsafe(`SELECT count(*)::int AS n FROM signal_keys`);
console.log(`signal_keys rows preserved: ${keys!["n"]}`);

await sql.end();
