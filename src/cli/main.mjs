import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { ControlError, TimeoutError } from "../control.mjs";
import {
  createTranslator,
  LocalizedError,
  msg,
  problemOf,
  resolveLocale,
  SYSTEM_LOCALE,
  terminalLocales,
} from "../i18n/index.mjs";
import { log } from "../log.mjs";
import { createLocalModels } from "../models/library.mjs";
import { CHAT_VENDORS } from "../server/chat/vendors.mjs";
import { PROVIDERS } from "../server/providers/index.mjs";
import { openHistory } from "../storage/history.mjs";
import { resolvePaths } from "../storage/paths.mjs";
import { resolveSettings } from "../storage/settings.mjs";
import { THEMES } from "../themes/index.mjs";
import { askSecret, Cancelled } from "./ask-secret.mjs";
import { config, settings, theme } from "./commands/config.mjs";
import { DEFAULT_HISTORY_LIMIT, history } from "./commands/history.mjs";
import { key } from "./commands/key.mjs";
import { restart, start, status, stop } from "./commands/lifecycle.mjs";
import { polish, transcriber } from "./commands/local.mjs";
import { logs } from "./commands/logs.mjs";
import { mode } from "./commands/mode.mjs";
import { model } from "./commands/model.mjs";
import { uninstall } from "./commands/uninstall.mjs";
import { update } from "./commands/update.mjs";
import { usage } from "./commands/usage.mjs";
import { ConfigError, UsageError } from "./common.mjs";
import { createDaemon } from "./daemon.mjs";
import { tailFile } from "./tail.mjs";
import { createUpdater } from "./updater.mjs";
import { isOurShortcut, removeAfterExit, removeLoginItem, removePathEntry } from "./windows-system.mjs";

// The whisprflow command: wraps "install dependencies, build the helper, start the background app, enter keys, view history, change settings" into a few subcommands.
// The background app (src/app) does the real work and is directed over the control channel; history and settings files are read and written directly.
// Each subcommand is one file in commands/; this file only dispatches, handles errors, and builds the real io.
// Which language: language in the settings, or when following the system, LC_ALL, LC_MESSAGES, LANG per CLI convention (src/i18n).

/** The whisprflow help text, in this run's language */
const help = (t) =>
  t("cli.help", {
    limit: DEFAULT_HISTORY_LIMIT,
    providers: PROVIDERS.map(({ id }) => id).join(" / "),
    polishers: CHAT_VENDORS.map(({ id }) => id).join(" / "),
    themes: THEMES.map(({ id }) => `${id} ${t(`themes.${id}.name`)}`).join(" / "),
  });

const COMMANDS = {
  start,
  stop,
  restart,
  status,
  update,
  key,
  mode,
  model,
  transcriber,
  polish,
  config,
  theme,
  history,
  usage,
  logs,
  settings,
  uninstall,
};

/**
 * Runs one command.
 * @param {string[]} argv the command name and its arguments (without node and the script path)
 * @param {object} io every way of dealing with the outside world, replaced wholesale in tests. See createIo for the real one
 * @returns {Promise<number>} exit code: 0 success, 1 failed, 2 the command or settings were wrong
 */
export async function run(argv, io) {
  try {
    if (argv.some((arg) => arg === "--help" || arg === "-h") || argv[0] === "help") {
      io.out(help(io.t));
      return 0;
    }
    if (argv[0] === "--version" || argv[0] === "-v") {
      io.out(io.version);
      return 0;
    }
    const [name = "start", ...rest] = argv;
    if (!Object.hasOwn(COMMANDS, name)) throw new UsageError(msg("cli.unknownCommand", { name }));
    return await COMMANDS[name](rest, io);
  } catch (error) {
    const said = () => io.err(io.t.text(problemOf(error)));
    if (error instanceof UsageError) {
      said();
      io.err(io.t("cli.seeHelp"));
      return 2;
    }
    if (error instanceof ConfigError) {
      said();
      return 2;
    }
    if (error instanceof ControlError) {
      said();
      if (error instanceof TimeoutError) io.err(io.t("cli.stuck"));
      return 1;
    }
    // Errors we raised with a sentence for people are shown as is; the rest are bugs, kept with the stack trace for whoever investigates
    if (!(error instanceof LocalizedError) && error?.constructor !== Error) throw error;
    said();
    return 1;
  }
}

/**
 * Deletes the Keychain entry used to encrypt keys. @returns {boolean} whether it existed.
 * On Windows the key that encrypts keys is kept by the system per user (DPAPI) and the encrypted copy is in the runtime's cache, deleted with the home directory, so there is nothing to delete here
 */
function removeKeychainKey(productName) {
  if (process.platform === "win32") return false;
  try {
    execFileSync("security", ["delete-generic-password", "-s", `${productName} Safe Storage`], { stdio: "pipe" });
    return true;
  } catch (error) {
    // 44: no such entry
    if (error.status === 44) return false;
    throw new Error(String(error.stderr ?? "").trim() || error.message);
  }
}

/** Asks an ordinary question (echoed, like choosing a provider). Ctrl-C throws Cancelled, as when asking for a key */
async function ask(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise((resolve, reject) => {
      // After ^C the cursor is still on the question's line; move to a new line so what follows doesn't run on
      prompt.once("SIGINT", () => {
        process.stderr.write("\n");
        reject(new Cancelled());
      });
      prompt.question(question).then(resolve, reject);
    });
  } finally {
    prompt.close();
  }
}

async function confirm(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await prompt.question(question)).trim());
  } finally {
    prompt.close();
  }
}

/**
 * The language of this CLI run: the one in the settings if set, otherwise the terminal's language.
 * If the settings file is broken, use the terminal's language first: commands that read settings then report exactly what is broken
 */
function cliLocale(paths, env) {
  let setting = SYSTEM_LOCALE;
  try {
    setting = resolveSettings({ file: paths.settingsFile, env }).language.value;
  } catch {
    setting = SYSTEM_LOCALE;
  }
  return resolveLocale(setting, terminalLocales(env));
}

/** The real io: standard input and output, the real background app, the real history database */
export function createIo({ packageDir, env = process.env }) {
  const paths = resolvePaths(env);
  const t = createTranslator(cliLocale(paths, env));
  const write = (stream) => (text) => stream.write(text.endsWith("\n") ? text : `${text}\n`);
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  return {
    out: write(process.stdout),
    err: write(process.stderr),
    env,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    // NO_COLOR is the common convention: no color when it is set
    color: Boolean(process.stdout.isTTY) && !env.NO_COLOR,
    // The theme's true colors can only be drawn when the terminal says it supports 24-bit color
    truecolor: Boolean(process.stdout.isTTY) && !env.NO_COLOR && /^(truecolor|24bit)$/.test(env.COLORTERM ?? ""),
    version: manifest.version,
    t,
    packageDir,
    paths,
    daemon: createDaemon({ paths, packageDir, env, locale: t.locale }),
    updater: createUpdater({ env, home: paths.home, progress: Boolean(process.stderr.isTTY) }),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // When the background app isn't running, on-device models are downloaded and deleted in this process
    localModels: ({ source, onChange }) =>
      createLocalModels({
        dir: paths.modelsDir,
        source,
        log: { info() {}, warn: log.warn, error: log.error },
        onChange,
      }),
    timeZone: undefined,
    openHistory,
    askSecret,
    ask,
    confirm,
    platform: process.platform,
    // What uninstalling touches on Windows (windows-system.mjs)
    system: { removePathEntry, isOurShortcut, removeLoginItem, removeAfterExit },
    // Electron names the Keychain entry after the app name
    removeKeychainKey: () => removeKeychainKey(manifest.productName),
    // The bundled Electron is stock Electron, and macOS keeps preferences here under its bundle id. Uninstall only mentions it without deleting: other programs use it too. Not on Windows
    sharedPreferencesFile:
      process.platform === "darwin" ? join(homedir(), "Library", "Preferences", "com.github.Electron.plist") : null,
    // Windows has no tail, so use our own (tail.mjs)
    tail: ({ file, lines, follow }) =>
      process.platform === "win32"
        ? tailFile(file, { lines, follow, write: (text) => process.stdout.write(text) })
        : new Promise((resolveExit, reject) => {
            const child = spawn("tail", ["-n", String(lines), ...(follow ? ["-f"] : []), file], { stdio: "inherit" });
            child.on("error", reject);
            child.on("exit", (code) => resolveExit(code ?? 0));
          }),
  };
}

/** The entry point called by bin/whisprflow.mjs */
export async function main(argv) {
  let io;
  try {
    io = createIo({ packageDir: resolve(import.meta.dirname, "../..") });
  } catch (error) {
    // The data directory path is unusable: no io is available yet, so say it directly in the terminal's language
    const t = createTranslator(resolveLocale(SYSTEM_LOCALE, terminalLocales(process.env)));
    console.error(t.text(problemOf(error)));
    return 2;
  }
  return run(argv, io);
}
