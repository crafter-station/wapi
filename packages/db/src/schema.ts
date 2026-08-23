import { pgTable, text, primaryKey, index, timestamp } from "drizzle-orm/pg-core";

/**
 * Baileys authentication state, shaped to match upstream's `useSqliteAuthState`.
 *
 * This shape is not a preference — PLAN.md §4 pins it because Baileys v8 ships a new auth
 * format and upstream is explicit that "clients that have not been migrated will not connect
 * on v8". Matching `develop`'s table layout now means the v8 migration is a data migration
 * rather than a rewrite.
 *
 * Both tables carry `session_id` so one database serves many WhatsApp sessions; upstream's
 * SQLite helper is single-session and has no such column.
 */

/** Credentials: one row per key in the creds object. Readiness is the `me` key being present. */
export const baileysCreds = pgTable(
  "baileys_creds",
  {
    sessionId: text("session_id").notNull(),
    key: text("key").notNull(),
    /** BufferJSON-serialised. Plain JSON.stringify corrupts Buffers — see PLAN.md §4. */
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.key] })],
);

/**
 * Signal protocol key material.
 *
 * `type` is one of Baileys' `SignalDataTypeMap` keys. v7 added four that a v6-shaped store
 * silently drops: `lid-mapping`, `device-list`, `tctoken` and `identity-key`. Losing
 * `tctoken` in particular is what produces error-463 restrictions (PLAN.md §0), so the
 * store must be type-agnostic rather than enumerating known types.
 *
 * The (session_id, type) index exists because `list()`/`listIds()` scan by type, and
 * `migrateAuthState` depends on that being cheap.
 */
export const signalKeys = pgTable(
  "signal_keys",
  {
    sessionId: text("session_id").notNull(),
    type: text("type").notNull(),
    id: text("id").notNull(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.type, t.id] }),
    index("signal_keys_session_type_idx").on(t.sessionId, t.type),
  ],
);

export type BaileysCredRow = typeof baileysCreds.$inferSelect;
export type SignalKeyRow = typeof signalKeys.$inferSelect;
