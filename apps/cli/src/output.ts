/**
 * How the CLI talks back.
 *
 * Two rules, both chosen against the obvious alternative:
 *
 * **Format never changes with the terminal.** Human-readable by default, JSON only when `--json`
 * is asked for. Switching format because stdout is a pipe is the kind of cleverness that turns
 * `wapi sessions list | less` into a wall of JSON and gets filed as a bug. *Colour* does follow
 * the terminal, because that is what everyone expects and nothing parses it.
 *
 * **Exit codes are part of the contract.** `3` is reserved for authentication, and specifically
 * for the wrong-credential-kind confusion this API produces: a `403` that reads like a
 * permissions problem and is really a configuration one. A script can branch on it without
 * parsing English.
 */

export const EXIT = {
  /** Valid credential of the wrong kind, or no credential at all. */
  auth: 3,
  failure: 1,
  ok: 0,
  /** Bad flags, missing arguments — the user's invocation, not the server's answer. */
  usage: 2,
} as const;

const useColour =
  process.stdout.isTTY === true && !process.env["NO_COLOR"] && process.env["TERM"] !== "dumb";

/** ESC from its code point. A raw control byte in source is invisible and easy to mangle. */
const ESC = String.fromCharCode(27);

const wrap = (code: number, text: string) =>
  useColour ? ESC + `[${code}m` + text + ESC + `[0m` : text;

export const dim = (t: string) => wrap(2, t);
export const bold = (t: string) => wrap(1, t);
export const red = (t: string) => wrap(31, t);
export const green = (t: string) => wrap(32, t);
export const yellow = (t: string) => wrap(33, t);

/** `--json` prints the payload verbatim, so it composes with `jq` without a translation layer. */
export function emit(json: boolean, payload: unknown, human: () => void): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  human();
}

export function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`${yellow("!")} ${message}\n`);
}

/** Errors go to stderr so `--json` output on stdout stays parseable when something fails. */
export function fail(message: string, code: number = EXIT.failure): never {
  process.stderr.write(`${red("✗")} ${message}\n`);
  process.exit(code);
}

/**
 * A table that stays readable when a column is empty.
 *
 * Deliberately not a dependency: padding columns is twenty lines, and a table library would be
 * one more thing compiled into every binary for something this small.
 */
export function table(headers: string[], rows: string[][]): void {
  if (!rows.length) return;
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => (c ?? "").padEnd(widths[i]!)).join("  ").trimEnd();

  info(dim(line(headers)));
  for (const row of rows) info(line(row));
}

/** `null` and `undefined` render as a dash rather than the word "null", which reads as data. */
export const cell = (v: unknown): string => (v === null || v === undefined ? dim("—") : String(v));
