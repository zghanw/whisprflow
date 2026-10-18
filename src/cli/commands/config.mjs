import { findLocale, msg, problemOf, SYSTEM_LOCALE } from "../../i18n/index.mjs";
import { findModel } from "../../models/catalog.mjs";
import { findProvider, parseModelChoice } from "../../server/providers/index.mjs";
import { findVendor } from "../../server/vendors.mjs";
import { ensureHome } from "../../storage/paths.mjs";
import { overridingEnv, SETTINGS, saveSetting, unsetSetting } from "../../storage/settings.mjs";
import { THEMES } from "../../themes/index.mjs";
import {
  ConfigError,
  currentSettings,
  noPositionals,
  PACKAGED_RELAUNCH,
  parse,
  progressOf,
  renderOptions,
  UsageError,
} from "../common.mjs";
import { renderConfig, renderThemes, themeTitle } from "../render/settings.mjs";

// Settings: whisprflow config, theme, and whisprflow settings, which opens the settings window.
// Theme, language, and download source apply at once (the running app rereads its settings); the rest need a background restart.
// config set is the back door for editing settings by hand: it only checks the format settings are stored in and skips the mode layer's checks (app/modes.mjs),
// so settings outside the current mode are written too and take effect when that mode is chosen. Day to day, change modes and models with mode, model, transcriber, polish.

/**
 * Makes changed settings take effect: restarts the app if it is running and checks the result after the restart.
 * @param {string | null} undo how to undo this change (a command), shown if the restart leaves it unusable; null when there is nothing to undo
 * @returns {Promise<number>} exit code
 */
export async function applySettings(io, undo) {
  const current = await io.daemon.status();
  const { t } = io;
  if (current === null) {
    io.out(t("cli.config.nextLaunch"));
    return 0;
  }
  if (current.packaged) {
    // Restarting from here would bring up a terminal-started copy, not the installed app
    io.out(t("cli.config.packaged", { relaunch: PACKAGED_RELAUNCH }));
    return 0;
  }
  io.out(t("cli.config.restarting"));
  await io.daemon.stop();
  const restarted = await io.daemon.start({ onProgress: progressOf(io) });
  // Very old background apps don't report a provider; back then only Gemini existed
  const provider = restarted.provider
    ? findVendor(restarted.provider)
    : findProvider(parseModelChoice(restarted.model ?? "gemini").provider);
  // Whether the model name and thinking level are right is only known after asking that provider
  const named = { provider: provider.name, id: provider.id, problem: restarted.key.problem };
  const failed = (key) => {
    io.err(t(key, named));
    if (undo) io.err(t("cli.config.undo", { undo }));
    return 1;
  };
  if (restarted.key.state === "rejected" && restarted.key.cause === "other")
    return failed("cli.config.restartedBroken");
  // That provider's key can't be used (the stored one expired, or the one in the environment is wrong)
  if (restarted.key.state === "rejected") return failed("cli.config.restartedKeyBad");
  // Switched to a provider with no key yet (config set model doesn't ask for one first)
  if (restarted.key.state === "missing" || restarted.key.state === "unreadable") {
    return failed("cli.config.restartedNoKey");
  }
  if (restarted.starting) io.out(t("cli.config.restartedStarting"));
  else if (restarted.key.verified === false) io.out(t("cli.config.restartedUnverified", named));
  else io.out(t("cli.config.applied"));
  // The on-device model local mode needs isn't downloaded yet (config set doesn't check): say how to get it, don't download it for the user
  const local = restarted.localModel;
  if (local?.state === "missing" && !local.total) {
    io.out(t("cli.local.notDownloadedHint", { model: findModel(local.model)?.name ?? local.model, id: local.model }));
  }
  return 0;
}

/** How to write a language: "follow the system", or that language's own name */
const languageTitle = (t, value) =>
  value === SYSTEM_LOCALE ? t("language.system") : (findLocale(value)?.name ?? value);

/** The settings that apply at once: which command makes the running app reread its settings, which field of its answer to check, and what to say if it didn't change */
const LIVE = {
  theme: {
    command: "reload-theme",
    overridden: (t, applied, variable) =>
      t("cli.config.themeOverridden", { theme: themeTitle(t, applied.theme), variable }),
  },
  language: {
    command: "reload-language",
    overridden: (t, applied, variable) =>
      t("cli.config.languageOverridden", { language: languageTitle(t, applied.language), variable }),
  },
  modelSource: {
    command: "reload-model-source",
    overridden: (t, applied, variable) =>
      t("cli.config.modelSourceOverridden", { source: t(`modelSources.${applied.modelSource}`), variable }),
  },
};

/**
 * Makes a changed theme, language, or download source take effect. These need no restart: the running app rereads its settings and open windows update at once.
 * @param {"theme" | "language" | "modelSource"} name
 * @param {string} wanted the value now in the settings
 * @returns {Promise<number>} exit code
 */
async function applyLive(io, name, wanted) {
  if ((await io.daemon.status()) === null) {
    io.out(io.t("cli.config.nextLaunch"));
    return 0;
  }
  let applied;
  try {
    applied = await io.daemon.request(LIVE[name].command);
  } catch (error) {
    // The running app was started before an upgrade and doesn't know this command yet
    if (!/^Unknown command/.test(error?.message ?? "")) throw error;
    io.out(io.t("cli.config.oldDaemonLive"));
    return 0;
  }
  if (applied[name] === wanted) io.out(io.t("cli.config.appliedLive"));
  else io.out(LIVE[name].overridden(io.t, applied, SETTINGS[name].env));
  return 0;
}

/** The commands that normally change the mode layer's settings: they check the change works first and refuse otherwise */
const MODE_COMMANDS = {
  mode: "whisprflow mode",
  model: "whisprflow model",
  transcriber: "whisprflow transcriber",
  polish: "whisprflow polish",
  customUrl: "whisprflow polish",
};

/** config set wrote a mode-layer setting: say which command is the usual route, and if the setting belongs to another mode, that it applies once switched */
function noteModeSetting(io, name) {
  if (Object.hasOwn(MODE_COMMANDS, name)) io.out(io.t("cli.config.modeCommand", { command: MODE_COMMANDS[name] }));
  const { ofMode } = SETTINGS[name];
  const current = currentSettings(io).mode.value;
  if (ofMode && ofMode !== current) io.out(io.t("cli.config.otherMode", { current, mode: ofMode }));
}

/** Validates and stores one setting. @returns {string} the normalized value */
export function storeSetting(io, name, value) {
  try {
    // This may be the first file in the directory
    ensureHome(io.paths);
    return saveSetting(io.paths.settingsFile, name, value);
  } catch (error) {
    throw new ConfigError(problemOf(error), { cause: error });
  }
}

export function warnIfEnvOverrides(io, name) {
  const variable = overridingEnv(name, io.env);
  if (variable !== null) io.out(io.t("cli.config.envWarning", { variable }));
}

export async function config(args, io) {
  const [action, name, value, ...extra] = parse(args).positionals;

  if (action === undefined) {
    io.out(renderConfig({ settings: currentSettings(io), paths: io.paths }, renderOptions(io)));
    return 0;
  }
  if (action === "set" && name !== undefined && value !== undefined && extra.length === 0) {
    const saved = storeSetting(io, name, value);
    io.out(io.t("cli.config.changed", { name, value: saved }));
    warnIfEnvOverrides(io, name);
    noteModeSetting(io, name);
    if (Object.hasOwn(LIVE, name)) return applyLive(io, name, saved);
    return applySettings(io, `whisprflow config unset ${name}`);
  }
  if (action === "unset" && name !== undefined && value === undefined) {
    try {
      unsetSetting(io.paths.settingsFile, name);
    } catch (error) {
      throw new ConfigError(problemOf(error), { cause: error });
    }
    io.out(io.t("cli.config.unset", { name, value: SETTINGS[name].default }));
    return Object.hasOwn(LIVE, name) ? applyLive(io, name, SETTINGS[name].default) : applySettings(io, null);
  }
  throw new UsageError(msg("cli.syntax.config"));
}

export async function theme(args, io) {
  const [wanted, ...extra] = parse(args).positionals;
  if (extra.length > 0) throw new UsageError(msg("cli.syntax.theme"));
  if (wanted === undefined) {
    io.out(renderThemes({ themes: THEMES, setting: currentSettings(io).theme }, renderOptions(io)));
    return 0;
  }
  const saved = storeSetting(io, "theme", wanted);
  io.out(io.t("cli.config.themeChanged", { theme: themeTitle(io.t, saved) }));
  warnIfEnvOverrides(io, "theme");
  return applyLive(io, "theme", saved);
}

export async function settings(args, io) {
  noPositionals(parse(args).positionals, "settings");
  if ((await io.daemon.status()) === null) {
    io.err(io.t("cli.config.notRunning"));
    return 1;
  }
  await io.daemon.request("show-settings");
  io.out(io.t("cli.config.settingsOpened"));
  return 0;
}
