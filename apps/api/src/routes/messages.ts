import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { messages, whatsappSessions, type Db } from "@wapi/db";
import { ok, fail, postApiSendMessageBody } from "@wapi/contracts";
import { validationFailure, resolveRecipient, type SendContent, type SendOptions } from "@wapi/core";
import { gateway, GatewayUnavailableError, SessionNotConnectedError } from "../gateway-client.ts";

/**
 * `POST /api/send-message` — the whole documented union.
 *
 * Their docs describe this fourteen times, but it is one route discriminated by which content
 * field is present (PLAN.md §1). The contract merges those variants; this handler picks the
 * branch and rejects ambiguity rather than quietly choosing one.
 */
export function messageRoutes(db: Db) {
  const app = new Hono();

  app.post("/send-message", async (c) => {
    const auth = c.get("auth");
    if (auth.kind !== "session") {
      return c.json(fail("This endpoint requires a session API key."), 403);
    }

    const parsed = postApiSendMessageBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(validationFailure(parsed.error), 422);
    const b = parsed.data as Record<string, unknown>;

    const recipient = resolveRecipient(String(b["to"]));
    if (!recipient.ok) {
      return c.json(validationFailure({ issues: [{ path: ["to"], message: recipient.reason }] }), 422);
    }

    const built = buildContent(b);
    if ("error" in built) {
      return c.json(validationFailure({ issues: [{ path: [built.field], message: built.error }] }), 422);
    }

    const [session] = await db
      .select()
      .from(whatsappSessions)
      .where(eq(whatsappSessions.id, auth.sessionId))
      .limit(1);
    if (!session) return c.json(fail("The specified session was not found."), 404);

    /** `replyTo` takes our integer msgId — which is why the sequence is global (§1.2). */
    let quoted: Record<string, unknown> | undefined;
    const replyTo = b["replyTo"];
    if (replyTo !== undefined) {
      const [q] = await db
        .select({ waKey: messages.waKey, content: messages.content, sessionId: messages.sessionId })
        .from(messages)
        .where(eq(messages.msgId, Number(replyTo)))
        .limit(1);
      if (!q || q.sessionId !== auth.sessionId) {
        return c.json(fail("The message to reply to was not found."), 404);
      }
      // Baileys wants a whole WAMessage to quote, reconstructed from the key plus text.
      const text = (q.content as { text?: string } | null)?.text ?? "";
      quoted = { key: q.waKey, message: { conversation: text } };
    }

    const opts: SendOptions = { quoted };

    const mentions = b["mentions"];
    if (Array.isArray(mentions) && mentions.length) {
      // Mentions must be JIDs. A bare number renders as a broken mention rather than failing,
      // so they are normalised here instead of passed through.
      const jids: string[] = [];
      for (const m of mentions) {
        const r = resolveRecipient(String(m));
        if (!r.ok) {
          return c.json(
            validationFailure({
              issues: [{ path: ["mentions"], message: `${String(m)}: ${r.reason}` }],
            }),
            422,
          );
        }
        jids.push(r.jid);
      }
      opts.mentions = jids;
    }
    if (b["viewOnce"] === true) opts.viewOnce = true;

    try {
      const sent = await gateway.send(auth.sessionId, recipient.jid, built.content, opts);

      // The integer msgId is minted here by the database sequence, not by WhatsApp.
      const [row] = await db
        .insert(messages)
        .values({
          sessionId: auth.sessionId,
          waKey: sent.key,
          remoteJid: sent.remoteJid,
          fromMe: true,
          status: "in_progress",
          content: session.logMessages ? summarise(b) : null,
        })
        .returning({ msgId: messages.msgId });

      // `jid` echoes the recipient as supplied, not normalised — matching their example.
      return c.json(ok({ msgId: row!.msgId, jid: b["to"], status: "in_progress" }));
    } catch (err) {
      if (err instanceof SessionNotConnectedError) return c.json(fail(err.message), 409);
      if (err instanceof GatewayUnavailableError) {
        return c.json(fail("The WhatsApp service is temporarily unavailable. Please retry."), 503);
      }
      throw err;
    }
  });

  return app;
}

type Body = Record<string, unknown>;

const MEDIA_FIELDS = [
  "imageUrl",
  "videoUrl",
  "audioUrl",
  "documentUrl",
  "stickerUrl",
  "contact",
  "location",
  "poll",
] as const;

/**
 * Pick the content branch.
 *
 * Exactly one payload field may be present. Two would be ambiguous, and quietly preferring one
 * is how a caller ends up sending something they did not intend.
 */
function buildContent(b: Body): { content: SendContent } | { error: string; field: string } {
  const has = (k: string) => b[k] !== undefined && b[k] !== null && b[k] !== "";
  const present = MEDIA_FIELDS.filter(has);

  if (present.length > 1) {
    return { error: `Only one of ${present.join(", ")} may be sent at a time.`, field: present[0]! };
  }

  const caption = typeof b["text"] === "string" && b["text"] ? (b["text"] as string) : undefined;

  if (has("imageUrl")) return { content: { kind: "image", url: String(b["imageUrl"]), caption } };
  if (has("videoUrl")) return { content: { kind: "video", url: String(b["videoUrl"]), caption } };
  if (has("audioUrl")) return { content: { kind: "audio", url: String(b["audioUrl"]) } };
  if (has("stickerUrl")) return { content: { kind: "sticker", url: String(b["stickerUrl"]) } };
  if (has("documentUrl")) {
    return {
      content: {
        kind: "document",
        url: String(b["documentUrl"]),
        fileName: typeof b["fileName"] === "string" ? (b["fileName"] as string) : undefined,
        caption,
      },
    };
  }

  if (has("location")) {
    const l = b["location"] as Record<string, unknown>;
    const lat = Number(l["latitude"] ?? l["degreesLatitude"]);
    const lon = Number(l["longitude"] ?? l["degreesLongitude"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return {
        error: "The location field requires numeric latitude and longitude.",
        field: "location",
      };
    }
    return {
      content: {
        kind: "location",
        latitude: lat,
        longitude: lon,
        name: typeof l["name"] === "string" ? (l["name"] as string) : undefined,
        address: typeof l["address"] === "string" ? (l["address"] as string) : undefined,
      },
    };
  }

  if (has("contact")) {
    const ct = b["contact"] as Record<string, unknown>;
    const name = String(ct["name"] ?? ct["displayName"] ?? "").trim();
    const phone = String(ct["phone"] ?? ct["phoneNumber"] ?? "").trim();
    const digits = phone.replace(/[^0-9]/g, "");
    // Minimal vCard 3.0 — the shape WhatsApp expects. `waid` is what makes the card tappable
    // rather than inert text.
    const generated =
      name && phone
        ? [
            "BEGIN:VCARD",
            "VERSION:3.0",
            `FN:${name}`,
            `TEL;type=CELL;waid=${digits}:${phone}`,
            "END:VCARD",
          ].join("\n")
        : "";
    const vcard = typeof ct["vcard"] === "string" && ct["vcard"] ? (ct["vcard"] as string) : generated;
    if (!vcard) {
      return { error: "The contact field requires name and phone, or a vcard.", field: "contact" };
    }
    return { content: { kind: "contact", displayName: name || phone, vcard } };
  }

  if (has("poll")) {
    const p = b["poll"] as Record<string, unknown>;
    const question = String(p["question"] ?? p["name"] ?? "").trim();
    const options = Array.isArray(p["options"]) ? (p["options"] as unknown[]).map(String) : [];
    if (!question) return { error: "The poll field requires a question.", field: "poll" };
    // Their documented bound: min 2, max 12.
    if (options.length < 2 || options.length > 12) {
      return { error: "The poll field requires between 2 and 12 options.", field: "poll" };
    }
    return { content: { kind: "poll", question, options, multiSelect: p["multiSelect"] === true } };
  }

  if (typeof b["text"] === "string" && b["text"]) {
    return { content: { kind: "text", text: b["text"] as string } };
  }

  return { error: "The text field is required when no media is present.", field: "text" };
}

/** What gets stored in `message_logs` when `log_messages` is on. */
function summarise(b: Body): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["text", ...MEDIA_FIELDS, "fileName", "viewOnce", "mentions"]) {
    if (b[k] !== undefined) out[k] = b[k];
  }
  return out;
}
