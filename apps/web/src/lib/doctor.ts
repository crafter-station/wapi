import "server-only";
import { and, desc, eq, gt } from "drizzle-orm";
import { createDb, doctorRuns, webhookDispatches, whatsappSessions, type DoctorCheck } from "@wapi/db";
import { decryptSecret } from "@wapi/core";
import { apiFetch, ApiError } from "./wapi-api";

/**
 * The connection doctor.
 *
 * Answers the question an operator actually has — "is this session healthy?" — which is the one
 * curl answers worst, because it takes six calls and knowing which failures matter.
 *
 * Three rules shape everything here.
 *
 * **Every call goes over the public edge.** Page renders use the internal URL for speed, but the
 * doctor's whole purpose is end-to-end truth, so TLS, Cloudflare and Traefik are part of what is
 * under test.
 *
 * **The only write is a message to the session's own number.** No group, no third party, ever.
 * A health check must be safe to click repeatedly by anyone who can see the button.
 *
 * **`skipped` is not `fail`.** A session with no webhook configured is not broken. Reporting it
 * as broken is how a health check earns a reputation for crying wolf and stops being read.
 */

const nowMs = () => Date.now();

type Ctx = { key: string; sessionId: number; ownNumber: string };

async function step(
  name: string,
  run: () => Promise<Omit<DoctorCheck, "name" | "ms">>,
): Promise<DoctorCheck> {
  const started = nowMs();
  try {
    const r = await run();
    return { ...r, ms: nowMs() - started, name };
  } catch (err) {
    const detail =
      err instanceof ApiError
        ? `${err.status} — ${err.message}`
        : err instanceof Error && err.name === "TimeoutError"
          ? "timed out"
          : String(err);
    return { detail, ms: nowMs() - started, name, state: "fail" };
  }
}

const CHECKS: {
  name: string;
  run: (c: Ctx) => Promise<Omit<DoctorCheck, "name" | "ms">>;
}[] = [
  {
    name: "Reachable over HTTPS",
    run: async ({ key }) => {
      const body = await apiFetch(key, "/api/status", { edge: true });
      const status = String(body["status"] ?? "unknown");
      return status === "connected"
        ? { detail: "connected", state: "pass" }
        : { detail: `status is "${status}" — connect the session first`, state: "fail" };
    },
  },
  {
    name: "Identity",
    run: async ({ key }) => {
      const body = await apiFetch(key, "/api/user", { edge: true });
      const d = (body["data"] ?? {}) as { id?: string; name?: string; lid?: string };
      if (!d.id) return { detail: "no identity returned", state: "fail" };
      return { detail: `${d.id}${d.lid ? ` · ${d.lid}` : ""}`, state: "pass" };
    },
  },
  {
    name: "Directory readable",
    run: async ({ key }) => {
      const [c, g] = await Promise.all([
        apiFetch(key, "/api/contacts?paginated=true&page=1&limit=1", { edge: true }),
        apiFetch(key, "/api/groups?paginated=true&page=1&limit=1", { edge: true }),
      ]);
      const cn = ((c["data"] as { pagination?: { total?: number } })?.pagination?.total) ?? 0;
      const gn = ((g["data"] as { pagination?: { total?: number } })?.pagination?.total) ?? 0;
      return { detail: `${cn} contacts, ${gn} groups`, state: "pass" };
    },
  },
  {
    name: "Send",
    run: async ({ key, ownNumber }) => {
      // The session's own number, always. See the header comment.
      const body = await apiFetch(key, "/api/send-message", {
        edge: true,
        init: {
          body: JSON.stringify({ text: "wapi health check", to: ownNumber }),
          method: "POST",
        },
      });
      const d = (body["data"] ?? {}) as { msgId?: number };
      return d.msgId
        ? { detail: `delivered to self as msgId ${d.msgId}`, state: "pass" }
        : { detail: "accepted but returned no msgId", state: "fail" };
    },
  },
  {
    name: "Media round-trip",
    run: async ({ key }) => {
      const body = await apiFetch(key, "/api/upload", {
        edge: true,
        init: {
          body: JSON.stringify({
            base64: Buffer.from("wapi health check").toString("base64"),
            fileName: "health.txt",
            mimetype: "text/plain",
          }),
          method: "POST",
        },
      });
      // `publicUrl` sits at the top level here, not under `data`.
      const url = String(body["publicUrl"] ?? "");
      if (!url) return { detail: "upload returned no URL", state: "fail" };
      const back = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      return back.ok
        ? { detail: "uploaded and fetched back", state: "pass" }
        : { detail: `stored, but fetching it back gave ${back.status}`, state: "fail" };
    },
  },
];

/**
 * Webhook delivery, asserted on what the worker recorded.
 *
 * Never by repointing `webhook_url` at our own sink: that races with live traffic and can strand
 * a session pointing at the wrong place if the run dies midway. Reading the worker's own record
 * works for a production session delivering to a customer's app, and mutates nothing.
 *
 * The trade is honest and worth stating: this proves *the worker attempted delivery and got a
 * 2xx*, not that we saw the payload.
 */
async function webhookCheck(
  db: ReturnType<typeof createDb>["db"],
  sessionId: number,
  session: { webhookEnabled: boolean; webhookUrl: string | null },
  since: Date,
): Promise<DoctorCheck> {
  const started = nowMs();
  if (!session.webhookEnabled || !session.webhookUrl) {
    return {
      detail: "no webhook configured — nothing to check",
      ms: 0,
      name: "Webhook delivery",
      state: "skipped",
    };
  }

  // The send above should produce an event; give the queue a moment to work through it.
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const [row] = await db
      .select()
      .from(webhookDispatches)
      .where(and(eq(webhookDispatches.sessionId, sessionId), gt(webhookDispatches.lastAttemptAt, since)))
      .orderBy(desc(webhookDispatches.lastAttemptAt))
      .limit(1);
    if (!row) continue;
    if (row.status === "delivered") {
      return {
        detail: `${row.event} → ${row.statusCode} in ${row.durationMs}ms`,
        ms: nowMs() - started,
        name: "Webhook delivery",
        state: "pass",
      };
    }
    if (row.status === "failed") {
      return {
        detail: `${row.event} failed after ${row.attempts} attempts — ${row.lastError ?? "no detail"}`,
        ms: nowMs() - started,
        name: "Webhook delivery",
        state: "fail",
      };
    }
  }

  /**
   * No record inside the window is genuinely ambiguous, so it is reported as such.
   *
   * The most common cause is benign: this session subscribes to specific events and a message
   * it *sent* is not one it *received*, so nothing was queued. Calling that a failure would be
   * wrong; calling it a pass would be a lie.
   */
  return {
    detail: "no delivery recorded in 12s — the sent event may not be one this session subscribes to",
    ms: nowMs() - started,
    name: "Webhook delivery",
    state: "skipped",
  };
}

export type DoctorResult = { checks: DoctorCheck[]; durationMs: number; verdict: string };

/** Runs every check in order and stores the result, replacing the session's previous run. */
export async function runDoctor(sessionId: number, accountId: number): Promise<DoctorResult | null> {
  const { db, close } = createDb(process.env["DATABASE_URL"]!);
  try {
    const [session] = await db
      .select()
      .from(whatsappSessions)
      .where(and(eq(whatsappSessions.id, sessionId), eq(whatsappSessions.accountId, accountId)))
      .limit(1);
    if (!session?.apiKeyEncrypted) return null;

    const key = decryptSecret(session.apiKeyEncrypted);
    const ctx: Ctx = {
      key,
      ownNumber: session.phoneNumber.replace(/\s+/g, ""),
      sessionId,
    };

    const startedAt = new Date();
    const t0 = nowMs();
    const checks: DoctorCheck[] = [];
    for (const c of CHECKS) {
      const result = await step(c.name, () => c.run(ctx));
      checks.push(result);
      // Nothing after the first check is meaningful on a disconnected session, and a send
      // against one would just queue work that cannot run.
      if (result.state === "fail" && c.name === "Reachable over HTTPS") break;
    }
    if (checks.every((c) => c.name !== "Reachable over HTTPS" || c.state === "pass")) {
      checks.push(await webhookCheck(db, sessionId, session, startedAt));
    }

    const durationMs = nowMs() - t0;
    const verdict = checks.some((c) => c.state === "fail")
      ? "failed"
      : checks.some((c) => c.state === "skipped")
        ? "degraded"
        : "ok";

    await db
      .insert(doctorRuns)
      .values({ checks, durationMs, ranAt: new Date(), sessionId, verdict })
      .onConflictDoUpdate({
        set: { checks, durationMs, ranAt: new Date(), verdict },
        target: doctorRuns.sessionId,
      });

    return { checks, durationMs, verdict };
  } finally {
    await close();
  }
}
