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
  /**
   * `DB_POOL_MAX` exists because the pool is per *process*, and wapi runs four of them.
   *
   * Ten connections each is fine against a dedicated Postgres and too many against a managed one
   * with a small ceiling — where the symptom is a 500 on whichever page happens to be opened
   * last, reading as an application bug. An explicit `opts.max` still wins, so callers that have
   * already reasoned about their own budget are unaffected.
   */
  const envMax = Number(process.env["DB_POOL_MAX"]);
  const max = opts.max ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : 10);
  const sql = postgres(url, { max, prepare: false });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}
