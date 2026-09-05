#!/usr/bin/env bun
import { CommanderError } from "commander";
import { buildProgram } from "./program.ts";
import { EXIT, fail } from "./output.ts";

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
 *
 * The tree itself lives in `program.ts`, so it can be built without being run.
 */

/**
 * One place where a failed request becomes an exit code.
 *
 * `401` and `403` both land on `3`: the credential is the problem either way, and the difference
 * — missing versus wrong kind — is in the message, where a person reads it, rather than in a
 * second code a script would have to learn.
 */
try {
  await buildProgram().parseAsync(process.argv);
} catch (err) {
  if (err instanceof CommanderError) process.exit(EXIT.usage);

  const status = (err as { status?: number }).status;
  const message = err instanceof Error ? err.message : String(err);
  if (status === 401 || status === 403) fail(message, EXIT.auth);
  fail(message, EXIT.failure);
}
