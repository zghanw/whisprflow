import assert from "node:assert/strict";
import { test } from "node:test";
import { renderConfig, renderThemes } from "../../../src/cli/render/settings.mjs";
import { HOTKEY_IDS } from "../../../src/storage/settings.mjs";
import { THEMES } from "../../../src/themes/index.mjs";
import { plain, settings } from "./fixtures.mjs";

test("settings lists each value, where it came from, and the choices, followed by where the files are", () => {
  const text = renderConfig(
    {
      settings: {
        ...settings,
        hotkey: { value: "fn", source: "file" },
        model: { value: "gemini/gemini-3.8-flash", source: "env", env: "GEMINI_MODEL" },
      },
      paths: {
        home: "/home/.whisprflow",
        settingsFile: "/home/.whisprflow/settings.json",
        logFile: "/home/.whisprflow/logs/main.log",
      },
    },
    plain,
  );
  assert.match(text, /hotkey\s+fn\s+Globe \(fn\)/);
  // The choices follow this OS
  assert.match(text, new RegExp(HOTKEY_IDS.join(" \\/ ")));
  // The older environment variable is in use: its name is stated as is
  assert.match(text, /model\s+gemini\/gemini-3\.8-flash\s+Gemini · from the GEMINI_MODEL env var this run/);
  assert.match(text, /thinking\s+MINIMAL\s+.*default/);
  assert.match(text, /mode\s+native\s+Native: the recording goes straight to the model · default/);
  assert.match(text, /native \/ local \/ private/);
  assert.match(text, /privateTranscriber\s+qwen3-asr-0\.6b-q8/);
  assert.match(text, /polish\s+ollama\/qwen3:4b-instruct\s+default/);
  assert.match(text, /customUrl\s+default/);
  assert.match(text, /modelSource\s+original\s+Hugging Face · default/);
  assert.match(text, /original \/ mirror/);
  assert.match(text, /acceleration\s+auto\s+Automatic \(GPU if available\) · default/);
  assert.match(text, /auto \/ cpu/);
  assert.match(text, /barHint\s+on\s+Shown · default/);
  assert.match(text, /on \/ off/);
  assert.match(text, /theme\s+ink\s+Ink · default/);
  assert.match(text, /ink \/ cinnabar \/ indigo/);
  assert.match(text, /whisprflow config set hotkey fn/);
  assert.match(text, /Folder\s+\/home\/\.whisprflow\n/);
  assert.match(text, /\/home\/\.whisprflow\/logs\/main\.log/);
  assert.match(text, /whisprflow uninstall/);
});

test("themes: one per line, the one in use marked; with 24-bit color the terminal draws each theme's bar", () => {
  const view = { themes: THEMES, setting: { value: "cinnabar", source: "file" } };
  const text = renderThemes(view, plain);
  assert.match(text, /^Themes\n/);
  assert.match(text, /\n {4}ink\s+Ink\s+Black and white/);
  assert.match(text, /\n {2}● cinnabar\s+Cinnabar\s+A warm red/);
  assert.match(text, /Using Cinnabar \(cinnabar\) · from the settings file/);
  // The example given is another theme, not the one already in use
  assert.match(text, /Switch: whisprflow theme violet/);
  assert.ok(!text.includes("\x1b["));

  const painted = renderThemes(view, { ...plain, color: true, truecolor: true });
  // Cinnabar's wave is that warm red: oklch(0.74 0.17 32)
  assert.ok(painted.includes("\x1b[38;2;255;124;99m"), JSON.stringify(painted));
  assert.equal(painted.split("\x1b[48;2;").length - 1 >= THEMES.length, true);
  // With plain color but no 24-bit color, nothing is drawn
  assert.ok(!renderThemes(view, { ...plain, color: true, truecolor: false }).includes("[48;2;"));
});
