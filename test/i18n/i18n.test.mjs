import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTranslator,
  DEFAULT_LOCALE,
  findLocale,
  LOCALES,
  LocalizedError,
  localesFromEnv,
  matchLocale,
  msg,
  problemOf,
  resolveLocale,
  SYSTEM_LOCALE,
  terminalLocales,
} from "../../src/i18n/index.mjs";

const en = createTranslator("en");

test("English is the default and the only registered locale, named in its own language", () => {
  assert.equal(DEFAULT_LOCALE, "en");
  assert.deepEqual(
    LOCALES.map(({ id, name }) => [id, name]),
    [["en", "English"]],
  );
});

test("finding a locale by id ignores case, _ and -; unknown ids are null", () => {
  assert.equal(findLocale("EN").id, "en");
  assert.equal(findLocale("ja"), null);
  assert.equal(findLocale(undefined), null);
});

test("following the system: any English region matches en, everything else falls back to English", () => {
  for (const tag of ["en-US", "en-GB", "en"]) assert.equal(matchLocale([tag]), "en", tag);
  assert.equal(matchLocale(["fr-FR", "de-DE"]), "en");
  assert.equal(matchLocale(["ja-JP", "en-US"]), "en");
  // Edge cases: empty and malformed input
  assert.equal(matchLocale([]), "en");
  assert.equal(matchLocale(undefined), "en");
  assert.equal(matchLocale(["", "C", "not a tag!"]), "en");
});

test("terminal language: LC_ALL beats LC_MESSAGES beats LANG; C and POSIX mean unset", () => {
  assert.deepEqual(localesFromEnv({ LANG: "fr_FR.UTF-8" }), ["fr-FR"]);
  assert.deepEqual(localesFromEnv({ LANG: "fr_FR.UTF-8", LC_MESSAGES: "en_US.UTF-8" }), ["en-US"]);
  assert.deepEqual(localesFromEnv({ LANG: "en_US.UTF-8", LC_ALL: "fr_FR.ISO-8859-1" }), ["fr-FR"]);
  assert.deepEqual(localesFromEnv({ LANG: "de_DE.UTF-8@euro" }), ["de-DE"]);
  assert.deepEqual(localesFromEnv({ LANG: "C" }), []);
  assert.deepEqual(localesFromEnv({ LC_ALL: "POSIX", LANG: "fr_FR.UTF-8" }), []);
  assert.deepEqual(localesFromEnv({ LANG: "  " }), []);
  assert.deepEqual(localesFromEnv({}), []);
});

test("the language setting: system follows the system, an explicit id is used, an unknown one falls back to English", () => {
  assert.equal(SYSTEM_LOCALE, "system");
  assert.equal(resolveLocale("system", ["en-GB"]), "en");
  assert.equal(resolveLocale("system", ["ja-JP"]), "en");
  assert.equal(resolveLocale("en", ["fr-FR"]), "en");
  assert.equal(resolveLocale("klingon", ["en-US"]), "en");
});

test("translation: parameters fill the template; unknown locales use English; unknown keys come back as-is", () => {
  assert.equal(en("tray.version", { version: "0.6.0" }), "Version 0.6.0");
  assert.equal(createTranslator("ja")("tray.version", { version: "1" }), "Version 1");
  assert.equal(createTranslator("ja").locale, "en");
  assert.equal(en("no.such.key"), "no.such.key");
  // A missing parameter stays visible, so the omission is obvious
  assert.equal(en("tray.version"), "Version {version}");
});

test("plurals are picked by count: English has one and other", () => {
  assert.equal(en("units.days", { count: 1 }), "day");
  assert.equal(en("units.days", { count: 3 }), "days");
  assert.equal(en("units.days", { count: 0 }), "days");
});

test("a parameter can itself be a message; t.text accepts a msg, plain text, or null", () => {
  const problem = msg("model.unreachable", { provider: "Gemini" });
  assert.equal(
    en("setup.blocker.keyRejected", { problem }),
    "API key not working: Can't reach Gemini. Check your network",
  );
  // A model's own words, or text reported by an older background process: shown verbatim
  assert.equal(en.text("models/x is not found"), "models/x is not found");
  assert.equal(en.text(null), "");
  assert.equal(en.text(undefined), "");
});

test("count is formatted as 1,234 and picks the plural; numbers in other parameters stay raw (commands can't take commas)", () => {
  assert.equal(en("cli.status.dictations", { count: 1 }), "1 dictation");
  assert.equal(en("cli.status.dictations", { count: 12345 }), "12,345 dictations");
  assert.equal(en("cli.history.more", { shown: 20, total: 1234 }).includes("-n 1234"), true);
});

test("lists and numbers follow the language", () => {
  assert.equal(en.list(["A", "B", "C"]), "A, B, and C");
  assert.equal(en.list([msg("setup.missing.microphone")]), "microphone access");
  assert.equal(en.either(["1 (Gemini)", "2 (OpenAI)"]), "1 (Gemini) or 2 (OpenAI)");
  assert.equal(en.number(12345), "12,345");
});

test("t.parts keeps parameters in place so the caller can draw them as keycaps", () => {
  const keycap = { key: "Right ⌥" };
  assert.deepEqual(en.parts("bar.recording", { key: keycap, esc: { key: "esc" } }), [
    "Press ",
    keycap,
    " to finish · ",
    { key: "esc" },
    " to cancel",
  ]);
});

test("LocalizedError: problem is kept for the displaying side to translate, message is English for the log", () => {
  const error = new LocalizedError(msg("key.empty"));
  assert.ok(error instanceof Error);
  assert.equal(error.message, "No key entered");
  assert.deepEqual(error.problem, { key: "key.empty" });
  assert.equal(en.text(problemOf(error)), "No key entered");
  // Other errors use their own message
  assert.equal(problemOf(new Error("Disk full")), "Disk full");
  assert.equal(problemOf("A sentence"), "A sentence");
});

test("wording that differs by OS: Windows looks in the windows section first, then the shared text", () => {
  const mac = createTranslator("en", "darwin");
  const win = createTranslator("en", "win32");
  assert.match(mac("delivery.pasteFailed"), /⌘V/);
  assert.match(win("delivery.pasteFailed"), /Ctrl\+V/);
  assert.equal(mac("plaza.via.local"), "This Mac");
  assert.equal(win("plaza.via.local"), "This PC");
  // Text that doesn't vary by OS is the same on both
  assert.equal(win("hotkeys.right_alt.name"), "Right Alt");
});

test("CLI language: LC_ALL, LC_MESSAGES, LANG first; Windows terminals usually set none, so the display language is used", () => {
  const systemLocale = () => "fr-FR";
  assert.deepEqual(terminalLocales({ LANG: "en_US.UTF-8" }, { platform: "win32", systemLocale }), ["en-US"]);
  assert.deepEqual(terminalLocales({}, { platform: "win32", systemLocale }), ["fr-FR"]);
  // An explicit C (terminals like Git Bash set it) is honored rather than falling back to the system language
  assert.deepEqual(terminalLocales({ LANG: "C" }, { platform: "win32", systemLocale }), []);
  assert.deepEqual(terminalLocales({ LANG: "  " }, { platform: "win32", systemLocale }), ["fr-FR"]);
  // macOS terminals always set it, so unset means unset; no guessing
  assert.deepEqual(terminalLocales({}, { platform: "darwin", systemLocale }), []);
});
