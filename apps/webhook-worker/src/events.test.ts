import { expect, test, describe } from "bun:test";
import { dispatchStatus, passesSessionFilters, toPublicEvents } from "./events.ts";

// --- webhook event fan-out (apps/webhook-worker/src/events.ts) ----------------------------

describe("webhook event fan-out", () => {
  const inbound = (remoteJid: string) => ({
    messages: [{ key: { remoteJid, fromMe: false, id: "X1" } }],
    type: "notify",
  });

  test("an inbound personal message produces upsert + received + personal", () => {
    const names = toPublicEvents("messages.upsert", inbound("51999@s.whatsapp.net")).map((e) => e.event);
    expect(names).toEqual(["messages.upsert", "messages.received", "messages-personal.received"]);
  });

  test("a group message routes to the group variant, not the personal one", () => {
    const names = toPublicEvents("messages.upsert", inbound("123-456@g.us")).map((e) => e.event);
    expect(names).toContain("messages-group.received");
    expect(names).not.toContain("messages-personal.received");
  });

  test("a newsletter message routes to the newsletter variant", () => {
    const names = toPublicEvents("messages.upsert", inbound("999@newsletter")).map((e) => e.event);
    expect(names).toContain("messages-newsletter.received");
  });

  test("an outbound message is message.sent, never received", () => {
    const names = toPublicEvents("messages.upsert", {
      messages: [{ key: { remoteJid: "51999@s.whatsapp.net", fromMe: true, id: "X2" } }],
      type: "append",
    }).map((e) => e.event);
    expect(names).toEqual(["messages.upsert", "message.sent"]);
  });

  test("other Baileys events map one-to-one", () => {
    expect(toPublicEvents("group-participants.update", {})[0]!.event).toBe("group-participants.update");
    expect(toPublicEvents("call", {})[0]!.event).toBe("call");
    expect(toPublicEvents("not-a-real-event", {})).toEqual([]);
  });

  test("ignore_groups suppresses group traffic", () => {
    const [ev] = toPublicEvents("messages.upsert", inbound("123-456@g.us")).filter(
      (e) => e.event === "messages-group.received",
    );
    const opts = { ignoreGroups: true, ignoreChannels: false, ignoreBroadcasts: false };
    expect(passesSessionFilters(ev!, opts)).toBe(false);
    expect(passesSessionFilters(ev!, { ...opts, ignoreGroups: false })).toBe(true);
  });
});

/**
 * The retry path, which cannot be proven against the live session.
 *
 * The only paired session points at a real application that answers 200, so every dispatch
 * recorded in production is a first-attempt success. These pin the half that matters most to an
 * operator and is least observable: what a *failure* gets stored as.
 */
describe("dispatchStatus", () => {
  const at = (attemptsMade: number, ok: boolean) =>
    dispatchStatus({ attemptsMade, maxAttempts: 5, ok });

  test("counts the attempt being reported, not the ones before it", () => {
    // BullMQ passes 0 on the first run. Storing 0 would read as "never tried".
    expect(at(0, true)).toEqual({ attempts: 1, status: "delivered" });
    expect(at(4, true)).toEqual({ attempts: 5, status: "delivered" });
  });

  test("a failure short of the cap is retrying, not failed", () => {
    for (let made = 0; made < 4; made++) {
      expect(at(made, false).status).toBe("retrying");
    }
  });

  test("only the last permitted attempt is terminal", () => {
    expect(at(4, false)).toEqual({ attempts: 5, status: "failed" });
  });

  test("a success is delivered regardless of how many attempts it took", () => {
    expect(at(3, true)).toEqual({ attempts: 4, status: "delivered" });
  });

  test("with retries disabled the first failure is already final", () => {
    // maxAttempts of 1 is the `job.opts.attempts ?? 1` fallback; treating it as "retrying"
    // would leave those rows permanently mislabelled as in-flight.
    expect(dispatchStatus({ attemptsMade: 0, maxAttempts: 1, ok: false })).toEqual({
      attempts: 1,
      status: "failed",
    });
  });
});
