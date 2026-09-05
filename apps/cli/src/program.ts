import { Command, CommanderError } from "commander";
import { registerApi } from "./commands/api.ts";
import { registerAuth } from "./commands/auth.ts";
import { registerContacts } from "./commands/contacts.ts";
import { registerGroups } from "./commands/groups.ts";
import { registerMedia } from "./commands/media.ts";
import { registerMessages } from "./commands/messages.ts";
import { registerOperator } from "./commands/operator.ts";
import { registerSandbox } from "./commands/sandbox.ts";
import { registerSessions } from "./commands/sessions.ts";
import { EXIT, red } from "./output.ts";

/**
 * The command tree, built but not run.
 *
 * Separate from `index.ts` so it can be constructed without parsing `process.argv` — the coverage
 * guard imports this to read what commands exist, and it would be absurd for that to execute one.
 */
export function buildProgram(): Command {
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
    .configureOutput({ outputError: (str, write) => write(red(str)) });

  registerAuth(program);
  registerSessions(program);
  registerMessages(program);
  registerContacts(program);
  registerGroups(program);
  registerMedia(program);
  registerSandbox(program);
  registerOperator(program);
  registerApi(program);

  return program;
}
