import type { Command } from "commander";
import { context, sessionClient } from "../client.ts";
import { confirm } from "./sessions.ts";
import { cell, dim, emit, EXIT, fail, green, info, table } from "../output.ts";

/**
 * Messages — the session-scoped half, and the reason most people install a CLI at all.
 *
 * `wapi send` is registered as a top-level alias because it is the hello-world. It is the only
 * alias in the CLI: every further one is a second name to document, keep true, and explain when
 * the two drift.
 */
export function registerMessages(program: Command): void {
  const messages = program.command("messages").description("Send, edit, delete and inspect");

  const sendAction = async (opts: SendOptions) => {
    const ctx = context(program.opts());
    const client = await sessionClient(ctx, opts.session ? Number(opts.session) : undefined);

    const content: Record<string, unknown> = {};
    if (opts.text) content["text"] = opts.text;
    if (opts.image) content["imageUrl"] = opts.image;
    if (opts.video) content["videoUrl"] = opts.video;
    if (opts.document) content["documentUrl"] = opts.document;
    if (opts.audio) content["audioUrl"] = opts.audio;
    if (opts.sticker) content["stickerUrl"] = opts.sticker;

    /**
     * Checked here rather than left to the server, because the server's answer — a 422 naming a
     * field — reads oddly when the user typed flags. The cast that follows is deliberate: the
     * SDK's input is a union with one content field required, and a CLI assembles that union at
     * runtime from whichever flags were passed.
     */
    if (!Object.keys(content).length) {
      fail("Nothing to send. Pass --text, or one of --image/--video/--document/--audio/--sticker.", EXIT.usage);
    }

    const res = (await client.messages.send({
      to: opts.to,
      ...content,
    } as Parameters<typeof client.messages.send>[0])) as {
      jid: string;
      msgId: number;
      status: string;
    };

    emit(ctx.json, res, () => {
      info(`${green("✓")} Sent. msgId ${res.msgId} → ${res.jid} (${res.status})`);
      /**
       * Said every time on purpose. A timeout here means the request failed, not that the message
       * was undelivered — and the instinct to re-run the command is exactly how somebody sends
       * the same thing twice to a customer.
       */
      info(dim("  If a send times out, reconcile with `wapi messages info <msgId>` — never re-send blindly."));
    });
  };

  const withSendOptions = (cmd: Command) =>
    cmd
      .requiredOption("--to <recipient>", "phone number, JID, or a group JID ending @g.us")
      .option("--text <text>", "text body, or a caption alongside media")
      .option("--image <url>", "image URL")
      .option("--video <url>", "video URL")
      .option("--document <url>", "document URL")
      .option("--audio <url>", "audio URL")
      .option("--sticker <url>", "sticker URL")
      .option("--session <id>", "act on a specific session");

  withSendOptions(messages.command("send").description("Send a message")).action(sendAction);

  /** The one alias. `wapi send --to … --text …` is what somebody types first. */
  withSendOptions(
    program.command("send").description("Send a message (alias for `messages send`)"),
  ).action(sendAction);

  messages
    .command("info")
    .argument("<msgId>", "the integer id a send returned")
    .option("--session <id>", "act on a specific session")
    .description("What WhatsApp knows about a sent message")
    .action(async (msgId: string, opts: { session?: string }) => {
      const ctx = context(program.opts());
      const client = await sessionClient(ctx, opts.session ? Number(opts.session) : undefined);
      const res = (await client.messages.info(Number(msgId))) as Record<string, unknown>;

      emit(ctx.json, res, () => {
        table(
          ["", ""],
          [
            ["msgId", cell(res["msgId"])],
            ["to", cell(res["remoteJid"])],
            // A number here, not a word: 0 error, 1 pending, 2 sent, 3 delivered, 4 read. It is
            // WhatsApp's own enum, and it does not match what a send returns.
            ["status", cell(res["status"])],
            ["timestamp", cell(res["messageTimestamp"])],
          ],
        );
      });
    });

  messages
    .command("edit")
    .argument("<msgId>")
    .requiredOption("--text <text>", "the corrected text")
    .option("--session <id>", "act on a specific session")
    .description("Edit a message you sent, within WhatsApp's short window")
    .action(async (msgId: string, opts: { session?: string; text: string }) => {
      const ctx = context(program.opts());
      const client = await sessionClient(ctx, opts.session ? Number(opts.session) : undefined);
      const res = await client.messages.edit(Number(msgId), opts.text);

      emit(ctx.json, res, () => {
        info(`${green("✓")} Edited ${msgId}.`);
        info(dim("  WhatsApp allows this only briefly after sending, and will not say how long is left."));
      });
    });

  messages
    .command("delete")
    .argument("<msgId>")
    .option("--session <id>", "act on a specific session")
    .description("Delete a message for everyone")
    .action(async (msgId: string, opts: { session?: string }) => {
      const ctx = context(program.opts());
      await confirm(ctx, `Delete message ${msgId} for everyone?`);
      const client = await sessionClient(ctx, opts.session ? Number(opts.session) : undefined);
      info(`${green("✓")} ${await client.messages.delete(Number(msgId))}`);
    });

  messages
    .command("resend")
    .argument("<msgId>")
    .option("--session <id>", "act on a specific session")
    .description("Retry a message whose status is failed")
    .action(async (msgId: string, opts: { session?: string }) => {
      const ctx = context(program.opts());
      const client = await sessionClient(ctx, opts.session ? Number(opts.session) : undefined);
      info(`${green("✓")} ${await client.messages.resend(Number(msgId))}`);
    });
}

type SendOptions = {
  audio?: string;
  document?: string;
  image?: string;
  session?: string;
  sticker?: string;
  text?: string;
  to: string;
  video?: string;
};
