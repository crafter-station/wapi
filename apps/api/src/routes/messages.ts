import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { messages, whatsappSessions, type Db } from "@wapi/db";
import { ok, fail, postApiSendMessageBody } from "@wapi/contracts";
import { validationFailure, resolveRecipient } from "@wapi/core";
import { gateway, GatewayUnavailableError, SessionNotConnectedError } from "../gateway-client.ts";

/**
 * `POST /api/send-message` — PLAN.md §8 phase 3, text only for now.
 *
 * This is the one polymorphic endpoint their docs describe fourteen times. The contract
 * already merges those variants; this handler implements the `text` branch and rejects the
 * media branches explicitly rather than silently ignoring them, because a 200 for a message
 * that was never sent is the worst possible answer.
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
    const b = parsed.data;

    const mediaField = (["imageUrl", "videoUrl", "documentUrl", "audioUrl", "stickerUrl"] as const).find(
      (k) => b[k] !== undefined,
    );
    if (mediaField || b.contact || b.location || b.poll) {
      return c.json(fail(`Sending ${mediaField ?? "this message type"} is not implemented yet.`), 501);
    }
    if (!b.text) {
      return c.json(
        validationFailure({
          issues: [{ path: ["text"], message: "The text field is required when no media is present." }],
        }),
        422,
      );
    }

    // Baileys needs a JID; a bare number fails deep inside jidDecode with an error that
    // says nothing about the real problem.
    const recipient = resolveRecipient(b.to);
    if (!recipient.ok) {
      return c.json(validationFailure({ issues: [{ path: ["to"], message: recipient.reason }] }), 422);
    }

    const [session] = await db
      .select()
      .from(whatsappSessions)
      .where(eq(whatsappSessions.id, auth.sessionId))
      .limit(1);
    if (!session) return c.json(fail("The specified session was not found."), 404);

    /**
     * `replyTo` takes our integer `msgId`, not WhatsApp's key — which is exactly why the
     * sequence is global (PLAN.md §1.2). Resolve it to the stored WhatsApp key.
     */
    let quoted: Record<string, unknown> | undefined;
    if (b.replyTo !== undefined) {
      const [q] = await db
        .select({ waKey: messages.waKey, content: messages.content, sessionId: messages.sessionId })
        .from(messages)
        .where(eq(messages.msgId, b.replyTo))
        .limit(1);
      if (!q || q.sessionId !== auth.sessionId) {
        return c.json(fail("The message to reply to was not found."), 404);
      }
      /**
       * Baileys wants a whole WAMessage to quote, not just a key. We store the key and the
       * text, so a minimal stub is reconstructed here. If log_messages was off the body is
       * unavailable and the quote degrades to an empty conversation rather than failing.
       */
      const text = (q.content as { text?: string } | null)?.text ?? "";
      quoted = { key: q.waKey, message: { conversation: text } };
    }

    try {
      const sent = await gateway.sendText(auth.sessionId, recipient.jid, b.text, quoted);

      // The integer msgId is minted here, by the database sequence — not by WhatsApp.
      const [row] = await db
        .insert(messages)
        .values({
          sessionId: auth.sessionId,
          waKey: sent.key,
          remoteJid: sent.remoteJid,
          fromMe: true,
          status: "in_progress",
          content: session.logMessages ? { text: b.text } : null,
        })
        .returning({ msgId: messages.msgId });

      // Their documented shape: `jid` echoes the recipient as supplied, not normalised.
      return c.json(ok({ msgId: row!.msgId, jid: b.to, status: "in_progress" }));
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
