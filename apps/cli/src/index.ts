#!/usr/bin/env bun
import { Command, CommanderError } from "commander";
import { registerApi } from "./commands/api.ts";
import { registerAuth } from "./commands/auth.ts";
import { registerMessages } from "./commands/messages.ts";
import { registerSessions } from "./commands/sessions.ts";
import { EXIT, fail, red } from "./output.ts";

/**
 * The wapi CLI.
 *
 * Everything the dashboard and the API can do, from a terminal. It is a pure API client — one
 * Personal Access Token does all of it, because a PAT can read any session's key on demand — so
 * it works against the hosted deployment and against a stack you booted yourself, chosen by
 * profile.
 *
 * Commands mirror the SDK's nouns exactly, so the SDK docs, the guide and this all teach the same
 * vocabulary. `wapi send` is the single alias, because it is the hello-world; every further alias
 * would be a second name to document and keep true.
 */

const program = new Command();

program
  .name("wapi")
  .description("WhatsApp over HTTP — sessions, messages, contacts, groups, sandboxes")
  .version("0.1.0")
  .option("--json", "machine-readable output")
  .option("--profile <name>", "use a named profile")
  .option("-y, --yes", "skip confirmation prompts")
  /**
   * Commander exits `1` on a usage error and we promised `2`. Overriding is a few lines; letting
   * it stand would make the exit-code contract a lie in exactly the case scripts hit most.
   */
  .exitOverride((err: CommanderError) => {
    if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
      process.exit(EXIT.ok);
    }
    if (err.code === "commander.help") process.exit(EXIT.ok);
    process.exit(EXIT.usage);
  })
  .configureOutput({
    outputError: (str, write) => write(red(str)),
  });

registerAuth(program);
registerSessions(program);
registerMessages(program);
registerApi(program);

/**
 * One place where a failed request becomes an exit code.
 *
 * `401` and `403` both land on `3`: the credential is the problem either way, and the difference
 * — missing versus wrong kind — is in the message, where a person reads it, rather than in a
 * second code a script would have to learn.
 */
try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof CommanderError) process.exit(EXIT.usage);

  const status = (err as { status?: number }).status;
  const message = err instanceof Error ? err.message : String(err);
  if (status === 401 || status === 403) fail(message, EXIT.auth);
  fail(message, EXIT.failure);
}
