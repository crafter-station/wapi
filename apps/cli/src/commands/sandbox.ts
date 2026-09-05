import type { Command } from "commander";
import { accountClient, context, sessionClient } from "../client.ts";
import { saveProfile } from "../config.ts";
import { cell, dim, emit, green, info } from "../output.ts";

/**
 * The sandbox — a fake number on a fake WhatsApp.
 *
 * The most useful thing in the CLI for anybody building an integration: no phone, no QR, nothing
 * to ban, and `inbound` produces a genuine signed webhook delivery to whatever URL the session is
 * pointed at. It is also the only safe place to rehearse the writes — creating groups, adding
 * participants, blocking somebody — because there the participants are invented.
 */
export function registerSandbox(program: Command): void {
  const sandbox = program.command("sandbox").description("A fake number on a fake WhatsApp");
  const session = (opts: { session?: string }) => (opts.session ? Number(opts.session) : undefined);

  sandbox
      .command("create")
      .option("--name <name>", "what to call it", "sandbox")
      .option("--use", "pin it as the session for subsequent commands", false)
      .description("Create a sandbox session")
      .action(async (opts: { name: string; use: boolean }) => {
        const ctx = context(program.opts());
        const s = (await accountClient(ctx).sandbox.createSession(opts.name)) as {
          api_key: string;
          id: number;
          phone_number: string;
        };

        if (opts.use) {
          // Cache the key we were just handed rather than fetching it back a moment later.
          saveProfile(ctx.profileName, {
            sessionId: s.id,
            sessionKeys: { ...(ctx.profile.sessionKeys ?? {}), [String(s.id)]: s.api_key },
          });
        }

        emit(ctx.json, s, () => {
          info(`${green("✓")} Sandbox ${s.id} on ${s.phone_number}.`);
          info(dim("  Connect it with `wapi sessions connect` — it pairs itself, no QR to scan."));
          if (!opts.use) info(dim(`  Pin it with \`wapi use ${s.id}\`, or pass --use next time.`));
        });
      });

  sandbox
      .command("scan")
      .option("--session <id>", "act on a specific session")
      .description("Finish pairing now instead of waiting for the timer")
      .action(async (opts: { session?: string }) => {
        const ctx = context(program.opts());
        const client = await sessionClient(ctx, session(opts));
        await client.sandbox.scan();
        info(`${green("✓")} Paired.`);
      });

  sandbox
      .command("inbound")
      .argument("<text>", "what the fake contact says")
      .option("--from <jid>", "which contact; defaults to the first")
      .option("--session <id>", "act on a specific session")
      .description("Fabricate a message TO this session — fires your webhook for real")
      .action(async (text: string, opts: { from?: string; session?: string }) => {
        const ctx = context(program.opts());
        const client = await sessionClient(ctx, session(opts));
        const res = await client.sandbox.inbound(text, opts.from);
        emit(ctx.json, res, () => {
          info(`${green("✓")} Delivered.`);
          // The point of the whole feature, said out loud.
          info(dim("  Your webhook handler just received a genuine, signed messages.received."));
        });
      });

  sandbox
      .command("thread")
      .option("--session <id>", "act on a specific session")
      .option("-f, --follow", "keep printing new messages as they arrive", false)
      .description("The fake conversation, both directions")
      .action(async (opts: { follow: boolean; session?: string }) => {
        const ctx = context(program.opts());
        const client = await sessionClient(ctx, session(opts));

        const render = (rows: ThreadRow[], from: number) => {
          for (const m of rows.slice(from)) {
            const arrow = m.from_me ? green("→") : dim("←");
            info(`${arrow} ${cell(m.text ?? `[${m.kind}]`)}  ${dim(m.jid)}`);
          }
        };

        const first = (await client.sandboxThread.list()) as ThreadRow[];
        if (ctx.json && !opts.follow) return emit(true, first, () => {});
        render(first, 0);
        if (!opts.follow) return;

        /**
         * Polling, not streaming.
         *
         * The dashboard watches this over SSE, but that rides on Redis fan-out and a long-lived
         * connection through the edge — real infrastructure for a conversation that is, by
         * construction, a few messages long. Two seconds is imperceptible here.
         */
        let seen = first.length;
        for (;;) {
          await new Promise((r) => setTimeout(r, 2000));
          const rows = (await client.sandboxThread.list().catch(() => null)) as ThreadRow[] | null;
          if (!rows) continue;
          // A gateway restart resets the sandbox to its fixtures, so the thread can get *shorter*.
          if (rows.length < seen) seen = 0;
          render(rows, seen);
          seen = rows.length;
        }
      });
}

type ThreadRow = { at: string; from_me: boolean; id: string; jid: string; kind: string; text: string | null };
