import { Hono, type Context } from "hono";
import { and, count, eq } from "drizzle-orm";
import { whatsappSessions, type Db } from "@wapi/db";
import {
  fail,
  ok,
  postApiSandboxInboundBody,
  postApiSandboxSessionsBody,
} from "@wapi/contracts";
import {
  encryptSecret,
  generateApiKey,
  generateWebhookSecret,
  hashToken,
  sessionDetailToWire,
  validationFailure,
} from "@wapi/core";
import { gateway, GatewayUnavailableError, SessionNotConnectedError } from "../gateway-client.ts";

/**
 * Sandbox controls — **wapi extensions**, not part of the cloned interface.
 *
 * A sandbox session is a fake number on a fake WhatsApp: it pairs itself, has a small derived
 * directory, accepts sends and can be made to receive them. It exists because linking a real
 * number is the highest-friction step in this product and the one that carries the ban risk, so
 * nobody should have to do it to find out whether their integration works.
 *
 * None of this exists upstream, which is why it lives behind `/api/sandbox/` rather than as
 * flags on documented routes. See `packages/contracts/src/extensions.ts` for the bar each of
 * these had to clear.
 */

/**
 * A cap, not a rate limit.
 *
 * These are free to create through a public endpoint, so the ceiling is what actually stops
 * abuse — an expiry alone would not prevent someone creating thousands in a minute. Deliberately
 * generous: a developer with several branches in flight should not hit it, and being told "too
 * many" is far better than having a session deleted mid-test.
 */
const MAX_SANDBOX_SESSIONS = 25;

export function sandboxRoutes(db: Db) {
  const app = new Hono();

  /**
   * POST /api/sandbox/sessions — create one. Account-scoped, so this needs a PAT.
   *
   * The phone number is not a parameter. It is derived from the session id by the fake engine,
   * under ITU country code 999 which is unassigned and cannot route — letting a caller choose
   * would eventually put a real person's number on a fake session.
   */
  app.post("/sandbox/sessions", async (c) => {
    const auth = c.get("auth");
    if (auth.kind !== "pat") {
      return c.json(fail("Creating a session requires a Personal Access Token."), 403);
    }

    const parsed = postApiSandboxSessionsBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(validationFailure(parsed.error), 422);

    const [tally] = await db
      .select({ n: count() })
      .from(whatsappSessions)
      .where(
        and(eq(whatsappSessions.accountId, auth.accountId), eq(whatsappSessions.sandbox, true)),
      );
    if ((tally?.n ?? 0) >= MAX_SANDBOX_SESSIONS) {
      return c.json(
        fail(`You already have ${MAX_SANDBOX_SESSIONS} sandbox sessions. Delete one first.`),
        422,
      );
    }

    const apiKey = generateApiKey();
    const [row] = await db
      .insert(whatsappSessions)
      .values({
        accountId: auth.accountId,
        apiKeyEncrypted: encryptSecret(apiKey),
        apiKeyHash: hashToken(apiKey),
        name: parsed.data.name,
        /**
         * A placeholder until the engine derives the real one at connect, which needs the id
         * this insert is about to assign. It is already in the unassigned range, so even this
         * transient value cannot be mistaken for a real number.
         */
        phoneNumber: "+999",
        sandbox: true,
        status: "disconnected",
        webhookSecret: generateWebhookSecret(),
      })
      .returning();

    // Now the id exists, so the derived number can be stored — it is what the dashboard and
    // every API response will show.
    const phoneNumber = `+999${String(row!.id).padStart(8, "0")}`;
    const [session] = await db
      .update(whatsappSessions)
      .set({ phoneNumber })
      .where(eq(whatsappSessions.id, row!.id))
      .returning();

    return c.json(ok(sessionDetailToWire(session!)), 201);
  });

  /**
   * POST /api/sandbox/inbound — fabricate a message *to* this session.
   *
   * The point of the whole feature. It travels the ordinary pipeline, so the webhook that
   * arrives is signed exactly as a real one and your handler cannot tell the difference.
   *
   * Session-scoped: the key identifies which sandbox receives it.
   */
  app.post("/sandbox/inbound", async (c) => {
    const auth = c.get("auth");
    if (auth.kind !== "session") {
      return c.json(fail("This endpoint requires a session API key."), 403);
    }

    const parsed = postApiSandboxInboundBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(validationFailure(parsed.error), 422);

    try {
      const { key } = await gateway.sandboxInbound(
        auth.sessionId,
        parsed.data.from,
        parsed.data.text,
      );
      return c.json(ok({ key }));
    } catch (err) {
      return sandboxError(c, err);
    }
  });

  /** POST /api/sandbox/scan — finish pairing now instead of waiting for the timer. */
  app.post("/sandbox/scan", async (c) => {
    const auth = c.get("auth");
    if (auth.kind !== "session") {
      return c.json(fail("This endpoint requires a session API key."), 403);
    }
    try {
      await gateway.sandboxScan(auth.sessionId);
      return c.json(ok({ status: "connected" }));
    } catch (err) {
      return sandboxError(c, err);
    }
  });

  return app;
}

/**
 * The gateway refuses these on a session that is not marked sandbox, and that refusal has to
 * reach the caller as something they can act on rather than a 500.
 *
 * A real session hitting a sandbox control is a mistake worth naming precisely: it means the
 * caller believes a live number is fake, which is the more alarming direction of that confusion.
 */
function sandboxError(c: Context, err: unknown) {
  if (err instanceof SessionNotConnectedError) return c.json(fail(err.message), 409);
  if (err instanceof GatewayUnavailableError) {
    return c.json(fail("The WhatsApp service is temporarily unavailable. Please retry."), 503);
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("not a sandbox session")) {
    return c.json(
      fail("This is not a sandbox session. Sandbox controls only apply to sandbox sessions."),
      422,
    );
  }
  throw err;
}
