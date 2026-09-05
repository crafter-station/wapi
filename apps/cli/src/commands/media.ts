import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { Command } from "commander";
import { context, sessionClient } from "../client.ts";
import { EXIT, dim, emit, fail, green, info } from "../output.ts";

/**
 * Media — uploading something to send, and decrypting something received.
 *
 * The CLI reads the file itself and base64-encodes it, because "give me a path" is what somebody
 * types and "give me base64" is what the API takes. Guessing the MIME type from the extension is
 * the same bargain, with `--mimetype` to override when the guess is wrong.
 */
export function registerMedia(program: Command): void {
  const media = program.command("media").description("Upload files, decrypt received media");
  const session = (opts: { session?: string }) => (opts.session ? Number(opts.session) : undefined);

  media
      .command("upload")
      .argument("<file>", "path to the file")
      .option("--mimetype <type>", "override the type guessed from the extension")
      .option("--session <id>", "act on a specific session")
      .description("Upload a file and get a public URL to send")
      .action(async (file: string, opts: { mimetype?: string; session?: string }) => {
        const ctx = context(program.opts());

        let bytes: Buffer;
        try {
          bytes = readFileSync(file);
        } catch {
          fail(`Cannot read ${file}.`, EXIT.usage);
        }

        const client = await sessionClient(ctx, session(opts));
        const res = (await client.messages.media.upload({
          base64: bytes.toString("base64"),
          fileName: basename(file),
          mimetype: opts.mimetype ?? guessType(file),
        })) as { publicUrl?: string };

        // `publicUrl` sits at the top level rather than under `data`, so the SDK hands it back raw.
        emit(ctx.json, res, () => info(res.publicUrl ?? dim("Uploaded, but no URL came back.")));
      });

  media
      .command("decrypt")
      .argument("<json>", "the message node, as JSON")
      .option("--session <id>", "act on a specific session")
      .description("Decrypt received media and get a URL for it")
      .action(async (raw: string, opts: { session?: string }) => {
        const ctx = context(program.opts());
        let node: unknown;
        try {
          node = JSON.parse(raw);
        } catch {
          fail("That is not valid JSON. Pass the `message` object from the webhook payload.", EXIT.usage);
        }

        const client = await sessionClient(ctx, session(opts));
        const res = (await client.messages.media.decrypt(node as Record<string, unknown>)) as {
          publicUrl?: string;
        };
        emit(ctx.json, res, () => info(res.publicUrl ?? dim("Nothing to decrypt in that message.")));
      });

  program
      .command("read")
      .argument("<json>", "the WhatsApp message key, as JSON")
      .option("--session <id>", "act on a specific session")
      .description("Mark a received message as read")
      .action(async (raw: string, opts: { session?: string }) => {
        const ctx = context(program.opts());
        let key: unknown;
        try {
          key = JSON.parse(raw);
        } catch {
          /**
           * Keyed by the WhatsApp `key`, not our integer `msgId`, because the useful case is
           * marking somebody *else's* message read — and inbound messages have no row of ours.
           */
          fail("That is not valid JSON. Pass the `key` object from the webhook payload.", EXIT.usage);
        }

        const client = await sessionClient(ctx, session(opts));
        await client.messages.markRead(key as Parameters<typeof client.messages.markRead>[0]);
        info(`${green("✓")} Marked read.`);
      });

  program
      .command("react")
      .argument("<json>", "the WhatsApp message key, as JSON")
      .argument("[emoji]", "the emoji; omit to clear an existing reaction")
      .option("--session <id>", "act on a specific session")
      .description("React to a message, or clear a reaction")
      .action(async (raw: string, emoji: string | undefined, opts: { session?: string }) => {
        const ctx = context(program.opts());
        let key: unknown;
        try {
          key = JSON.parse(raw);
        } catch {
          fail("That is not valid JSON. Pass the `key` object from the webhook payload.", EXIT.usage);
        }

        const client = await sessionClient(ctx, session(opts));
        const parsed = key as Parameters<typeof client.messages.react>[0];
        // An empty emoji is WhatsApp's own way of clearing one, not a validation slip.
        if (emoji) await client.messages.react(parsed, emoji);
        else await client.messages.unreact(parsed);
        info(`${green("✓")} ${emoji ? `Reacted ${emoji}.` : "Reaction cleared."}`);
      });
}

/** Enough types to cover what people actually send. `--mimetype` handles the rest. */
function guessType(file: string): string {
  const known: Record<string, string> = {
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".ogg": "audio/ogg",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".txt": "text/plain",
    ".webp": "image/webp",
  };
  return known[extname(file).toLowerCase()] ?? "application/octet-stream";
}
