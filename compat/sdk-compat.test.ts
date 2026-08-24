import { expect, test, describe, beforeAll } from "bun:test";
import { createWasender, WasenderAPIError, type Wasender } from "wasenderapi";
import { createDb, whatsappSessions } from "@wapi/db";
import { decryptSecret } from "@wapi/core";
import { eq } from "drizzle-orm";

/**
 * The drop-in claim, tested against WasenderAPI's own published SDK.
 *
 * PLAN.md §9 layer 3, and the justification for every envelope wart copied in §1. Q2 committed
 * to "their published SDKs work unmodified against our base URL" — until this runs, that is
 * asserted rather than proven. Nothing here is our client code: it is `wasenderapi` from npm,
 * pointed at our host through its own `baseUrl` argument.
 *
 * The SDK returns `{ response, rateLimit }`, unwrapping our body and parsing the
 * `X-RateLimit-*` headers. Asserting on that shape is the point: it only works if our headers
 * and envelopes match what their client was written against.
 *
 * Integration tests against the live deployment. They need DATABASE_URL to read a session key
 * and skip without it, so CI stays green.
 */
const BASE = process.env["WAPI_BASE_URL"] ?? "https://api.wapi.crafter.run/api";
const SESSION_ID = Number(process.env["COMPAT_SESSION_ID"] ?? 3);
const CAN_RUN = Boolean(process.env["DATABASE_URL"]);
const d = CAN_RUN ? describe : describe.skip;

type Wrapped<T> = { response: T; rateLimit?: { limit?: number; remaining?: number; resetTimestamp?: number } };

let sdk: Wasender;
let phone = "";

beforeAll(async () => {
  if (!CAN_RUN) return;
  const { db, close } = createDb(process.env["DATABASE_URL"]!);
  const [s] = await db.select().from(whatsappSessions).where(eq(whatsappSessions.id, SESSION_ID));
  await close();
  if (!s?.apiKeyEncrypted) throw new Error(`session ${SESSION_ID} has no key`);
  phone = s.phoneNumber;
  // Third argument is the base URL — the entire drop-in premise in one parameter.
  sdk = createWasender(decryptSecret(s.apiKeyEncrypted), undefined, BASE);
});

d("their SDK against our server", () => {
  test("parses the bare {status} envelope of GET /api/status", async () => {
    // This response has no `success` wrapper at all. Had we tidied it into the standard
    // envelope, their client would surface undefined here.
    const r = (await sdk.getSessionStatus()) as unknown as Wrapped<{ status: string }>;
    expect(r.response.status).toBe("connected");
  });

  test("reads our X-RateLimit-* headers", async () => {
    // §1 kept these because their SDK consumes them. This is that claim, verified.
    const r = (await sdk.getSessionStatus()) as unknown as Wrapped<unknown>;
    expect(typeof r.rateLimit?.limit).toBe("number");
    expect(typeof r.rateLimit?.remaining).toBe("number");
    expect(typeof r.rateLimit?.resetTimestamp).toBe("number");
  });

  test("unwraps the {success, data} envelope for contacts", async () => {
    const r = (await sdk.getContacts()) as unknown as Wrapped<{ success: boolean; data: unknown[] }>;
    expect(r.response.success).toBe(true);
    expect(Array.isArray(r.response.data)).toBe(true);
  });

  test("returns groups with the documented fields", async () => {
    const r = (await sdk.getGroups()) as unknown as Wrapped<{
      data: { id: string; subject: string; participants: unknown[] }[];
    }>;
    const groups = r.response.data;
    expect(Array.isArray(groups)).toBe(true);
    if (groups.length) {
      expect(typeof groups[0]!.id).toBe("string");
      expect(typeof groups[0]!.subject).toBe("string");
      expect(Array.isArray(groups[0]!.participants)).toBe(true);
    }
  });

  test("resolves a single group by JID", async () => {
    const list = (await sdk.getGroups()) as unknown as Wrapped<{ data: { id: string }[] }>;
    const groups = list.response.data;
    if (!groups.length) return;
    const md = await sdk.getGroupMetadata(groups[0]!.id);
    expect(JSON.stringify(md)).toContain(groups[0]!.id);
  });

  test("checkIfOnWhatsapp works through their client", async () => {
    const r = await sdk.checkIfOnWhatsapp(phone);
    expect(JSON.stringify(r)).toContain("exists");
  });

  test("a 404 surfaces as their WasenderAPIError, not a parse crash", async () => {
    /**
     * Their error class exists because the failure envelope is predictable. If our shape were
     * wrong this would instead throw a TypeError from inside their parser.
     *
     * Matched with instanceof rather than by constructor name: their bundler renames the class
     * to `_WasenderAPIError`, so a name comparison fails against a perfectly correct error.
     */
    let caught: unknown;
    try {
      await sdk.getMessageInfo("999999999");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WasenderAPIError);
  });

  test.if(process.env["COMPAT_SEND"] === "1")(
    "sendText round-trips and returns an integer msgId",
    async () => {
      const r = (await sdk.sendText({
        to: phone,
        text: `wapi sdk-compat ${new Date().toISOString()}`,
      })) as unknown as Wrapped<{ data: { msgId: number; status: string } }>;
      const msgId = r.response.data.msgId;
      expect(typeof msgId).toBe("number");
      // One global sequence seeded at 100000, matching the value their docs show (§1.2).
      expect(msgId).toBeGreaterThanOrEqual(100000);
      expect(r.response.data.status).toBe("in_progress");
    },
  );
});
