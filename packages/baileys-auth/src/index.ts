/**
 * Postgres-backed Baileys `AuthenticationState`.
 *
 * PLAN.md §2 calls this the crux of the whole system: `useMultiFileAuthState` is deprecated
 * upstream ("no future work will be supported") and a volume-backed store loses every session
 * on the first container recreate. One QR pair alone produced 813 key files, so this is also
 * the hottest write path in the product.
 *
 * Design constraints, all from PLAN.md §4:
 *   - Table shape matches upstream's `useSqliteAuthState` so the v8 migration is a data
 *     migration, not a rewrite.
 *   - `list`/`listIds` exist from day one because `migrateAuthState` requires them.
 *   - `BufferJSON` serialisation — plain `JSON.stringify` corrupts Buffers.
 *   - Type-agnostic: v7's `lid-mapping`, `device-list`, `tctoken` and `identity-key` must all
 *     round-trip. Dropping `tctoken` causes error-463 restrictions.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { initAuthCreds, BufferJSON, type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap } from "baileys";
import { baileysCreds, signalKeys, type Db } from "@wapi/db";

const enc = (v: unknown): string | undefined => JSON.stringify(v, BufferJSON.replacer);
const dec = <T>(s: string): T => JSON.parse(s, BufferJSON.reviver) as T;

export type PostgresAuthState = {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  /** True once WhatsApp has issued an identity — see readiness note below. */
  isPaired: () => boolean;
  /** Remove every row for this session. Used on logout and by the harnesses. */
  clearAll: () => Promise<void>;
};

export async function usePostgresAuthState(db: Db, sessionId: string): Promise<PostgresAuthState> {
  const rows = await db.select().from(baileysCreds).where(eq(baileysCreds.sessionId, sessionId));

  let creds: AuthenticationCreds;
  if (rows.length) {
    const obj: Record<string, unknown> = {};
    for (const r of rows) obj[r.key] = dec(r.value);
    creds = obj as unknown as AuthenticationCreds;
  } else {
    creds = initAuthCreds();
  }

  /**
   * Persist credentials.
   *
   * `undefined` values must be filtered, not serialised. `initAuthCreds()` leaves several
   * fields undefined — `me`, `account`, `platform` among them — and
   * `JSON.stringify(undefined, replacer)` returns `undefined` rather than a string, which
   * reaches Postgres as NULL and violates the NOT NULL constraint on `value`.
   *
   * The failure mode was brutal precisely because it was silent: the whole insert aborted, so
   * NOTHING was saved. A QR scan would succeed, WhatsApp would send the 515 restart, the
   * reconnect would reload an empty credential set, and the phone would report "can't log in"
   * — with no error anywhere near the pairing code.
   *
   * A key whose value became undefined is deleted rather than skipped, so a field that is
   * genuinely cleared does not leave a stale row behind to be reloaded later.
   */
  const writeCreds = async () => {
    const rows: { sessionId: string; key: string; value: string }[] = [];
    const removed: string[] = [];

    for (const [key, value] of Object.entries(creds as unknown as Record<string, unknown>)) {
      const serialised = enc(value);
      if (serialised === undefined) removed.push(key);
      else rows.push({ sessionId, key, value: serialised });
    }

    if (!rows.length && !removed.length) return;

    await db.transaction(async (tx) => {
      if (rows.length) {
        await tx
          .insert(baileysCreds)
          .values(rows)
          .onConflictDoUpdate({
            target: [baileysCreds.sessionId, baileysCreds.key],
            set: { value: sqlExcluded("value"), updatedAt: new Date() },
          });
      }
      if (removed.length) {
        await tx
          .delete(baileysCreds)
          .where(and(eq(baileysCreds.sessionId, sessionId), inArray(baileysCreds.key, removed)));
      }
    });
  };

  const state: AuthenticationState = {
    creds,
    keys: {
      async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        if (!ids.length) return out;
        const found = await db
          .select()
          .from(signalKeys)
          .where(
            and(
              eq(signalKeys.sessionId, sessionId),
              eq(signalKeys.type, type as string),
              inArray(signalKeys.id, ids),
            ),
          );
        for (const r of found) {
          let v = dec<SignalDataTypeMap[T]>(r.value);
          // Baileys expects app-state-sync-keys as protobuf objects, not plain JSON.
          if (type === "app-state-sync-key" && v) {
            const { proto } = await import("baileys");
            v = proto.Message.AppStateSyncKeyData.fromObject(
              v as object,
            ) as unknown as SignalDataTypeMap[T];
          }
          out[r.id] = v;
        }
        return out;
      },

      async set(data) {
        const inserts: { sessionId: string; type: string; id: string; value: string }[] = [];
        const deletes: { type: string; id: string }[] = [];

        for (const [type, byId] of Object.entries(data)) {
          for (const [id, value] of Object.entries(byId ?? {})) {
            const serialised = value === null || value === undefined ? undefined : enc(value);
            // Same trap as creds: anything that serialises to undefined must be deleted, never
            // inserted, or the NOT NULL constraint aborts the entire batch.
            if (serialised === undefined) deletes.push({ type, id });
            else inserts.push({ sessionId, type, id, value: serialised });
          }
        }

        // A single transaction: Baileys batches related key writes and a partial apply
        // leaves the ratchet inconsistent.
        await db.transaction(async (tx) => {
          if (inserts.length) {
            await tx
              .insert(signalKeys)
              .values(inserts)
              .onConflictDoUpdate({
                target: [signalKeys.sessionId, signalKeys.type, signalKeys.id],
                set: { value: sqlExcluded("value"), updatedAt: new Date() },
              });
          }
          for (const d of deletes) {
            await tx
              .delete(signalKeys)
              .where(
                and(
                  eq(signalKeys.sessionId, sessionId),
                  eq(signalKeys.type, d.type),
                  eq(signalKeys.id, d.id),
                ),
              );
          }
        });
      },

      async clear() {
        await db.delete(signalKeys).where(eq(signalKeys.sessionId, sessionId));
      },
    },
  };

  return {
    state,
    saveCreds: writeCreds,
    /**
     * Readiness is `creds.me?.id`, NOT `creds.registered`.
     *
     * `registered` belongs to the pairing-code flow and stays false forever after a QR pair.
     * Gating on it rejects live credentials — verified against a real paired session, which
     * reported registered=false alongside 813 valid key files.
     */
    isPaired: () => Boolean(creds.me?.id),
    clearAll: async () => {
      await db.transaction(async (tx) => {
        await tx.delete(signalKeys).where(eq(signalKeys.sessionId, sessionId));
        await tx.delete(baileysCreds).where(eq(baileysCreds.sessionId, sessionId));
      });
    },
  };
}

/** `excluded.<col>` for upserts — Drizzle has no first-class helper for this. */
const sqlExcluded = (column: string) => sql.raw(`excluded.${column}`);
