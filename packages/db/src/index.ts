import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as authSchema from "./schema.js";
import * as appSchema from "./schema-app.js";

const schema = { ...authSchema, ...appSchema };

export * from "./schema.js";
export * from "./schema-app.js";
export type Db = ReturnType<typeof createDb>["db"];

/**
 * One Postgres pool per process.
 *
 * `max` is deliberately small: the gateway's auth-store reads sit inside Baileys' per-socket
 * ordering mutexes (PLAN.md §4), so throughput there is bounded by those mutexes rather than
 * by connection count, and a large pool just holds server slots idle.
 */
export function createDb(url: string, opts: { max?: number } = {}) {
  const sql = postgres(url, { max: opts.max ?? 10, prepare: false });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}
