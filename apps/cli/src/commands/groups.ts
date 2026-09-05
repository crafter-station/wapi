import type { Command } from "commander";
import { context, sessionClient } from "../client.ts";
import { confirm } from "./sessions.ts";
import { cell, dim, emit, green, info, table } from "../output.ts";

/**
 * Groups — the largest noun, and the one to rehearse on a sandbox.
 *
 * Creating a group, adding participants, promoting and leaving all touch real people on a real
 * number. On a sandbox the participants are invented and the read-back works, which is why the
 * destructive ones here confirm before acting.
 */
export function registerGroups(program: Command): void {
  const groups = program.command("groups").description("Groups, participants and invites");
  const session = (opts: { session?: string }) => (opts.session ? Number(opts.session) : undefined);
  const sessionOpt = (cmd: Command) => cmd.option("--session <id>", "act on a specific session");

  sessionOpt(
    groups
        .command("list")
        .option("--page <n>", "page instead of listing all")
        .option("--limit <n>", "page size", "20")
        .description("Groups this session belongs to")
        .action(async (opts: { limit: string; page?: string; session?: string }) => {
          const ctx = context(program.opts());
          const client = await sessionClient(ctx, session(opts));
          const rows = opts.page
            ? ((await client.groups.page({ limit: Number(opts.limit), page: Number(opts.page) })) as {
                items: GroupRow[];
              }).items
            : ((await client.groups.list()) as GroupRow[]);

          emit(ctx.json, rows, () => {
            if (!rows.length) return info(dim("No groups."));
            table(
              ["JID", "NAME"],
              rows.map((g) => [g.jid ?? g.id ?? "", cell(g.name ?? g.subject)]),
            );
          });
        }),
    );

  sessionOpt(
    groups
        .command("create")
        .requiredOption("--name <name>", "the group subject")
        .requiredOption("--participants <list>", "comma-separated numbers or JIDs")
        .description("Create a group")
        .action(async (opts: { name: string; participants: string; session?: string }) => {
          const ctx = context(program.opts());
          await confirm(
            ctx,
            `Create "${opts.name}" and add ${opts.participants.split(",").length} people? They will be notified.`,
          );
          const client = await sessionClient(ctx, session(opts));
          const g = (await client.groups.create({ name: opts.name, participants: split(opts.participants) })) as GroupRow;
          emit(ctx.json, g, () => info(`${green("✓")} Created ${g.id ?? g.jid}.`));
        }),
    );

  sessionOpt(
    groups
        .command("metadata")
        .argument("<jid>")
        .description("Subject, owner, description and participants")
        .action(async (jid: string, opts: { session?: string }) => {
          const ctx = context(program.opts());
          const client = await sessionClient(ctx, session(opts));
          const g = (await client.groups.metadata(jid)) as GroupRow & { desc?: string | null; owner?: string };
          emit(ctx.json, g, () =>
            table(
              ["", ""],
              [
                ["jid", cell(g.jid ?? g.id)],
                ["subject", cell(g.subject ?? g.name)],
                ["owner", cell(g.owner)],
                ["description", cell(g.desc)],
              ],
            ),
          );
        }),
    );

  sessionOpt(
    groups
        .command("picture")
        .argument("<jid>")
        .description("A group's picture URL")
        .action(async (jid: string, opts: { session?: string }) => {
          const ctx = context(program.opts());
          const client = await sessionClient(ctx, session(opts));
          const res = (await client.groups.picture(jid)) as { imgUrl: string | null };
          emit(ctx.json, res, () =>
            info(res.imgUrl ?? dim("No picture. That is the ordinary answer, not an error.")),
          );
        }),
    );

  sessionOpt(
    groups
        .command("settings")
        .argument("<jid>")
        .option("--subject <text>", "rename the group")
        .option("--description <text>", "change the description")
        .option("--announce <bool>", "only admins may post")
        .option("--restrict <bool>", "only admins may edit group info")
        .option("--join-approval <bool>", "require approval to join")
        .option("--member-add <bool>", "let ordinary members add participants")
        .description("Change group settings; only what you pass is touched")
        .action(async (jid: string, opts: SettingsOptions) => {
          const ctx = context(program.opts());
          const body: Record<string, unknown> = {};
          if (opts.subject !== undefined) body["subject"] = opts.subject;
          if (opts.description !== undefined) body["description"] = opts.description;
          for (const key of ["announce", "restrict", "joinApproval", "memberAdd"] as const) {
            if (opts[key] !== undefined) body[key === "joinApproval" ? "joinApproval" : key] = bool(opts[key]!);
          }
          if (!Object.keys(body).length) {
            return info(dim("Nothing to change. Pass --subject, --description or a flag."));
          }

          const client = await sessionClient(ctx, session(opts));
          const res = await client.groups.updateSettings(jid, body);
          emit(ctx.json, res, () => {
            info(`${green("✓")} Updated.`);
            /**
             * WhatsApp applies these as separate calls with no transaction, so a partial failure
             * leaves the earlier ones applied. Saying so beats letting somebody discover it.
             */
            info(dim("  Applied one field at a time; a failure part-way leaves earlier changes in place."));
          });
        }),
    );

  sessionOpt(
    groups
        .command("leave")
        .argument("<jid>")
        .description("Leave a group")
        .action(async (jid: string, opts: { session?: string }) => {
          const ctx = context(program.opts());
          // Rejoining needs a fresh invite, so there is genuinely no undo.
          await confirm(ctx, `Leave ${jid}? Rejoining needs a new invite.`);
          const client = await sessionClient(ctx, session(opts));
          await client.groups.leave(jid);
          info(`${green("✓")} Left ${jid}.`);
        }),
    );

  sessionOpt(
    groups
        .command("invite-link")
        .argument("<jid>")
        .description("The group's invite link")
        .action(async (jid: string, opts: { session?: string }) => {
          const ctx = context(program.opts());
          const client = await sessionClient(ctx, session(opts));
          // This endpoint puts `inviteLink` at the top level, so the SDK returns a bare string.
          const link = await client.groups.inviteLink(jid);
          emit(ctx.json, { inviteLink: link }, () => info(link));
        }),
    );

  sessionOpt(
    groups
        .command("by-invite")
        .argument("<code>")
        .description("Inspect a group from an invite code without joining")
        .action(async (code: string, opts: { session?: string }) => {
          const ctx = context(program.opts());
          const client = await sessionClient(ctx, session(opts));
          const g = (await client.groups.byInvite(code)) as GroupRow & { size?: number };
          emit(ctx.json, g, () =>
            table(
              ["", ""],
              [
                ["id", cell(g.id ?? g.jid)],
                ["subject", cell(g.subject ?? g.name)],
                ["members", cell(g.size)],
              ],
            ),
          );
        }),
    );

  sessionOpt(
    groups
        .command("join")
        .argument("<code>", "an invite code, or the whole chat.whatsapp.com link")
        .description("Join a group by invite")
        .action(async (code: string, opts: { session?: string }) => {
          const ctx = context(program.opts());
          const client = await sessionClient(ctx, session(opts));
          // Accepting a pasted link is the common case; taking only the code would be pedantry.
          const res = (await client.groups.acceptInvite(code.split("/").pop() ?? code)) as { id: string };
          emit(ctx.json, res, () => info(`${green("✓")} Joined ${res.id}.`));
        }),
    );

  const participants = groups.command("participants").description("Who is in a group");

  sessionOpt(
    participants
        .command("list")
        .argument("<jid>")
        .description("List participants")
        .action(async (jid: string, opts: { session?: string }) => {
          const ctx = context(program.opts());
          const client = await sessionClient(ctx, session(opts));
          const rows = (await client.groups.participants.list(jid)) as ParticipantRow[];
          emit(ctx.json, rows, () =>
            table(["ID", "ROLE"], rows.map((p) => [p.id ?? p.jid ?? "", cell(p.admin)])),
          );
        }),
    );

  for (const verb of ["add", "remove"] as const) {
          sessionOpt(
        participants
          .command(verb)
          .argument("<jid>")
          .requiredOption("--participants <list>", "comma-separated numbers or JIDs")
          .description(`${verb === "add" ? "Add" : "Remove"} participants`)
          .action(async (jid: string, opts: { participants: string; session?: string }) => {
            const ctx = context(program.opts());
            await confirm(ctx, `${verb === "add" ? "Add" : "Remove"} ${split(opts.participants).length} people ${verb === "add" ? "to" : "from"} ${jid}?`);
            const client = await sessionClient(ctx, session(opts));
            const rows = (await client.groups.participants[verb](jid, split(opts.participants))) as ParticipantResult[];
            emit(ctx.json, rows, () => {
              // Per-participant status: the request can succeed while an individual does not.
              table(["JID", "STATUS", ""], rows.map((r) => [r.jid, String(r.status), cell(r.message)]));
            });
          }),
    );
  }

  sessionOpt(
    participants
        .command("update")
        .argument("<jid>")
        .argument("<action>", "promote or demote")
        .requiredOption("--participants <list>", "comma-separated numbers or JIDs")
        .description("Promote participants to admin, or demote them")
        .action(async (jid: string, action: string, opts: { participants: string; session?: string }) => {
          const ctx = context(program.opts());
          const client = await sessionClient(ctx, session(opts));
          const res = (await client.groups.participants.update(
            jid,
            split(opts.participants),
            action as "promote",
          )) as { participants: string[] };

          emit(ctx.json, res, () => {
            /**
             * This route reports `{participants: [jid]}` with no status, unlike add and remove.
             * Comparing what was sent against what came back is the only way to see a partial
             * failure, so the CLI does that comparison rather than leaving it to the reader.
             */
            const asked = split(opts.participants);
            const changed = new Set(res.participants);
            for (const jidAsked of asked) {
              const ok = changed.has(jidAsked) || changed.has(jidAsked.replace(/[^\d]/g, ""));
              info(`${ok ? green("✓") : dim("·")} ${jidAsked}${ok ? "" : dim("  unchanged")}`);
            }
          });
        }),
    );
}

const split = (list: string) => list.split(",").map((s) => s.trim()).filter(Boolean);
const bool = (v: string) => v === "true" || v === "1" || v === "yes";

type GroupRow = { id?: string; jid?: string; name?: string; subject?: string };
type ParticipantRow = { admin?: string | null; id?: string; jid?: string };
type ParticipantResult = { jid: string; message?: string; status: string | number };
type SettingsOptions = {
  announce?: string;
  description?: string;
  joinApproval?: string;
  memberAdd?: string;
  restrict?: string;
  session?: string;
  subject?: string;
};
