import { expect, test, describe } from "bun:test";
import { ROUTES, postApiSendMessageBody } from "./generated/routes.ts";
import { ok, fail, failFramework, failThrottle, paginate } from "./envelope.ts";

describe("Tier-1 surface", () => {
  test("exposes exactly 29 routes", () => {
    expect(ROUTES.length).toBe(29);
  });

  test("every route path is namespaced under /api", () => {
    for (const r of ROUTES) expect(r.path.startsWith("/api/")).toBe(true);
  });

  test("send-message is one polymorphic route, not fourteen", () => {
    const sends = ROUTES.filter((r) => r.path === "/api/send-message");
    expect(sends.length).toBe(1);
    expect(sends[0]!.method).toBe("POST");
  });
});

describe("send-message union", () => {
  test("accepts a bare text message", () => {
    expect(postApiSendMessageBody.safeParse({ to: "+1234567890", text: "hi" }).success).toBe(true);
  });

  test("accepts media without text", () => {
    expect(
      postApiSendMessageBody.safeParse({ to: "+1234567890", imageUrl: "https://x/y.jpg" }).success,
    ).toBe(true);
  });

  test("accepts a poll, mentions, replyTo and viewOnce", () => {
    const r = postApiSendMessageBody.safeParse({
      to: "123-456@g.us",
      text: "@jane vote",
      poll: { question: "?", options: ["a", "b"], multiSelect: false },
      mentions: ["1234@s.whatsapp.net"],
      replyTo: 100000,
      viewOnce: false,
    });
    expect(r.success).toBe(true);
  });

  test("rejects a recipient with no content at all", () => {
    const r = postApiSendMessageBody.safeParse({ to: "+1234567890" });
    expect(r.success).toBe(false);
    // Fidelity: matches their documented validation message for this case.
    expect(r.error!.issues[0]!.message).toBe(
      "The text field is required when no media is present.",
    );
  });

  test("rejects a missing recipient", () => {
    expect(postApiSendMessageBody.safeParse({ text: "hi" }).success).toBe(false);
  });
});

describe("envelopes match WasenderAPI byte-for-byte", () => {
  test("success", () => {
    expect(ok({ msgId: 100000 })).toEqual({ success: true, data: { msgId: 100000 } });
  });

  test("controller failures use `error`, never `message`", () => {
    const f = fail("Only messages with status 'failed' can be resent.");
    expect(f).toEqual({
      success: false,
      error: "Only messages with status 'failed' can be resent.",
    });
    expect("message" in f).toBe(false);
  });

  test("framework failures use `message` and optional `errors`", () => {
    expect(failFramework("Invalid API key")).toEqual({ success: false, message: "Invalid API key" });
    expect(failFramework("Validation failed", { to: ["The to field is required."] })).toEqual({
      success: false,
      message: "Validation failed",
      errors: { to: ["The to field is required."] },
    });
  });

  test("throttle failures deliberately omit `success`", () => {
    const t = failThrottle("You are on a free trial. You can only send 1 message every 1 minute.", 60);
    expect(t).toEqual({
      message: "You are on a free trial. You can only send 1 message every 1 minute.",
      retry_after: 60,
    });
    expect("success" in t).toBe(false);
  });
});

describe("Laravel paginator", () => {
  const page = paginate({
    items: [{ id: "1001" }, { id: "1002" }, { id: "1003" }],
    page: 1,
    perPage: 3,
    total: 15,
    path: "/api/session-id-123/message-logs",
  });

  test("reproduces the documented example exactly", () => {
    expect(page).toEqual({
      current_page: 1,
      data: [{ id: "1001" }, { id: "1002" }, { id: "1003" }],
      first_page_url: "/api/session-id-123/message-logs?page=1",
      from: 1,
      last_page: 5,
      last_page_url: "/api/session-id-123/message-logs?page=5",
      next_page_url: "/api/session-id-123/message-logs?page=2",
      path: "/api/session-id-123/message-logs",
      per_page: 3,
      prev_page_url: null,
      to: 3,
      total: 15,
    });
  });

  test("omits the `links` array Laravel would normally include", () => {
    expect("links" in page).toBe(false);
  });

  test("an empty page reports null from/to", () => {
    const empty = paginate({ items: [], page: 1, perPage: 10, total: 0, path: "/api/x" });
    expect(empty.from).toBeNull();
    expect(empty.to).toBeNull();
    expect(empty.last_page).toBe(1);
  });
});

// --- recipient normalisation (packages/core/src/jid.ts) -----------------------------------
import { resolveRecipient } from "@wapi/core";

describe("recipient resolution", () => {
  test("E.164 and bare numbers become user JIDs", () => {
    expect(resolveRecipient("+51922471582")).toEqual({
      ok: true, jid: "51922471582@s.whatsapp.net", kind: "user",
    });
    expect(resolveRecipient("51922471582")).toEqual({
      ok: true, jid: "51922471582@s.whatsapp.net", kind: "user",
    });
  });

  test("group and channel JIDs keep their domain", () => {
    const g = resolveRecipient("123-456@g.us");
    expect(g.ok && g.kind).toBe("group");
    const n = resolveRecipient("123456789@newsletter");
    expect(n.ok && n.kind).toBe("channel");
  });

  test("device suffixes are stripped — they are not stable across reconnects", () => {
    expect(resolveRecipient("51922471582:6@s.whatsapp.net")).toEqual({
      ok: true, jid: "51922471582@s.whatsapp.net", kind: "user",
    });
  });

  test("LID addresses survive, since inbound messages arrive LID-addressed", () => {
    expect(resolveRecipient("46274715893950:6@lid")).toEqual({
      ok: true, jid: "46274715893950@lid", kind: "user",
    });
  });

  test("username handles are refused rather than mangled into a phone JID", () => {
    const r = resolveRecipient("@jane_doe");
    expect(r.ok).toBe(false);
  });

  test("junk is rejected", () => {
    expect(resolveRecipient("").ok).toBe(false);
    expect(resolveRecipient("123").ok).toBe(false);
  });
});

