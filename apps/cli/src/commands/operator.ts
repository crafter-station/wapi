import type { Command } from "commander";
import { accountClient, context, sessionClient } from "../client.ts";
import { confirm } from "./sessions.ts";
import { cell, dim, emit, green, info, table, warn } from "../output.ts";

/**
 * Operator commands — tokens, the audit trail, webhook deliveries, and the doctor.
 *
 * These are what made the CLI worth a device flow rather than a pasted token: without them a
 * terminal could send messages but never answer "what did this account do" or "did my webhook
 * arrive", which are the questions you have when something is wrong.
 */
export function registerOperator(program: Command): void {
  const session = (opts: { session?: string }) => (opts.session ? Number(opts.session) : undefined);

  // -- tokens ---------------------------------------------------------------------------------
  const tokens = program.command("tokens").description("Personal Access Tokens");

  tokens
      .command("list")
      .description("Every token on the account, including revoked ones")
      .action(async () => {
        const ctx = context(program.opts());
        const rows = (await accountClient(ctx).tokens.list()) as TokenRow[];
        emit(ctx.json, rows, () =>
          table(
            ["ID", "NAME", "LAST USED", "STATE"],
            rows.map((t) => [
              String(t.id),
              t.name,
              cell(t.last_used_at),
              t.revoked_at ? dim("revoked") : green("active"),
            ]),
          ),
        );
      });

  tokens
      .command("create")
      .argument("<name>", "what this token is for, e.g. ci or laptop")
      .description("Mint a token")
      .action(async (name: string) => {
        const ctx = context(program.opts());
        const t = (await accountClient(ctx).tokens.create(name)) as TokenRow & { token: string };
        emit(ctx.json, t, () => {
          info(`${green("✓")} Token ${t.id} created.`);
          info("");
          info(`  ${t.token}`);
          info("");
          // Only the hash is stored, so there is genuinely no second chance.
          warn("Copy it now — only the hash is stored, so it cannot be shown again.");
        });
      });

  tokens
      .command("revoke")
      .argument("<id>")
      .description("Revoke a token")
      .action(async (raw: string) => {
        const ctx = context(program.opts());
        await confirm(ctx, `Revoke token ${raw}? Anything using it stops working immediately.`);
        const message = await accountClient(ctx).tokens.revoke(Number(raw));
        info(`${green("✓")} ${message}`);
      });

  // -- audit ----------------------------------------------------------------------------------
  const audit = program.command("audit").description("Every call made with this account's credentials");

  audit
      .command("list")
      .option("--page <n>", "page number", "1")
      .option("--per-page <n>", "page size", "15")
      .option("--session <id>", "narrow to one session's calls")
      .description("Recent calls, newest first")
      .action(async (opts: { page: string; perPage: string; session?: string }) => {
        const ctx = context(program.opts());
        const page = (await accountClient(ctx).audit.page({
          page: Number(opts.page),
          perPage: Number(opts.perPage),
          sessionId: opts.session ? Number(opts.session) : undefined,
        })) as Paged<AuditRow>;

        emit(ctx.json, page, () => {
          table(
            ["ID", "METHOD", "PATH", "STATUS", "AS", "WHEN"],
            page.data.map((r) => [
              String(r.id),
              r.method,
              r.path,
              r.status >= 400 ? String(r.status) : dim(String(r.status)),
              cell(r.credential_kind),
              r.created_at,
            ]),
          );
          info(dim(`  ${page.total} total`));
        });
      });

  audit
      .command("get")
      .argument("<id>")
      .description("One call, with the bodies the list omits")
      .action(async (raw: string) => {
        const ctx = context(program.opts());
        const row = (await accountClient(ctx).audit.get(Number(raw))) as AuditRow & {
          request_body: string | null;
          response_body: string | null;
        };
        emit(ctx.json, row, () => {
          table(
            ["", ""],
            [
              ["method", row.method],
              ["path", row.path],
              ["status", String(row.status)],
              ["as", cell(row.credential_kind)],
              ["ip", cell(row.ip)],
              ["when", row.created_at],
            ],
          );
          if (row.request_body) info(`\n${dim("request")}\n${row.request_body}`);
          if (row.response_body) info(`\n${dim("response")}\n${row.response_body}`);
          if (!row.request_body && !row.response_body) {
            // Absent is normal: capture is opt-in and the retention sweep nulls them weekly.
            info(dim("\n  No bodies stored. Capture is opt-in, and they are cleared after a week."));
          }
        });
      });

  // -- dispatches -----------------------------------------------------------------------------
  program
      .command("dispatches")
      .option("--page <n>", "page number", "1")
      .option("--session <id>", "act on a specific session")
      .description("Webhook deliveries for this session")
      .action(async (opts: { page: string; session?: string }) => {
        const ctx = context(program.opts());
        const client = await sessionClient(ctx, session(opts));
        const page = (await client.dispatches.page({ page: Number(opts.page) })) as Paged<DispatchRow>;

        emit(ctx.json, page, () => {
          if (!page.data.length) return info(dim("No deliveries yet."));
          table(
            ["EVENT", "STATUS", "CODE", "TRIES", "LAST ERROR"],
            page.data.map((d) => [
              d.event,
              d.status === "delivered" ? green(d.status) : d.status,
              cell(d.status_code),
              // One row per event, updated in place — five attempts is this number, not five rows.
              String(d.attempts),
              cell(d.last_error),
            ]),
          );
        });
      });

  // -- doctor ---------------------------------------------------------------------------------
  /**
   * Runs entirely client-side, which is why it needed no endpoint of its own: every check is an
   * ordinary API call a session key can make. It prints and exits without storing anything — the
   * only consumer of a stored run is a dashboard panel saying "last checked", and a check you
   * just ran is already in front of you.
   */
  program
    .command("doctor")
    .option("--session <id>", "act on a specific session")
    .description("Check a session end to end and say what is wrong")
    .action(async (opts: { session?: string }) => {
      const ctx = context(program.opts());
      const client = await sessionClient(ctx, session(opts));
      const results: { detail: string; name: string; state: "fail" | "ok" | "skipped" }[] = [];

      const step = async (name: string, run: () => Promise<string>) => {
        try {
          results.push({ detail: await run(), name, state: "ok" });
        } catch (err) {
          results.push({ detail: err instanceof Error ? err.message : String(err), name, state: "fail" });
        }
      };

      await step("Connection", async () => {
        const status = await client.status();
        if (status.toLowerCase() !== "connected") throw new Error(`status is ${status}`);
        return status;
      });
      await step("Identity", async () => {
        // `id`, not `jid`: this response is keyed the way theirs is, and reading the wrong key
        // reported "unknown" for a session that was answering perfectly.
        const user = (await client.user()) as { id?: string };
        if (!user.id) throw new Error("no identity returned");
        return user.id;
      });
      await step("Directory", async () => {
        const [contacts, groups] = await Promise.all([
          client.contacts.page({ limit: 1 }),
          client.groups.page({ limit: 1 }),
        ]);
        const c = (contacts as { pagination?: { total?: number } }).pagination?.total ?? 0;
        const g = (groups as { pagination?: { total?: number } }).pagination?.total ?? 0;
        return `${c} contacts, ${g} groups`;
      });
      await step("Webhook delivery", async () => {
        const page = (await client.dispatches.page({ perPage: 5 })) as Paged<DispatchRow>;
        if (!page.data.length) throw new Error("no deliveries recorded yet");
        const failed = page.data.filter((d) => d.status !== "delivered");
        if (failed.length) throw new Error(`${failed.length} of the last ${page.data.length} failed`);
        return `last ${page.data.length} delivered`;
      });

      const verdict = results.some((r) => r.state === "fail") ? "problems found" : "healthy";
      emit(ctx.json, { checks: results, verdict }, () => {
        for (const r of results) {
          const mark = r.state === "ok" ? green("✓") : r.state === "fail" ? "✗" : dim("·");
          info(`${mark} ${r.name.padEnd(18)} ${dim(r.detail)}`);
        }
        info("");
        info(verdict === "healthy" ? green("  healthy") : `  ${verdict}`);
      });
    });
}

type TokenRow = { id: number; last_used_at: string | null; name: string; revoked_at: string | null };
type AuditRow = {
  created_at: string;
  credential_kind: string | null;
  id: number;
  ip: string | null;
  method: string;
  path: string;
  status: number;
};
type DispatchRow = {
  attempts: number;
  event: string;
  last_error: string | null;
  status: string;
  status_code: number | null;
};
type Paged<T> = { current_page: number; data: T[]; per_page: number; total: number };
