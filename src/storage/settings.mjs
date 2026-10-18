import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { findLocale, LOCALES, LocalizedError, msg, problemOf, SYSTEM_LOCALE } from "../i18n/index.mjs";
import { DEFAULT_SOURCE, DEFAULT_TRANSCRIBER, MODELS, SOURCES } from "../models/catalog.mjs";
import { CLOUD_TRANSCRIBERS, cloudTranscriberOf } from "../server/asr/cloud/vendors.mjs";
import { formatChatChoice, normalizeBaseUrl, parseChatChoice } from "../server/chat/vendors.mjs";
import { DEFAULT_MODE, DEFAULT_POLISH, MODES, parseMode } from "../server/modes.mjs";
import {
  DEFAULT_MODEL_CHOICE,
  DEFAULT_THINKING_LEVEL,
  findProvider,
  formatModelChoice,
  parseModelChoice,
} from "../server/providers/index.mjs";
import { DEFAULT_THEME, findTheme, THEMES } from "../themes/index.mjs";

// The settings users can change, stored in settings.json in the data directory.
// Precedence: environment variables (this run only) over the file, the file over defaults. Keys aren't here; they are encrypted separately.

/**
 * The hotkey is a single modifier key; the choices depend on the OS (the key must be recognizable by that system's native helper):
 *   macOS    right Option by default; right Command, right Control, and fn (Globe) are available too.
 *   Windows  right Alt (default, where the Mac's right Option is) and right Ctrl. Right Win opens the Start menu on release, and the system can't see fn, so neither is offered.
 * Names and bar labels (hotkeys.<id>.name / keycap) are in the messages, per UI language. Windows' right Ctrl and the Mac's
 * right Control are the same key position, named by each system's custom, hence two ids.
 */
const HOTKEYS_BY_PLATFORM = {
  darwin: ["right_option", "right_command", "right_control", "fn"],
  win32: ["right_alt", "right_ctrl"],
};

/** The hotkeys selectable on this OS, the default first */
export const hotkeyIdsFor = (platform) =>
  Object.freeze([...(HOTKEYS_BY_PLATFORM[platform] ?? HOTKEYS_BY_PLATFORM.darwin)]);

export const HOTKEY_IDS = hotkeyIdsFor(process.platform);

/** The hotkey's name: a message not yet in a language */
export const hotkeyName = (id) => msg(`hotkeys.${id}.name`);
/** The hotkey's short name for the bar hint (space is tight there) */
export const hotkeyKeycap = (id) => msg(`hotkeys.${id}.keycap`);

const THEME_IDS = THEMES.map((theme) => theme.id);
const MODE_IDS = MODES.map((mode) => mode.id);
const TRANSCRIBER_IDS = MODELS.map((model) => model.id);
/** What step one accepts: on-device model ids, and vendor/model from the cloud registry (unlisted cloud model names too, see transcriber.parse) */
const TRANSCRIBER_CHOICES = [
  ...TRANSCRIBER_IDS,
  ...CLOUD_TRANSCRIBERS.flatMap((vendor) => vendor.models.map((model) => `${vendor.id}/${model.id}`)),
];
/** Cloud model names contain only these characters */
const CLOUD_MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const SOURCE_IDS = SOURCES.map((source) => source.id);
/** Whether on-device models use the GPU: auto uses one if present and falls back to the CPU if loading on it fails (asr/start.mjs); cpu uses only the CPU */
export const ACCELERATIONS = Object.freeze(["auto", "cpu"]);
/** Whether the hint above the bar ("press Right Option again to finish · esc to cancel") shows: experienced users find it always in the way */
export const BAR_HINTS = Object.freeze(["on", "off"]);
const THINKING_LEVELS = findProvider("gemini").thinkingLevels;
const LANGUAGES = [SYSTEM_LOCALE, ...LOCALES.map(({ id }) => id)];

const oneOf = (choices) => new LocalizedError(msg("settings.oneOf", { choices: choices.join(" / ") }));

/**
 * Each entry: its environment variable, default, allowed values (null when open), and a function that normalizes and validates a value.
 * What each setting does is in the messages (settings.describe.<name>), per UI language.
 * label is optional: when a value isn't self-explanatory (right_option, cinnabar), it gives its name, as a message (msg) or a name.
 * legacyEnv is optional: an older environment variable name, still read when env isn't set.
 * store is optional: how the normalized value is written to the file (as is by default).
 * ofMode is optional: which recognition mode the setting belongs to (server/modes.mjs); it can only change within that mode (app/modes.mjs).
 *   local's two steps each have their own: transcriber is step one (an on-device or cloud model), polish and customUrl are step two.
 *   private has one step: privateTranscriber, on-device models only, saved apart from local's step one so each changes on its own.
 */
export const SETTINGS = {
  hotkey: {
    env: "WHISPRFLOW_HOTKEY",
    default: HOTKEY_IDS[0],
    choices: HOTKEY_IDS,
    parse(value) {
      if (!HOTKEY_IDS.includes(value)) throw oneOf(HOTKEY_IDS);
      return value;
    },
    label: hotkeyName,
  },
  mode: {
    env: "WHISPRFLOW_MODE",
    // The modes are peers (server/modes.mjs); native is the default for anyone who never picked
    default: DEFAULT_MODE,
    choices: MODE_IDS,
    parse: parseMode,
    label: (value) => msg(`modes.${value}`),
  },
  model: {
    ofMode: "native",
    env: "WHISPRFLOW_MODEL",
    // The older variable, which takes only a Gemini model name
    legacyEnv: "GEMINI_MODEL",
    default: formatModelChoice(DEFAULT_MODEL_CHOICE),
    choices: null,
    parse(value) {
      // Always stored as vendor/model. Older files held only a Gemini model name, which still reads fine (see parseModelChoice)
      return formatModelChoice(parseModelChoice(value));
    },
    label: (value) => findProvider(parseModelChoice(value).provider).name,
    // Gemini models are stored as the model name alone, the older form: an older version would take a gemini/... value whole as a model name and every request would fail
    store(value) {
      const { provider, model } = parseModelChoice(value);
      return provider === "gemini" ? model : value;
    },
  },
  thinking: {
    ofMode: "native",
    env: "GEMINI_THINKING_LEVEL",
    default: DEFAULT_THINKING_LEVEL,
    choices: THINKING_LEVELS,
    parse(value) {
      const level = value.toUpperCase();
      if (!THINKING_LEVELS.includes(level)) throw oneOf(THINKING_LEVELS);
      return level;
    },
  },
  transcriber: {
    ofMode: "local",
    env: "WHISPRFLOW_TRANSCRIBER",
    default: DEFAULT_TRANSCRIBER,
    choices: TRANSCRIBER_CHOICES,
    // On-device models by id; cloud models as vendor/model (a vendor alone uses its default), always stored as vendor/model
    parse(value) {
      const id = value.trim();
      const cloud = cloudTranscriberOf(id);
      if (cloud) {
        if (!CLOUD_MODEL_NAME.test(cloud.model))
          throw new LocalizedError(msg("chat.badModelName", { model: JSON.stringify(cloud.model) }));
        return `${cloud.vendor}/${cloud.model}`;
      }
      if (!TRANSCRIBER_IDS.includes(id)) throw oneOf(TRANSCRIBER_CHOICES);
      return id;
    },
  },
  privateTranscriber: {
    ofMode: "private",
    env: "WHISPRFLOW_PRIVATE_TRANSCRIBER",
    default: DEFAULT_TRANSCRIBER,
    // Private mode uploads nothing: on-device models only
    choices: TRANSCRIBER_IDS,
    parse(value) {
      const id = value.trim();
      if (!TRANSCRIBER_IDS.includes(id)) throw oneOf(TRANSCRIBER_IDS);
      return id;
    },
  },
  polish: {
    ofMode: "local",
    env: "WHISPRFLOW_POLISH",
    default: formatChatChoice(parseChatChoice(DEFAULT_POLISH)),
    choices: null,
    // Always stored as vendor/model
    parse: (value) => formatChatChoice(parseChatChoice(value)),
  },
  customUrl: {
    ofMode: "local",
    env: "WHISPRFLOW_CUSTOM_URL",
    // Empty means not set: only needed when a custom service does the cleanup
    default: "",
    choices: null,
    parse: (value) => (value.trim() === "" ? "" : normalizeBaseUrl(value)),
  },
  modelSource: {
    // Where to download a missing on-device model first, changeable in any mode (pick before switching to local). If the chosen one stalls the other is used, so it only affects speed
    env: "WHISPRFLOW_MODEL_SOURCE",
    default: DEFAULT_SOURCE,
    choices: SOURCE_IDS,
    parse(value) {
      const id = value.trim().toLowerCase();
      if (!SOURCE_IDS.includes(id)) throw oneOf(SOURCE_IDS);
      return id;
    },
    label: (value) => msg(`modelSources.${value}`),
  },
  acceleration: {
    // Pick cpu when the GPU driver misbehaves or the GPU is needed for games. A change reloads the model, applied at once in the app
    env: "WHISPRFLOW_ACCELERATION",
    default: "auto",
    choices: ACCELERATIONS,
    parse(value) {
      const id = value.trim().toLowerCase();
      if (!ACCELERATIONS.includes(id)) throw oneOf(ACCELERATIONS);
      return id;
    },
    label: (value) => msg(`accelerations.${value}`),
  },
  barHint: {
    env: "WHISPRFLOW_BAR_HINT",
    default: "on",
    choices: BAR_HINTS,
    parse(value) {
      const id = value.trim().toLowerCase();
      if (!BAR_HINTS.includes(id)) throw oneOf(BAR_HINTS);
      return id;
    },
    label: (value) => msg(`barHints.${value}`),
  },
  theme: {
    env: "WHISPRFLOW_THEME",
    default: DEFAULT_THEME,
    choices: THEME_IDS,
    parse(value) {
      // An id or a name both work (cinnabar, Cinnabar), always stored as the id
      const theme = findTheme(value.trim());
      if (theme === null) throw oneOf(THEME_IDS);
      return theme.id;
    },
    label: (value) => msg(`themes.${value}.name`),
  },
  language: {
    env: "WHISPRFLOW_LANGUAGE",
    // Follows the system, falling back to English when the system language isn't known (src/i18n)
    default: SYSTEM_LOCALE,
    choices: LANGUAGES,
    parse(value) {
      const wanted = value.trim();
      if (wanted.toLowerCase() === SYSTEM_LOCALE) return SYSTEM_LOCALE;
      const locale = findLocale(wanted);
      if (locale === null) throw oneOf(LANGUAGES);
      return locale.id;
    },
    // A language's name is written in that language (English) and never translated
    label: (value) => (value === SYSTEM_LOCALE ? msg("language.system") : findLocale(value).name),
  },
};

function settingNamed(name) {
  if (!Object.hasOwn(SETTINGS, name)) {
    throw new LocalizedError(
      msg("settings.unknown", { name: JSON.stringify(name), names: Object.keys(SETTINGS).join(" / ") }),
    );
  }
  return SETTINGS[name];
}

/** @param {string | object} where where it was written: the setting name, or a sentence (msg) */
function parseValue(name, value, where) {
  try {
    if (typeof value !== "string") throw new LocalizedError(msg("settings.notText"));
    return SETTINGS[name].parse(value);
  } catch (error) {
    throw new LocalizedError(
      msg("settings.invalid", { where, value: JSON.stringify(value), reason: problemOf(error) }),
      {
        cause: error,
      },
    );
  }
}

function readFile(file) {
  if (!existsSync(file)) return {};
  let stored;
  try {
    stored = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new LocalizedError(msg("settings.unreadable", { file, reason: error.message }), { cause: error });
  }
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    throw new LocalizedError(msg("settings.notObject", { file }));
  }
  return stored;
}

function writeFile(file, stored) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
}

/** Which environment variable overrides this setting now (the new name before the older one); null when none */
export function overridingEnv(name, env) {
  const setting = settingNamed(name);
  for (const variable of [setting.env, setting.legacyEnv]) {
    if (variable && env[variable] !== undefined) return variable;
  }
  return null;
}

/**
 * The settings in effect, and where each came from.
 * @returns {Record<keyof typeof SETTINGS, { value: string, source: "env" | "file" | "default", env?: string }>}
 *   when it came from an older environment variable, env names it
 */
export function resolveSettings({ file, env }) {
  const stored = readFile(file);
  const resolved = {};
  for (const [name, setting] of Object.entries(SETTINGS)) {
    const variable = overridingEnv(name, env);
    if (variable !== null) {
      const value = parseValue(name, env[variable], msg("settings.whereEnv", { variable }));
      resolved[name] = variable === setting.env ? { value, source: "env" } : { value, source: "env", env: variable };
    } else if (stored[name] !== undefined) {
      resolved[name] = {
        value: parseValue(name, stored[name], msg("settings.whereFile", { file, name })),
        source: "file",
      };
    } else {
      resolved[name] = { value: setting.default, source: "default" };
    }
  }
  return resolved;
}

/** Validates and saves one setting. Returns the normalized value */
export function saveSetting(file, name, value) {
  settingNamed(name);
  const parsed = parseValue(name, value, name);
  writeFile(file, { ...readFile(file), [name]: SETTINGS[name].store?.(parsed) ?? parsed });
  return parsed;
}

/** Unsets one setting, returning it to its default */
export function unsetSetting(file, name) {
  settingNamed(name);
  const { [name]: _removed, ...rest } = readFile(file);
  writeFile(file, rest);
}

/**
 * Builds the settings with some values changed, without writing the file: used to see the resulting route and verify it before saving.
 * Wrong values throw like saveSetting
 * @param {ReturnType<typeof resolveSettings>} settings
 * @param {Record<string, string>} changes
 */
export function patchSettings(settings, changes) {
  const patched = { ...settings };
  for (const [name, value] of Object.entries(changes)) {
    settingNamed(name);
    patched[name] = { value: parseValue(name, value, name), source: "file" };
  }
  return patched;
}

/** Each mode's own settings (ofMode) */
export const MODE_SETTINGS = Object.freeze(
  Object.fromEntries(
    MODE_IDS.map((mode) => [mode, Object.keys(SETTINGS).filter((name) => SETTINGS[name].ofMode === mode)]),
  ),
);

/**
 * Which settings build each mode's route (server/modes.mjs). Each reads its own: changing local's cleanup leaves the native route alone
 */
const ROUTES = {
  native: (settings) => ({
    mode: "native",
    model: parseModelChoice(settings.model.value),
    thinkingLevel: settings.thinking.value,
  }),
  local: (settings) => ({
    mode: "local",
    transcriber: settings.transcriber.value,
    polish: parseChatChoice(settings.polish.value),
    customUrl: settings.customUrl.value || null,
  }),
  private: (settings) => ({ mode: "private", transcriber: settings.privateTranscriber.value }),
};

/**
 * The route a mode takes with the current settings; without a mode, the mode chosen in settings
 * @param {ReturnType<typeof resolveSettings>} settings
 * @param {string} [mode]
 */
export function routeOf(settings, mode = settings.mode.value) {
  return ROUTES[mode](settings);
}
