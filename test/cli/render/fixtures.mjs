// Shared by the screen tests: a fixed time zone and "now", a ready status, and default settings.

import { createTranslator } from "../../../src/i18n/index.mjs";
import { HOTKEY_IDS } from "../../../src/storage/settings.mjs";

export const en = createTranslator("en");

/** This OS's default hotkey (right Option on macOS, right Alt on Windows) and its name */
export const hotkey = HOTKEY_IDS[0];
export const hotkeyName = en(`hotkeys.${hotkey}.name`);

export const timeZone = "Asia/Shanghai";
// 2026-10-13 15:00 in Shanghai
export const now = new Date("2026-10-13T07:00:00.000Z");
export const plain = { color: false, timeZone, now, t: en, platform: "darwin" };
export const english = plain;

export const ready = {
  pid: 4321,
  version: "0.1.0",
  starting: false,
  hotkey,
  hotkeyLabel: hotkeyName,
  provider: "gemini",
  model: "gemini/gemini-3.6-flash",
  thinking: "MINIMAL",
  packaged: false,
  helper: "running",
  key: { state: "ready", source: "stored", problem: null, verified: true },
  permissions: { microphone: "granted", listen: true, trusted: true },
  summary: { ready: true, missing: [], blocker: null, degraded: null },
};
export const settings = {
  hotkey: { value: hotkey, source: "default" },
  mode: { value: "native", source: "default" },
  model: { value: "gemini/gemini-3.6-flash", source: "default" },
  thinking: { value: "MINIMAL", source: "default" },
  transcriber: { value: "qwen3-asr-0.6b-q8", source: "default" },
  privateTranscriber: { value: "qwen3-asr-0.6b-q8", source: "default" },
  polish: { value: "ollama/qwen3:4b-instruct", source: "default" },
  customUrl: { value: "", source: "default" },
  modelSource: { value: "original", source: "default" },
  acceleration: { value: "auto", source: "default" },
  barHint: { value: "on", source: "default" },
  theme: { value: "ink", source: "default" },
  language: { value: "system", source: "default" },
};
export const noStats = { today: null, total: null };
