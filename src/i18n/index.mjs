import en from "./locales/en.mjs";

// Interface language: every sentence people see in the menu bar, the three windows, and the CLI comes from here. The core (prompts, refined text) isn't managed here.
//
// Copy lives in one file per language (locales/), looked up as "section.name". The core and main process never write sentences in a particular language;
// they hand over a "sentence without a language yet" (msg: name plus parameters), translated by whichever end finally shows it:
// the background app and the CLI may use different languages, and status already reported follows when the interface language changes.
//
// To add a language: write a file modeled on locales/en.mjs and add a line to LOCALES. Tests point out missing sentences and mismatched parameters.
//
// Sentences that differ by system (⌘V vs Ctrl+V, "System Settings" vs "Settings", Activity Monitor vs Task Manager): the general one is written for macOS,
// and the Windows one goes in the same file's windows section under the same name (windows.delivery.pasteFailed overrides delivery.pasteFailed).
// Translating on Windows looks in that section first and falls back to the general one; callers never branch on the system. Sentences that don't differ by system need no Windows entry.

/**
 * Listed for the user in this order. name is written in its own language, untranslated, so people who can't read the current language still find theirs.
 * separator (optional): lists are joined with it instead of Intl's form (A, B, and C). For languages whose conjunctions
 * would sit awkwardly against Latin product names
 */
export const LOCALES = Object.freeze([Object.freeze({ id: "en", name: "English", messages: en })]);

/** Used when the system language isn't recognized or a sentence isn't translated */
export const DEFAULT_LOCALE = "en";

/** How "follow the system" is written in the settings */
export const SYSTEM_LOCALE = "system";

/** Finds by id, ignoring case and _ vs - (en_US and en-us both match en-US). @returns null when there is no such language */
export function findLocale(id) {
  const wanted = String(id ?? "")
    .replaceAll("_", "-")
    .toLowerCase();
  return LOCALES.find((locale) => locale.id.toLowerCase() === wanted) ?? null;
}

/** Expands to "language-script-region": en is en-Latn-US, zh-TW is zh-Hant-TW. null for a malformed tag */
function maximized(tag) {
  try {
    const { language, script, region } = new Intl.Locale(String(tag).replaceAll("_", "-")).maximize();
    return { language, script, region };
  } catch {
    return null;
  }
}

/**
 * The first language we have among the system's preferred languages (in order). Language and script must both match:
 * a different script of the same language doesn't count, so the next one is tried. With none, English.
 * @param {readonly string[]} preferred like Electron's app.getPreferredSystemLanguages()
 */
export function matchLocale(preferred) {
  const supported = LOCALES.map(({ id }) => ({ id, ...maximized(id) }));
  for (const tag of preferred ?? []) {
    const wanted = maximized(tag);
    if (wanted === null) continue;
    const same = supported.filter(({ language, script }) => language === wanted.language && script === wanted.script);
    if (same.length > 0) return (same.find(({ region }) => region === wanted.region) ?? same[0]).id;
  }
  return DEFAULT_LOCALE;
}

/**
 * The terminal's "system language": by CLI convention, LC_ALL, LC_MESSAGES, LANG (earlier ones override later ones).
 * en_US.UTF-8 becomes en-US; C and POSIX mean "not specified"
 * @returns {string[]}
 */
/** The environment variables terminals use for the language, earlier ones first */
const LOCALE_VARIABLES = ["LC_ALL", "LC_MESSAGES", "LANG"];

export function localesFromEnv(env) {
  for (const name of LOCALE_VARIABLES) {
    const value = env[name]?.trim();
    if (!value) continue;
    const tag = value.split(/[.@]/)[0];
    return tag === "C" || tag === "POSIX" ? [] : [tag.replaceAll("_", "-")];
  }
  return [];
}

/**
 * The CLI's "system language". By convention LC_ALL, LC_MESSAGES, LANG first; Windows terminals usually set none of them,
 * so with none set the system display language is used (the one Node gets from the system)
 * @param {Record<string, string | undefined>} env
 * @param {{ platform?: NodeJS.Platform, systemLocale?: () => string }} [options] replaced in tests
 * @returns {string[]}
 */
export function terminalLocales(
  env,
  { platform = process.platform, systemLocale = () => Intl.DateTimeFormat().resolvedOptions().locale } = {},
) {
  // If set, follow it (C and POSIX mean "no particular language", so English); only on Windows with none set does the system decide
  const said = LOCALE_VARIABLES.some((name) => env[name]?.trim());
  if (said || platform !== "win32") return localesFromEnv(env);
  return [systemLocale()];
}

/**
 * The language in the settings, resolved to the one used this time.
 * @param {string} setting SYSTEM_LOCALE or a language id
 * @param {readonly string[]} systemPreferred the system's preferred languages, used when following the system
 */
export function resolveLocale(setting, systemPreferred) {
  if (setting === SYSTEM_LOCALE) return matchLocale(systemPreferred);
  return findLocale(setting)?.id ?? DEFAULT_LOCALE;
}

/**
 * A sentence without a language yet. Parameters can be msgs themselves (a reason, say), translated along with it.
 * @returns {{ key: string, params?: object }}
 */
export const msg = (key, params) => (params === undefined ? { key } : { key, params });

const isMessage = (value) => value !== null && typeof value === "object" && typeof value.key === "string";

const lookup = (messages, key) => key.split(".").reduce((node, part) => node?.[part], messages);

/**
 * A language's translate function. t(name, params): {param} in the template is replaced; a template split by plural like { one, other }
 * is picked by the count parameter. count is a number written in this language's format (1,234); other parameters are written as is (numbers in commands can't take commas).
 * Unknown names are returned as is (visible, never silently blank), and tests make sure every name used exists.
 * Also:
 *   t.text(sentence)   translates a msg into this language; text that is already plain (a model's own words, an older background's report) stays as is; null is an empty string
 *   t.list(sentences)  joins in this language (A, B, and C); t.either(sentences) is "or" (A or B)
 *   t.parts(name, params) like t but not joined into one string: parameters stay in place as themselves, for callers that draw them differently (keycaps)
 *   t.number(n)        writes a number in this language (1,234)
 *   t.locale           this language's id
 */
export function createTranslator(id, platform = defaultPlatform()) {
  const locale = findLocale(id) ?? findLocale(DEFAULT_LOCALE);
  const fallback = findLocale(DEFAULT_LOCALE).messages;
  const plurals = new Intl.PluralRules(locale.id);
  const lists = new Intl.ListFormat(locale.id, { type: "conjunction" });
  const alternatives = new Intl.ListFormat(locale.id, { type: "disjunction" });
  const numbers = new Intl.NumberFormat(locale.id);

  function template(key, params) {
    // This language first (the Windows wording, then the general one), then English
    const variant = platform === "win32" ? `windows.${key}` : null;
    const found =
      (variant && lookup(locale.messages, variant)) ??
      lookup(locale.messages, key) ??
      (variant && lookup(fallback, variant)) ??
      lookup(fallback, key);
    if (typeof found === "string") return found;
    if (found !== null && typeof found === "object" && typeof found.other === "string") {
      return found[plurals.select(Number(params.count))] ?? found.other;
    }
    return key;
  }

  const text = (value) => {
    if (value === null || value === undefined) return "";
    if (isMessage(value)) return t(value.key, value.params);
    return String(value);
  };

  function parts(key, params = {}) {
    const pieces = [];
    const source = template(key, params);
    let last = 0;
    for (const match of source.matchAll(/\{(\w+)\}/g)) {
      const name = match[1];
      if (!Object.hasOwn(params, name)) continue;
      const value = name === "count" && typeof params.count === "number" ? numbers.format(params.count) : params[name];
      pieces.push(source.slice(last, match.index), value);
      last = match.index + match[0].length;
    }
    pieces.push(source.slice(last));
    return pieces.filter((piece) => piece !== "");
  }

  function t(key, params = {}) {
    return parts(key, params)
      .map((piece) => text(piece))
      .join("");
  }

  t.text = text;
  t.parts = parts;
  const join = (format) => (items) => {
    const texts = items.map(text);
    return locale.separator ? texts.join(locale.separator) : format.format(texts);
  };
  t.list = join(lists);
  t.either = join(alternatives);
  t.number = (value) => numbers.format(value);
  t.locale = locale.id;
  return t;
}

/**
 * Which system this end runs on: in Node (main process, CLI, server) from process; pages have no process, so the preload script's
 * window.whisprflow.platform. With neither (unit tests running page modules in Node do have process), macOS
 */
function defaultPlatform() {
  return globalThis.process?.platform ?? globalThis.window?.whisprflow?.platform ?? "darwin";
}

/** The English copy: for logs and error messages */
const english = createTranslator(DEFAULT_LOCALE);

/**
 * An error meant for people. problem is a msg translated by the end that shows it; message is English, for the log.
 * Thrown by modules shared by the core and the CLI (settings, paths, vendor lists) when something goes wrong.
 */
export class LocalizedError extends Error {
  constructor(problem, options) {
    super(english.text(problem), options);
    this.name = "LocalizedError";
    this.problem = problem;
  }
}

/** The sentence people see for an error: translated if it has a problem, otherwise its own message */
export const problemOf = (error) => error?.problem ?? (error instanceof Error ? error.message : String(error ?? ""));
