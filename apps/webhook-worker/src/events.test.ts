import { expect, test, describe } from "bun:test";
import { toPublicEvents, passesSessionFilters } from "./events.ts";

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
