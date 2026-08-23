import type { Logger } from "pino";

/**
 * Stop `libsignal-node` writing key material to stdout.
 *
 * libsignal calls `console.log` directly — it never sees the logger Baileys is given — and
 * one of the things it prints is a whole `SessionEntry`, including the ratchet's ephemeral
 * `privKey` as a raw Buffer. Observed on a plain `sendMessage` during PLAN.md §8 phase 1b.
 *
 * In a terminal that is noise. In a container it is key material in shipped logs, which is
 * why this is installed before the socket is ever created rather than being left as a
 * cosmetic cleanup.
 *
 * Our own harness output deliberately goes through `write()` below, straight to the real
 * stdout, so silencing `console` costs us nothing.
 */

const realLog = console.log.bind(console);
const realError = console.error.bind(console);
const realWarn = console.warn.bind(console);

/** Direct stdout, unaffected by the console interception. */
export const write = (s = "") => process.stdout.write(`${s}\n`);

export function quietSignal(logger: Logger): void {
  const divert =
    (level: "debug" | "warn") =>
    (...args: unknown[]) => {
      // Keep it retrievable at debug level, but never on stdout by default.
      logger[level]({ source: "console" }, args.map(String).join(" ").slice(0, 500));
    };

  console.log = divert("debug");
  console.info = divert("debug");
  console.debug = divert("debug");
  console.warn = divert("warn");
  // Leave console.error alone: a real crash should still be visible.
}

/** Restore the original console — used by tests and on shutdown. */
export function restoreConsole(): void {
  console.log = realLog;
  console.error = realError;
  console.warn = realWarn;
}
