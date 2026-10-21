import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createTranslator } from "../../src/i18n/index.mjs";
import { DEFAULT_TRANSCRIBER } from "../../src/models/catalog.mjs";
import {
  HOTKEY_IDS,
  hotkeyIdsFor,
  MODE_SETTINGS,
  overridingEnv,
  patchSettings,
  resolveSettings,
  routeOf,
  SETTINGS,
  saveSetting,
  unsetSetting,
} from "../../src/storage/settings.mjs";

const en = createTranslator("en");
/** The user-facing sentence in the error, as translated */
const said = (pattern) => (error) => pattern.test(en.text(error.problem ?? error.message));

let dir;
let file;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "whisprflow-settings-"));
  file = join(dir, "settings.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Hotkeys depend on the OS: this OS's list, the default is the first, and another one that isn't the default */
const DEFAULT_HOTKEY = HOTKEY_IDS[0];
const OTHER_HOTKEY = HOTKEY_IDS.at(-1);

test("with no file and no environment, everything is a default", () => {
  assert.deepEqual(resolveSettings({ file, env: {} }), {
    hotkey: { value: DEFAULT_HOTKEY, source: "default" },
    mode: { value: "local", source: "default" },
    model: { value: "gemini/gemini-3.6-flash", source: "default" },
    thinking: { value: "MINIMAL", source: "default" },
    transcriber: { value: DEFAULT_TRANSCRIBER, source: "default" },
    privateTranscriber: { value: DEFAULT_TRANSCRIBER, source: "default" },
    polish: { value: "ollama/qwen3:4b-instruct", source: "default" },
    customUrl: { value: "", source: "default" },
    modelSource: { value: "original", source: "default" },
    acceleration: { value: "auto", source: "default" },
    barHint: { value: "on", source: "default" },
    theme: { value: "ink", source: "default" },
    language: { value: "system", source: "default" },
  });
});

test("saved values read back next time; untouched ones stay default", () => {
  saveSetting(file, "hotkey", OTHER_HOTKEY);
  saveSetting(file, "thinking", "low");
  const settings = resolveSettings({ file, env: {} });
  assert.deepEqual(settings.hotkey, { value: OTHER_HOTKEY, source: "file" });
  assert.deepEqual(settings.thinking, { value: "LOW", source: "file" });
  assert.deepEqual(settings.model, { value: "gemini/gemini-3.6-flash", source: "default" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { hotkey: OTHER_HOTKEY, thinking: "LOW" });
});

test("environment variables win over the file", () => {
  saveSetting(file, "hotkey", OTHER_HOTKEY);
  saveSetting(file, "model", "gemini-3.8-flash");
  const settings = resolveSettings({
    file,
    env: { WHISPRFLOW_HOTKEY: DEFAULT_HOTKEY, WHISPRFLOW_MODEL: "openai", GEMINI_THINKING_LEVEL: "high" },
  });
  assert.deepEqual(settings.hotkey, { value: DEFAULT_HOTKEY, source: "env" });
  assert.deepEqual(settings.model, { value: "openai/gpt-audio-mini", source: "env" });
  assert.deepEqual(settings.thinking, { value: "HIGH", source: "env" });
});

test("on-device model acceleration: auto (the GPU if there is one, falling back to the CPU) or cpu, any case, nothing else", () => {
  saveSetting(file, "acceleration", "CPU");
  assert.deepEqual(resolveSettings({ file, env: {} }).acceleration, { value: "cpu", source: "file" });
  assert.deepEqual(resolveSettings({ file, env: { WHISPRFLOW_ACCELERATION: "auto" } }).acceleration, {
    value: "auto",
    source: "env",
  });
  assert.throws(() => saveSetting(file, "acceleration", "gpu"), /auto \/ cpu/);
});

test("the hint above the bar can be turned off: on or off, any case, nothing else", () => {
  saveSetting(file, "barHint", "OFF");
  assert.deepEqual(resolveSettings({ file, env: {} }).barHint, { value: "off", source: "file" });
  assert.deepEqual(resolveSettings({ file, env: { WHISPRFLOW_BAR_HINT: "on" } }).barHint, {
    value: "on",
    source: "env",
  });
  assert.throws(() => saveSetting(file, "barHint", "hide"), /on \/ off/);
});

test("model: written vendor/model, a vendor alone uses its default; always saved as vendor/model", () => {
  assert.equal(saveSetting(file, "model", "openai"), "openai/gpt-audio-mini");
  assert.equal(saveSetting(file, "model", "OpenAI/gpt-audio-1.5"), "openai/gpt-audio-1.5");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { model: "openai/gpt-audio-1.5" });
  assert.throws(
    () => saveSetting(file, "model", "deepseek/deepseek-flash"),
    said(/unknown provider deepseek.*gemini \/ openai/),
  );
  assert.equal(en.text(SETTINGS.model.label("openai/gpt-audio-1.5")), "OpenAI");
});

test("older forms still work: a bare Gemini model name in the settings file, and the GEMINI_MODEL variable", () => {
  writeFileSync(file, JSON.stringify({ model: "gemini-3.8-flash" }));
  assert.deepEqual(resolveSettings({ file, env: {} }).model, { value: "gemini/gemini-3.8-flash", source: "file" });
  // With the older variable in use, say which one, so hints such as for theme changes point at the right one
  assert.deepEqual(resolveSettings({ file, env: { GEMINI_MODEL: "gemini-3.6-flash" } }).model, {
    value: "gemini/gemini-3.6-flash",
    source: "env",
    env: "GEMINI_MODEL",
  });
  // Both set: the newer one wins
  assert.equal(
    resolveSettings({ file, env: { GEMINI_MODEL: "gemini-3.6-flash", WHISPRFLOW_MODEL: "openai" } }).model.value,
    "openai/gpt-audio-mini",
  );
});

test("overridingEnv: which environment variable overrides this setting now; null when none", () => {
  assert.equal(overridingEnv("model", {}), null);
  assert.equal(overridingEnv("model", { GEMINI_MODEL: "x" }), "GEMINI_MODEL");
  assert.equal(overridingEnv("model", { GEMINI_MODEL: "x", WHISPRFLOW_MODEL: "openai" }), "WHISPRFLOW_MODEL");
  assert.equal(overridingEnv("theme", { WHISPRFLOW_THEME: "ink" }), "WHISPRFLOW_THEME");
});

test("unknown settings, hotkeys, and thinking levels are refused, listing the choices", () => {
  assert.throws(() => saveSetting(file, "volume", "11"), said(/hotkey.*model.*thinking/));
  assert.throws(() => saveSetting(file, "hotkey", "caps_lock"), said(new RegExp(HOTKEY_IDS.join(".*"))));
  assert.throws(() => saveSetting(file, "thinking", "none"), said(/MINIMAL.*LOW.*MEDIUM.*HIGH/));
  assert.throws(() => saveSetting(file, "model", "  "), said(/model/));
});

test("theme: by id or by name, saved as the id; an unknown one is refused, listing the themes", () => {
  assert.equal(saveSetting(file, "theme", "cinnabar"), "cinnabar");
  assert.equal(saveSetting(file, "theme", "Indigo"), "indigo");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { theme: "indigo" });
  assert.deepEqual(resolveSettings({ file, env: {} }).theme, { value: "indigo", source: "file" });
  assert.deepEqual(resolveSettings({ file, env: { WHISPRFLOW_THEME: "Cinnabar" } }).theme, {
    value: "cinnabar",
    source: "env",
  });
  assert.throws(() => saveSetting(file, "theme", "neon"), said(/ink \/ cinnabar \/ indigo/));
  assert.deepEqual(SETTINGS.theme.choices, ["ink", "cinnabar", "indigo"]);
});

test("described settings: the hotkey shows the key name, the theme its name, in the UI language; a language shows its own name", () => {
  assert.equal(en.text(SETTINGS.hotkey.label("fn")), "Globe (fn)");
  assert.equal(en.text(SETTINGS.theme.label("cinnabar")), "Cinnabar");
  assert.equal(en.text(SETTINGS.theme.label("indigo")), "Indigo");
  assert.equal(en.text(SETTINGS.language.label("en")), "English");
  assert.equal(en.text(SETTINGS.language.label("system")), "System");
});

test("hotkey choices depend on the OS, the first is the default; on Windows they are Right Alt and Right Ctrl", () => {
  assert.deepEqual(hotkeyIdsFor("darwin"), ["right_option", "right_command", "right_control", "fn"]);
  assert.deepEqual(hotkeyIdsFor("win32"), ["right_alt", "right_ctrl"]);
  assert.deepEqual(HOTKEY_IDS, hotkeyIdsFor(process.platform));
  assert.equal(en.text(SETTINGS.hotkey.label("right_alt")), "Right Alt");
  assert.equal(en.text(SETTINGS.hotkey.label("right_ctrl")), "Right Ctrl");
});

test("UI language: follows the system by default; any case and _ work, saved as the normalized id; an unknown one lists the choices", () => {
  assert.deepEqual(resolveSettings({ file, env: {} }).language, { value: "system", source: "default" });
  assert.equal(saveSetting(file, "language", "EN"), "en");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { language: "en" });
  assert.equal(saveSetting(file, "language", "System"), "system");
  assert.deepEqual(resolveSettings({ file, env: { WHISPRFLOW_LANGUAGE: "en" } }).language, {
    value: "en",
    source: "env",
  });
  assert.throws(() => saveSetting(file, "language", "ja"), said(/system \/ en/));
  assert.deepEqual(SETTINGS.language.choices, ["system", "en"]);
});

test("error wording follows the UI language", () => {
  assert.throws(
    () => saveSetting(file, "hotkey", "caps_lock"),
    (error) => en.text(error.problem) === `hotkey is "caps_lock": must be one of ${HOTKEY_IDS.join(" / ")}`,
  );
  assert.throws(
    () => resolveSettings({ file, env: { WHISPRFLOW_THEME: "neon" } }),
    (error) =>
      en.text(error.problem) === 'The WHISPRFLOW_THEME env var is "neon": must be one of ink / cinnabar / indigo',
  );
});

test("a wrong value in the environment or the file is an error, never quietly a default", () => {
  assert.throws(() => resolveSettings({ file, env: { WHISPRFLOW_HOTKEY: "caps_lock" } }), said(/WHISPRFLOW_HOTKEY/));
  writeFileSync(file, JSON.stringify({ hotkey: "caps_lock" }));
  assert.throws(() => resolveSettings({ file, env: {} }), said(/settings\.json/));
  writeFileSync(file, "{ not JSON");
  assert.throws(() => resolveSettings({ file, env: {} }), said(/settings\.json/));
});

test("unsetting a setting returns it to the default and leaves the rest", () => {
  saveSetting(file, "hotkey", OTHER_HOTKEY);
  saveSetting(file, "model", "gemini-3.8-flash");
  unsetSetting(file, "hotkey");
  const settings = resolveSettings({ file, env: {} });
  assert.deepEqual(settings.hotkey, { value: DEFAULT_HOTKEY, source: "default" });
  assert.deepEqual(settings.model, { value: "gemini/gemini-3.8-flash", source: "file" });
  assert.throws(() => unsetSetting(file, "volume"), said(/hotkey/));
});

test("saving works before the data directory exists", () => {
  const nested = join(dir, "not-yet", "settings.json");
  saveSetting(nested, "hotkey", OTHER_HOTKEY);
  assert.equal(resolveSettings({ file: nested, env: {} }).hotkey.value, OTHER_HOTKEY);
});

test("Gemini models are saved in the older form too (model name only), so an older version can still read the settings; reading always gives vendor/model", () => {
  assert.equal(saveSetting(file, "model", "gemini"), "gemini/gemini-3.6-flash");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { model: "gemini-3.6-flash" });
  assert.equal(resolveSettings({ file, env: {} }).model.value, "gemini/gemini-3.6-flash");
  // Older versions never understood other vendors, so they are saved as vendor/model
  saveSetting(file, "model", "openai");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { model: "openai/gpt-audio-mini" });
});

test("recognition mode: local (on-device plus Ollama) by default; native holds the audio model; local holds the on-device model, the cleanup vendor, and the custom address", () => {
  assert.deepEqual(routeOf(resolveSettings({ file, env: {} })), {
    mode: "local",
    transcriber: DEFAULT_TRANSCRIBER,
    polish: { vendor: "ollama", model: "qwen3:4b-instruct" },
    customUrl: null,
  });
  saveSetting(file, "mode", "Native");
  assert.deepEqual(routeOf(resolveSettings({ file, env: {} })), {
    mode: "native",
    model: { provider: "gemini", model: "gemini-3.6-flash" },
    thinkingLevel: "MINIMAL",
  });
  saveSetting(file, "mode", "Local");
  saveSetting(file, "polish", "custom/Qwen/Qwen3-8B");
  saveSetting(file, "customUrl", "https://api.siliconflow.cn/v1/chat/completions");
  const settings = resolveSettings({ file, env: {} });
  assert.deepEqual(settings.customUrl, { value: "https://api.siliconflow.cn/v1", source: "file" });
  assert.deepEqual(routeOf(settings), {
    mode: "local",
    transcriber: DEFAULT_TRANSCRIBER,
    polish: { vendor: "custom", model: "Qwen/Qwen3-8B" },
    customUrl: "https://api.siliconflow.cn/v1",
  });
  // Environment variables can change them too, with the same names as when the server starts on its own
  const env = {
    WHISPRFLOW_MODE: "native",
    WHISPRFLOW_POLISH: "ollama",
    WHISPRFLOW_TRANSCRIBER: "qwen3-asr-0.6b-int8",
  };
  const overridden = resolveSettings({ file, env });
  assert.equal(overridden.mode.value, "native");
  assert.equal(overridden.polish.value, "ollama/qwen3:4b-instruct");
  assert.equal(overridden.transcriber.value, "qwen3-asr-0.6b-int8");
});

test("each mode's route reads only its own settings: a route can be built for a mode that isn't in use", () => {
  saveSetting(file, "model", "openai");
  saveSetting(file, "polish", "ollama/llama3.2:3b");
  const settings = resolveSettings({ file, env: {} });
  assert.equal(settings.mode.value, "local");
  assert.deepEqual(routeOf(settings, "local"), {
    mode: "local",
    transcriber: DEFAULT_TRANSCRIBER,
    polish: { vendor: "ollama", model: "llama3.2:3b" },
    customUrl: null,
  });
  assert.deepEqual(routeOf(settings, "native").model, { provider: "openai", model: "gpt-audio-mini" });
});

test("each mode's own settings: native has the model and thinking level, local the two steps, private its own on-device model", () => {
  assert.deepEqual(MODE_SETTINGS, {
    native: ["model", "thinking"],
    local: ["transcriber", "polish", "customUrl"],
    private: ["privateTranscriber"],
  });
});

test("private mode's on-device model is saved apart from local's step one and only takes on-device ids", () => {
  const settings = resolveSettings({ file, env: {} });
  assert.deepEqual(routeOf(settings, "private"), { mode: "private", transcriber: DEFAULT_TRANSCRIBER });
  saveSetting(file, "privateTranscriber", "qwen3-asr-0.6b-int8");
  const saved = resolveSettings({ file, env: {} });
  assert.equal(routeOf(saved, "private").transcriber, "qwen3-asr-0.6b-int8");
  assert.equal(routeOf(saved, "local").transcriber, DEFAULT_TRANSCRIBER);
  assert.throws(() => saveSetting(file, "privateTranscriber", "example/cloud-asr"), /qwen3-asr-0\.6b-q8/);
  const fromEnv = resolveSettings({ file, env: { WHISPRFLOW_PRIVATE_TRANSCRIBER: "qwen3-asr-0.6b-q8" } });
  assert.equal(fromEnv.privateTranscriber.value, "qwen3-asr-0.6b-q8");
  assert.equal(patchSettings(saved, { mode: "PRIVATE" }).mode.value, "private");
});

test("patchSettings builds the patched settings without writing the file, with the same errors as saving", () => {
  const settings = resolveSettings({ file, env: {} });
  const patched = patchSettings(settings, { mode: "LOCAL", polish: "ollama/llama3.2:3b" });
  assert.equal(patched.mode.value, "local");
  assert.equal(patched.polish.value, "ollama/llama3.2:3b");
  assert.equal(patched.model, settings.model);
  assert.equal(existsSync(file), false);
  assert.throws(() => patchSettings(settings, { polish: "nobody/x" }), said(/polish.*ollama/));
  assert.throws(() => patchSettings(settings, { colour: "red" }), said(/colour/));
});

test("wrong recognition settings are refused, listing the choices; the custom address can be cleared", () => {
  assert.throws(() => saveSetting(file, "mode", "cloud"), said(/native \/ local/));
  assert.throws(() => saveSetting(file, "transcriber", "whisper-9"), said(/qwen3-asr-0\.6b-q8/));
  assert.throws(() => saveSetting(file, "polish", "nobody/x"), said(/ollama/));
  assert.throws(() => saveSetting(file, "customUrl", "api.example.com"), said(/https:\/\//));
  saveSetting(file, "customUrl", "https://x.example/v1");
  assert.equal(saveSetting(file, "customUrl", ""), "");
});
