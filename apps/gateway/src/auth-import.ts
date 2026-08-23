/**
 * PLAN.md §8 phase 2 — move auth state off the filesystem into Postgres.
 *
 * Imports the throwaway file-based state produced by phase 1a into the real store, so the
 * durability test runs against a genuine session (813 key files from a single pair) rather
 * than against synthetic data.
 *
 * Run:  cd apps/gateway && bun run auth:import
 *       DATABASE_URL must point at the wapi database.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { BufferJSON } from "baileys";
import { createDb, baileysCreds, signalKeys } from "@wapi/db";
import { sql } from "drizzle-orm";
import { write } from "./quiet-signal.js";

const AUTH_DIR = resolve(import.meta.dirname, "../.auth-scratch");
const SESSION_ID = process.env["SESSION_ID"] ?? "phase1a";
const DATABASE_URL = process.env["DATABASE_URL"];

/**
 * `useMultiFileAuthState` encodes the key type into the filename as `type-id.json`, with
 * `/` in ids replaced by `__` and `:` by `-`. We reverse that to recover (type, id).
 * Types are hyphenated too (`app-state-sync-key`), so split on the LAST type match rather
 * than the first hyphen.
 */
const KNOWN_TYPES = [
  "pre-key",
  "session",
  "sender-key",
  "app-state-sync-key",
  "app-state-sync-version",
  "sender-key-memory",
  // v7 additions — dropping any of these silently breaks things (tctoken -> error 463).
  "lid-mapping",
  "device-list",
  "tctoken",
  "identity-key",
];

function parseKeyFile(name: string): { type: string; id: string } | null {
  const base = name.replace(/\.json$/, "");
  const type = KNOWN_TYPES.filter((t) => base.startsWith(`${t}-`)).sort((a, b) => b.length - a.length)[0];
  if (!type) return null;
  const id = base.slice(type.length + 1).replace(/__/g, "/");
  return { type, id };
}

async function main() {
  if (!DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  if (!existsSync(join(AUTH_DIR, "creds.json"))) {
    console.error(`No creds.json in ${AUTH_DIR}. Run \`bun run pair\` first.`);
    process.exit(1);
  }

  const { db, close } = createDb(DATABASE_URL);
  write(`\n── Importing ${AUTH_DIR}`);
  write(`  session id : ${SESSION_ID}`);

  // creds.json -> one row per top-level key, matching upstream's useSqliteAuthState shape.
  const creds = JSON.parse(readFileSync(join(AUTH_DIR, "creds.json"), "utf8"), BufferJSON.reviver);
  const credRows = Object.entries(creds).map(([key, value]) => ({
    sessionId: SESSION_ID,
    key,
    value: JSON.stringify(value, BufferJSON.replacer),
  }));
  await db
    .insert(baileysCreds)
    .values(credRows)
    .onConflictDoUpdate({
      target: [baileysCreds.sessionId, baileysCreds.key],
      set: { value: sql.raw("excluded.value"), updatedAt: new Date() },
    });
  write(`  creds keys : ${credRows.length}`);
  write(`  me.id      : ${creds?.me?.id ?? "(none — not paired)"}`);

  const files = readdirSync(AUTH_DIR).filter((f) => f.endsWith(".json") && f !== "creds.json");
  const byType = new Map<string, number>();
  const rows: { sessionId: string; type: string; id: string; value: string }[] = [];
  const skipped: string[] = [];

  for (const f of files) {
    const parsed = parseKeyFile(f);
    if (!parsed) {
      skipped.push(f);
      continue;
    }
    const raw = readFileSync(join(AUTH_DIR, f), "utf8");
    // Re-serialise through BufferJSON so the stored form is exactly what the store reads back.
    const value = JSON.stringify(JSON.parse(raw, BufferJSON.reviver), BufferJSON.replacer);
    rows.push({ sessionId: SESSION_ID, type: parsed.type, id: parsed.id, value });
    byType.set(parsed.type, (byType.get(parsed.type) ?? 0) + 1);
  }

  // Chunked: a single 800-row insert exceeds sensible parameter limits.
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db
      .insert(signalKeys)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [signalKeys.sessionId, signalKeys.type, signalKeys.id],
        set: { value: sql.raw("excluded.value"), updatedAt: new Date() },
      });
  }

  write(`  key files  : ${files.length}`);
  write(`  imported   : ${rows.length}`);
  for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1])) write(`    ${t.padEnd(24)} ${n}`);
  if (skipped.length) {
    write(`  SKIPPED (unrecognised type): ${skipped.length}`);
    for (const s of skipped.slice(0, 10)) write(`    ${s}`);
    write("  A skipped file means a key type this importer does not know about.");
    write("  That is data loss — add it to KNOWN_TYPES before trusting the import.");
  }
  write("");
  await close();
  process.exitCode = skipped.length ? 1 : 0;
}

main().catch((e) => {
  console.error("import failed:", e);
  process.exit(1);
});
