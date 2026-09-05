import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { accountClient, context, forgetSessionKey, sessionClient, sessionId, type Ctx } from "../client.ts";
import { cell, dim, emit, EXIT, fail, green, info, table } from "../output.ts";

/**
 * Sessions — one per linked WhatsApp number.
 *
 * These are the account-level routes, so they use the PAT. `connect` is the one that needs
 * patience: pairing is asynchronous, so it polls status rather than pretending the call is done
 * when the request returns.
 */
export function registerSessions(program: Command): void {
  const sessions = program.command("sessions").description("Manage linked numbers");

  sessions
    .command("list")
    .description("Every session on this account")
    .action(async () => {
      const ctx = context(program.opts());
      const rows = (await accountClient(ctx).sessions.list()) as SessionRow[];

      emit(ctx.json, rows, () => {
        if (!rows.length) return info(dim("No sessions. Create one with `wapi sessions create`."));
        table(
          ["ID", "NAME", "NUMBER", "STATUS", ""],
          rows.map((s) => [
            String(s.id),
            s.name ?? "",
            s.phone_number ?? "",
            statusColour(s.status),
            s.id === ctx.profile.sessionId ? green("← in use") : "",
          ]),
        );
      });
    });

  sessions
    .command("get")
    .argument("[id]", "session id; defaults to the one in use")
    .description("One session, in detail")
    .action(async (raw?: string) => {
      const ctx = context(program.opts());
      const id = raw ? Number(raw) : sessionId(ctx);
      const s = (await accountClient(ctx).sessions.get(id)) as SessionRow & {
        api_key?: string;
        webhook_url?: string | null;
      };

      emit(ctx.json, s, () => {
        table(
          ["", ""],
          [
            ["id", String(s.id)],
            ["name", cell(s.name)],
            ["number", cell(s.phone_number)],
            ["status", statusColour(s.status)],
            ["webhook", cell(s.webhook_url)],
            // Shown only on request: it is a credential, and printing it by default would put it
            // in scrollback and shell history for anyone reading a session's details.
            ["api key", s.api_key ? dim("(use --json to reveal)") : cell(null)],
          ],
        );
      });
    });

  sessions
    .command("create")
    .requiredOption("--name <name>", "what to call it")
    .requiredOption("--phone <number>", "the number to link, in E.164")
    .option("--account-protection", "pace sends to one per five seconds", false)
    .option("--log-messages", "store message content, not just metadata", false)
    .description("Create a session for a real number")
    .action(async (opts: { accountProtection: boolean; logMessages: boolean; name: string; phone: string }) => {
      const ctx = context(program.opts());
      /**
       * Both flags are required by the contract rather than defaulted server-side, so the CLI has
       * to take a position. Off, matching the dashboard: pacing is a deliberate trade against
       * throughput, and storing message content is a decision about other people's data.
       */
      const s = (await accountClient(ctx).sessions.create({
        account_protection: opts.accountProtection,
        log_messages: opts.logMessages,
        name: opts.name,
        phone_number: opts.phone,
      })) as SessionRow;

      emit(ctx.json, s, () => {
        info(`${green("✓")} Created session ${s.id}.`);
        info(dim("  Connect it with `wapi sessions connect`, then scan the QR with your phone."));
      });
    });

  sessions
    .command("delete")
    .argument("[id]", "session id; defaults to the one in use")
    .description("Delete a session and its credentials")
    .action(async (raw?: string) => {
      const ctx = context(program.opts());
      const id = raw ? Number(raw) : sessionId(ctx);

      await confirm(ctx, `Delete session ${id}? Its API key and stored messages go with it.`);
      await accountClient(ctx).sessions.delete(id);
      forgetSessionKey(ctx, id);
      info(`${green("✓")} Deleted session ${id}.`);
    });

  sessions
    .command("connect")
    .argument("[id]", "session id; defaults to the one in use")
    .option("--wait <seconds>", "how long to wait for pairing", "90")
    .description("Connect a session, showing the QR and waiting for it to pair")
    .action(async (raw: string | undefined, opts: { wait: string }) => {
      const ctx = context(program.opts());
      const id = raw ? Number(raw) : sessionId(ctx);
      const account = accountClient(ctx);

      const res = (await account.sessions.connection.connect(id)) as {
        qrCode?: string | null;
        status: string;
      };
      if (res.qrCode) {
        info("");
        info(dim("  Scan this with WhatsApp → Linked devices:"));
        info("");
        info(`  ${res.qrCode}`);
        info("");
      }

      /**
       * Poll, rather than stream.
       *
       * The dashboard watches this over SSE, but that rides on Redis fan-out and a long-lived
       * connection through the edge — a real operational commitment for a moment that lasts a few
       * seconds. Polling `GET /api/status` costs nothing and is honest about what it knows.
       */
      const session = await sessionClient(ctx, id);
      const deadline = Date.now() + Number(opts.wait) * 1000;
      let status = res.status;

      while (Date.now() < deadline && status.toLowerCase() !== "connected") {
        await new Promise((r) => setTimeout(r, 2000));
        status = await session.status().catch(() => status);
      }

      if (status.toLowerCase() === "connected") info(`${green("✓")} Session ${id} is connected.`);
      else fail(`Session ${id} is still ${status} after ${opts.wait}s.`, EXIT.failure);
    });

  for (const verb of ["disconnect", "restart"] as const) {
    sessions
      .command(verb)
      .argument("[id]", "session id; defaults to the one in use")
      .description(verb === "restart" ? "Restart a session's socket" : "Close a session's socket")
      .action(async (raw?: string) => {
        const ctx = context(program.opts());
        const id = raw ? Number(raw) : sessionId(ctx);
        const conn = accountClient(ctx).sessions.connection;
        await (verb === "restart" ? conn.restart(id) : conn.disconnect(id));
        info(`${green("✓")} Session ${id} ${verb === "restart" ? "restarting" : "disconnected"}.`);
      });
  }

  sessions
    .command("qr")
    .argument("[id]", "session id; defaults to the one in use")
    .description("The current QR code, if one is waiting to be scanned")
    .action(async (raw?: string) => {
      const ctx = context(program.opts());
      const id = raw ? Number(raw) : sessionId(ctx);
      const res = (await accountClient(ctx).sessions.connection.qrCode(id)) as {
        qrCode?: string | null;
      };

      emit(ctx.json, res, () => {
        if (!res.qrCode) return info(dim("No QR waiting. The session is paired or disconnected."));
        info(res.qrCode);
      });
    });

  sessions
    .command("regenerate-key")
    .argument("[id]", "session id; defaults to the one in use")
    .description("Rotate a session's API key")
    .action(async (raw?: string) => {
      const ctx = context(program.opts());
      const id = raw ? Number(raw) : sessionId(ctx);

      await confirm(ctx, `Rotate the API key for session ${id}? The old one stops working at once.`);
      const key = await accountClient(ctx).sessions.keys.regenerate(id);
      // The cached copy is now wrong; keeping it would fail every session-scoped command until
      // somebody worked out why.
      forgetSessionKey(ctx, id);

      emit(ctx.json, { api_key: key, id }, () => {
        info(`${green("✓")} Rotated. The new key is shown once:`);
        info(`  ${key}`);
      });
    });

  const logs = sessions.command("logs").description("What a session sent, and what happened to it");

  logs
    .command("messages")
    .argument("[id]", "session id; defaults to the one in use")
    .option("--page <n>", "page number", "1")
    .description("Messages sent through a session")
    .action(async (raw: string | undefined, opts: { page: string }) => {
      const ctx = context(program.opts());
      const id = raw ? Number(raw) : sessionId(ctx);
      const page = (await accountClient(ctx).sessions.logs.messages(id, {
        page: Number(opts.page),
      })) as Paged<MessageLogRow>;

      emit(ctx.json, page, () => {
        table(
          ["ID", "TO", "STATUS", "WHEN"],
          page.data.map((m) => [m.id, m.to, m.status, m.created_at]),
        );
        info(dim(`  page ${page.current_page} of ${Math.ceil(page.total / page.per_page) || 1}`));
      });
    });

  logs
    .command("activity")
    .argument("[id]", "session id; defaults to the one in use")
    .option("--page <n>", "page number", "1")
    .description("Status changes and restarts — what happened to the connection")
    .action(async (raw: string | undefined, opts: { page: string }) => {
      const ctx = context(program.opts());
      const id = raw ? Number(raw) : sessionId(ctx);
      const page = (await accountClient(ctx).sessions.logs.activity(id, {
        page: Number(opts.page),
      })) as Paged<{ event_type: string; occurred_at: string; status: string | null }>;

      emit(ctx.json, page, () => {
        table(
          ["EVENT", "STATUS", "WHEN"],
          page.data.map((r) => [r.event_type, cell(r.status), r.occurred_at]),
        );
      });
    });
}

type SessionRow = { id: number; name?: string; phone_number?: string; status: string };
type MessageLogRow = { created_at: string; id: string; status: string; to: string };
type Paged<T> = { current_page: number; data: T[]; per_page: number; total: number };

function statusColour(status: string): string {
  const s = status.toLowerCase();
  if (s === "connected") return green(status);
  if (s === "need_scan" || s === "connecting") return dim(status);
  return status;
}

/**
 * Confirm a destructive action.
 *
 * Off a TTY without `-y` this **refuses** rather than proceeding. Auto-confirming in a
 * non-interactive context is how a cron job deletes a live session at 3am; failing loudly is
 * recoverable, proceeding silently is not.
 */
export async function confirm(ctx: Ctx, question: string): Promise<void> {
  if (ctx.yes) return;
  if (!process.stdin.isTTY) {
    fail(`${question} Refusing to guess — pass --yes if you mean it.`, EXIT.usage);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) fail("Cancelled.", EXIT.ok);
  } finally {
    rl.close();
  }
}
