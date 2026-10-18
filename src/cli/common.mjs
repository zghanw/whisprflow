import { parseArgs } from "node:util";
import { LocalizedError, msg, problemOf } from "../i18n/index.mjs";
import { resolveSettings } from "../storage/settings.mjs";
import { renderStatus } from "./render/status.mjs";

// Shared by the subcommands: argument parsing, the two "used wrong" errors, reading settings and stats, and making sure the background app is running.
// Text for people is translated with io.t (the language of this CLI run).

/** A mistyped command: exits with 2 and points to help. problem is a msg or plain text */
export class UsageError extends LocalizedError {}

/** A wrong setting: exits with 2 */
export class ConfigError extends LocalizedError {}

export function parse(args, options = {}) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(msg("cli.badArgs", { reason: error.message }), { cause: error });
  }
}

/** @param {string} usage this command's usage in the copy (cli.syntax.*) */
export function noPositionals(positionals, usage) {
  if (positionals.length > 0) {
    throw new UsageError(msg("cli.extraArgs", { args: positionals.join(" "), usage: msg(`cli.syntax.${usage}`) }));
  }
}

export function positiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new UsageError(msg("cli.positiveInteger", { flag }));
  return number;
}

export function currentSettings(io) {
  try {
    return resolveSettings({ file: io.paths.settingsFile, env: io.env });
  } catch (error) {
    throw new ConfigError(problemOf(error), { cause: error });
  }
}

/** Writes a sentence (msg or plain text) in this run's language */
export const say = (io, message) => io.out(io.t.text(message));

/** What to say while the background app starts (msg), in this run's language */
export const progressOf = (io) => (message) => say(io, message);

/** Today's and all-time stats. Both are null if never used (the database doesn't exist yet) */
export function readStats(io) {
  const history = io.openHistory(io.paths.historyDb, { readOnly: true });
  if (history === null) return { today: null, total: null };
  try {
    const midnight = io.now();
    midnight.setHours(0, 0, 0, 0);
    return { today: history.stats({ since: midnight.toISOString() }), total: history.stats() };
  } finally {
    history.close();
  }
}

export const renderOptions = (io) => ({
  color: io.color,
  truecolor: io.truecolor,
  now: io.now(),
  timeZone: io.timeZone,
  t: io.t,
  platform: io.platform,
});

export function showStatus(io, status, settings) {
  io.out(renderStatus({ status, version: io.version, settings, stats: readStats(io) }, renderOptions(io)));
}

export function permissionMissing({ permissions }) {
  return permissions.microphone !== "granted" || permissions.listen === false || permissions.trusted === false;
}

export async function ensureRunning(io) {
  const status = await io.daemon.status();
  if (status !== null) return status;
  io.out(io.t("cli.starting"));
  return io.daemon.start({ onProgress: progressOf(io) });
}

/** How to restart the installed app: restarting from the CLI would replace it with a terminal-started copy */
export const PACKAGED_RELAUNCH = msg("cli.packagedRelaunch");
