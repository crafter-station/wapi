import type { Command } from "commander";
import { context, sessionClient } from "../client.ts";
import { cell, dim, emit, green, info, table } from "../output.ts";

/**
 * Contacts, and the identity resolution that goes with them.
 *
 * All session-scoped. The consistent surprise here is that absence is a *success*: a contact with
 * no picture and an account with no username both answer `null` inside a `200`, because WhatsApp
 * volunteers neither and offers no way to ask. Every command below says so rather than printing
 * an empty line and leaving somebody to wonder whether it worked.
 */
export function registerContacts(program: Command): void {
  const contacts = program.command("contacts").description("The address book, and who is on WhatsApp");
  const session = (opts: { session?: string }) => (opts.session ? Number(opts.session) : undefined);
  const withSession = (cmd: Command) => cmd.option("--session <id>", "act on a specific session");

  withSession(
    contacts
      .command("list")
      .option("--page <n>", "page through them instead of listing all")
      .option("--limit <n>", "page size", "20")
      .description("Known contacts")
      .action(async (opts: { limit: string; page?: string; session?: string }) => {
        const ctx = context(program.opts());
        const client = await sessionClient(ctx, session(opts));

        /**
         * `list()` and `page()` return different shapes, not the same one with metadata, so which
         * you get follows from whether you asked to paginate.
         */
        const rows = opts.page
          ? (
              (await client.contacts.page({
                limit: Number(opts.limit),
                page: Number(opts.page),
              })) as { items: ContactRow[] }
            ).items
          : ((await client.contacts.list()) as ContactRow[]);

        emit(ctx.json, rows, () => {
          if (!rows.length) return info(dim("No contacts yet. They are learned from traffic."));
          table(
            ["NAME", "NUMBER", "JID"],
            rows.map((c) => [cell(c.name ?? c.notify), cell(c.phoneNumber), c.jid ?? ""]),
          );
        });
      }),
  );

  withSession(
    contacts
      .command("get")
      .argument("<number>", "phone number or JID")
      .description("One contact")
      .action(async (number: string, opts: { session?: string }) => {
        const ctx = context(program.opts());
        const client = await sessionClient(ctx, session(opts));
        const c = (await client.contacts.get(number)) as ContactRow & { id?: string };
        // Keyed on `id` here where the list is keyed on `jid` — theirs, reproduced.
        emit(ctx.json, c, () =>
          table(
            ["", ""],
            [
              ["id", cell(c.id)],
              ["name", cell(c.name)],
              ["number", cell(c.phoneNumber)],
              ["status", cell(c.status)],
            ],
          ),
        );
      }),
  );

  withSession(
    contacts
      .command("save")
      .argument("<jid>", "the contact's JID")
      .option("--name <name>", "the name to store")
      .description("Save a contact's name in this session's address book")
      .action(async (jid: string, opts: { name?: string; session?: string }) => {
        const ctx = context(program.opts());
        const client = await sessionClient(ctx, session(opts));
        const res = await client.contacts.save(jid, opts.name);
        emit(ctx.json, res, () => {
          info(`${green("✓")} Saved.`);
          // Worth saying every time: this name is wapi's, not WhatsApp's.
          info(dim("  Stored by wapi. It does not appear on the linked phone."));
        });
      }),
  );

  for (const verb of ["block", "unblock"] as const) {
    withSession(
      contacts
        .command(verb)
        .argument("<number>", "phone number or JID")
        .description(`${verb === "block" ? "Block" : "Unblock"} a contact`)
        .action(async (number: string, opts: { session?: string }) => {
          const ctx = context(program.opts());
          const client = await sessionClient(ctx, session(opts));
          const res = (await client.contacts[verb](number)) as { message: string };
          emit(ctx.json, res, () => info(`${green("✓")} ${res.message}`));
        }),
    );
  }

  withSession(
    contacts
      .command("picture")
      .argument("<number>", "phone number or JID")
      .description("A contact's profile picture URL")
      .action(async (number: string, opts: { session?: string }) => {
        const ctx = context(program.opts());
        const client = await sessionClient(ctx, session(opts));
        const res = (await client.contacts.picture(number)) as { imgUrl: string | null };
        emit(ctx.json, res, () => {
          // Not an error, and said plainly: most accounts have none or restrict it to contacts.
          if (!res.imgUrl) {
            return info(dim("No picture. Most accounts have none, or show it only to contacts."));
          }
          info(res.imgUrl);
        });
      }),
  );

  withSession(
    program
      .command("on-whatsapp")
      .argument("<number>", "phone number")
      .description("Whether a number is registered on WhatsApp")
      .action(async (number: string, opts: { session?: string }) => {
        const ctx = context(program.opts());
        const client = await sessionClient(ctx, session(opts));
        const res = (await client.contacts.onWhatsApp(number)) as {
          exists: boolean;
          jid: string | null;
        };
        emit(ctx.json, res, () =>
          info(res.exists ? `${green("✓")} ${cell(res.jid)}` : dim("Not on WhatsApp.")),
        );
      }),
  );

  const lid = program.command("lid").description("Resolve between phone numbers and LIDs");

  withSession(
    lid
      .command("from-phone")
      .argument("<number>")
      .description("The LID for a phone number")
      .action(async (number: string, opts: { session?: string }) => {
        const ctx = context(program.opts());
        const client = await sessionClient(ctx, session(opts));
        info(await client.contacts.lid.fromPhone(number));
      }),
  );

  withSession(
    lid
      .command("to-phone")
      .argument("<lid>")
      .description("The phone number behind a LID, where one is known")
      .action(async (value: string, opts: { session?: string }) => {
        const ctx = context(program.opts());
        const client = await sessionClient(ctx, session(opts));
        const phone = await client.contacts.lid.toPhone(value);
        // A miss is legitimate: resolution only works reliably in one direction.
        if (!phone) return info(dim("No mapping observed for that LID."));
        info(phone);
      }),
  );

  withSession(
    program
      .command("username")
      .argument("<identifier>", "phone number or JID")
      .description("A contact's WhatsApp @username, if they have one")
      .action(async (identifier: string, opts: { session?: string }) => {
        const ctx = context(program.opts());
        const client = await sessionClient(ctx, session(opts));
        const res = (await client.fetchUsername(identifier)) as { username: string | null };
        emit(ctx.json, res, () =>
          info(res.username ?? dim("No username. Most accounts have not set one.")),
        );
      }),
  );

  withSession(
    program
      .command("presence")
      .argument("<jid>", "who to tell")
      .argument("<type>", "unavailable | available | composing | recording | paused")
      .description("Send a typing or recording indicator")
      .action(async (jid: string, type: string, opts: { session?: string }) => {
        const ctx = context(program.opts());
        const client = await sessionClient(ctx, session(opts));
        const res = await client.sendPresence(jid, type as "composing");
        emit(ctx.json, res, () => {
          info(`${green("✓")} Sent ${type}.`);
          // WhatsApp acknowledges nothing, so this is the honest limit of what we know.
          info(dim("  Fire-and-forget: the frame left, which is not the same as anybody seeing it."));
        });
      }),
  );

  withSession(
    program
      .command("user")
      .description("The WhatsApp identity behind a session key")
      .action(async (opts: { session?: string }) => {
        const ctx = context(program.opts());
        const client = await sessionClient(ctx, session(opts));
        const res = (await client.user()) as Record<string, unknown>;
        emit(ctx.json, res, () =>
          table(
            ["", ""],
            [
              // `id`, not `jid` — this response is keyed the way theirs is.
              ["id", cell(res["id"])],
              ["lid", cell(res["lid"])],
              ["name", cell(res["name"])],
            ],
          ),
        );
      }),
  );

  withSession(
    program
      .command("status")
      .description("Whether a session is connected")
      .action(async (opts: { session?: string }) => {
        const ctx = context(program.opts());
        const client = await sessionClient(ctx, session(opts));
        const status = await client.status();
        emit(ctx.json, { status }, () => info(status));
      }),
  );
}

type ContactRow = {
  jid?: string;
  name?: string | null;
  notify?: string | null;
  phoneNumber?: string | null;
  status?: string | null;
};
