import assert from "node:assert/strict";
import { test } from "node:test";
import { renderStatus } from "../../../src/cli/render/status.mjs";
import { hotkeyName, noStats, plain, ready, settings } from "./fixtures.mjs";

test("when not running it only says how to start", () => {
  const text = renderStatus({ status: null, version: "0.1.0", settings, stats: noStats }, plain);
  assert.match(text, /WhisprFlow 0\.1\.0 · not running/);
  assert.match(text, /whisprflow/);
  assert.doesNotMatch(text, /Permissions/);
});

test("when everything is ready it says how to use it and lists the key, permissions, hotkey, and model", () => {
  const text = renderStatus({ status: ready, version: "0.1.0", settings, stats: noStats }, plain);
  assert.match(text, /WhisprFlow 0\.1\.0 · running/);
  assert.match(text, new RegExp(`press ${hotkeyName} to start talking`));
  assert.match(text, /Key\s+Saved and verified/);
  assert.match(text, /Microphone ✓\s+Input Monitoring ✓\s+Accessibility ✓/);
  assert.match(text, new RegExp(`Hotkey\\s+${hotkeyName}`));
  assert.match(text, /Model\s+Gemini gemini-3\.6-flash \(MINIMAL\)/);
});

test("with things missing, the title says how many, each is marked, and it says permissions belong to the terminal", () => {
  const status = {
    ...ready,
    key: { state: "missing", source: null, problem: null },
    permissions: { microphone: "denied", listen: false, trusted: false },
    summary: {
      ready: false,
      missing: ["Gemini API key", "microphone access", "Input Monitoring access"],
      blocker: "No Gemini API key",
      degraded: "No Accessibility access: text goes to the clipboard, press ⌘V",
    },
  };
  const text = renderStatus({ status, version: "0.1.0", settings, stats: noStats }, plain);
  assert.match(text, /running, 3 things missing/);
  assert.match(text, /Key\s+Not set: run whisprflow key/);
  assert.match(text, /Microphone ✗\s+Input Monitoring ✗\s+Accessibility ✗/);
  assert.match(text, /No Accessibility access: text goes to the clipboard/);
  assert.match(text, /whisprflow settings/);
  assert.match(text, /terminal/);
});

test("Windows has only the microphone permission: no Input Monitoring or Accessibility, and nothing about the terminal", () => {
  const windows = { ...plain, platform: "win32" };
  assert.match(
    renderStatus({ status: ready, version: "0.1.0", settings, stats: noStats }, windows),
    /Permissions\s+Microphone ✓\n/,
  );
  const denied = {
    ...ready,
    permissions: { microphone: "denied", listen: true, trusted: true },
    summary: { ready: false, missing: ["microphone access"], blocker: "No microphone access", degraded: null },
  };
  const text = renderStatus({ status: denied, version: "0.1.0", settings, stats: noStats }, windows);
  assert.match(text, /Permissions\s+Microphone ✗\n/);
  assert.match(text, /whisprflow settings/);
  assert.doesNotMatch(text, /Input Monitoring|Accessibility|terminal/);
});

test("each key state has its own sentence", () => {
  const withKey = (key) =>
    renderStatus({ status: { ...ready, key }, version: "0.1.0", settings, stats: noStats }, plain);
  assert.match(withKey({ state: "ready", source: "env", problem: null, verified: true }), /GEMINI_API_KEY/);
  assert.match(withKey({ state: "checking", source: "stored", problem: null }), /Verifying/);
  assert.match(withKey({ state: "unreadable", source: "stored", problem: "can't be read" }), /can't be read/);
  // Offline at startup: in use, honestly marked not yet verified
  assert.match(withKey({ state: "ready", source: "stored", problem: null, verified: false }), /Saved.*verified yet/);
});

test("an unusable key says what to do by cause: replace the key, fix the environment variable, or check the model settings", () => {
  const rejected = (key) =>
    renderStatus(
      { status: { ...ready, key: { state: "rejected", ...key } }, version: "0.1.0", settings, stats: noStats },
      plain,
    );
  const revoked = rejected({ source: "stored", cause: "key", problem: "This key is invalid" });
  assert.match(revoked, /This key is invalid/);
  assert.match(revoked, /whisprflow key/);

  // A bad key in the environment: saving a new one won't help, the next launch uses the environment again
  const badEnv = rejected({ source: "env", cause: "key", problem: "This key is invalid" });
  assert.match(badEnv, /GEMINI_API_KEY.*This key is invalid/);
  assert.doesNotMatch(badEnv, /whisprflow key/);

  // Gemini rejected the request: usually the model name or level, so don't send people to replace the key
  const wrongModel = rejected({
    source: "stored",
    cause: "other",
    problem: "Gemini rejected the request: models/x is not found",
  });
  assert.match(wrongModel, /Gemini rejected the request: models\/x is not found/);
  assert.match(wrongModel, /whisprflow config/);
  assert.doesNotMatch(wrongModel, /whisprflow key/);
});

test("the model and hotkey shown are the ones the background app uses; settings changed but not applied suggest a restart", () => {
  // The background app started with other settings (an environment variable on the command that started it, say)
  const status = { ...ready, model: "gemini/gemini-3.8-flash", thinking: "LOW" };
  const stale = renderStatus({ status, version: "0.1.0", settings, stats: noStats }, plain);
  assert.match(stale, /Model\s+Gemini gemini-3\.8-flash \(LOW\)/);
  assert.match(stale, /model \/ thinking.*whisprflow restart/);

  const same = renderStatus({ status: ready, version: "0.1.0", settings, stats: noStats }, plain);
  assert.doesNotMatch(same, /whisprflow restart/);

  const external = {
    ...ready,
    model: null,
    thinking: null,
    key: { state: "ready", source: "external", problem: null },
  };
  assert.match(
    renderStatus({ status: external, version: "0.1.0", settings, stats: noStats }, plain),
    /Model\s+decided by the separately started server/,
  );
});

test("the key listener helper stopped: it says the hotkey won't work and what to do", () => {
  const status = {
    ...ready,
    helper: "stopped",
    permissions: { microphone: "granted", listen: null, trusted: null },
    summary: { ready: false, missing: ["key listener"], blocker: null, degraded: null },
  };
  const text = renderStatus({ status, version: "0.1.0", settings, stats: noStats }, plain);
  assert.match(text, /1 thing missing/);
  assert.match(text, /hotkey won't work/);
  assert.match(text, /whisprflow restart/);
});

test("running as the packaged app, permissions belong to WhisprFlow itself, not the terminal", () => {
  const status = {
    ...ready,
    packaged: true,
    permissions: { microphone: "granted", listen: false, trusted: true },
    summary: { ready: false, missing: ["Input Monitoring access"], blocker: null, degraded: null },
  };
  const text = renderStatus({ status, version: "0.1.0", settings, stats: noStats }, plain);
  assert.match(text, /WhisprFlow/);
  assert.doesNotMatch(text, /terminal/);
});

test("while still starting it says so honestly, never ready too early", () => {
  const status = { ...ready, starting: true, summary: { ...ready.summary, ready: false } };
  const text = renderStatus({ status, version: "0.1.0", settings, stats: noStats }, plain);
  assert.match(text, /starting/i);
  assert.doesNotMatch(text, /start talking/);
});

test("with history it shows today's and all-time numbers: dictations, characters, time, characters per minute", () => {
  const stats = {
    today: { dictations: 3, characters: 420, seconds: 95, failed: 0 },
    total: { dictations: 132, characters: 12480, seconds: 2880, failed: 2 },
  };
  const text = renderStatus({ status: ready, version: "0.1.0", settings, stats }, plain);
  assert.match(text, /Today\s+3 dictations · 420 characters · 1m 35s/);
  assert.match(text, /All time\s+132 dictations · 12,480 characters · 48 min · 260 characters\/min/);
});

test("with billing it adds the spend; with unpriced calls it says at least, never counting half as the whole", () => {
  const stats = {
    today: { dictations: 3, characters: 420, seconds: 95, failed: 0, costUsd: 0.0036, unpricedCalls: 0 },
    total: { dictations: 132, characters: 12480, seconds: 2880, failed: 2, costUsd: 0.16, unpricedCalls: 4 },
  };
  const text = renderStatus({ status: ready, version: "0.1.0", settings, stats }, plain);
  assert.match(text, /Today\s+3 dictations · 420 characters · 1m 35s · \$0\.0036\n/);
  assert.match(text, /All time\s+.* · at least \$0\.16\n/);
});

test("no statistics before anything was said", () => {
  const stats = {
    today: { dictations: 0, characters: 0, seconds: 0, failed: 0 },
    total: { dictations: 0, characters: 0, seconds: 0, failed: 0 },
  };
  const text = renderStatus({ status: ready, version: "0.1.0", settings, stats }, plain);
  assert.doesNotMatch(text, /All time/);
});

test("the panel shows the theme when the background app reports one, by name when known; older versions report none", () => {
  const withTheme = (theme) =>
    renderStatus({ status: { ...ready, theme }, version: "0.1.0", settings, stats: noStats }, plain);
  assert.match(withTheme("indigo"), /Theme\s+Indigo \(indigo\)/);
  assert.match(withTheme("neon"), /Theme\s+neon\n/);
  assert.doesNotMatch(renderStatus({ status: ready, version: "0.1.0", settings, stats: noStats }, plain), /Theme/);
  // Settings differ from the theme in use (the file edited by hand, or an environment variable where it started)
  const pending = renderStatus(
    {
      status: { ...ready, theme: "ink" },
      version: "0.1.0",
      settings: { ...settings, theme: { value: "indigo", source: "file" } },
      stats: noStats,
    },
    plain,
  );
  assert.match(pending, /theme/);
  assert.match(pending, /whisprflow restart/);
});

test("with color on, check marks and crosses are colored; off, it is plain text", () => {
  const view = { status: ready, version: "0.1.0", settings, stats: noStats };
  assert.ok(renderStatus(view, { ...plain, color: true }).includes("\x1b[32m✓\x1b[0m"));
  assert.ok(!renderStatus(view, plain).includes("\x1b["));
});

test("using OpenAI: the model names the vendor and omits the thinking level; the key's environment variable is named too", () => {
  const status = {
    ...ready,
    provider: "openai",
    model: "openai/gpt-audio-mini",
    thinking: null,
    key: { state: "ready", source: "env", problem: null, verified: true },
  };
  const openaiSettings = { ...settings, model: { value: "openai/gpt-audio-mini", source: "file" } };
  const text = renderStatus({ status, version: "0.1.0", settings: openaiSettings, stats: noStats }, plain);
  assert.match(text, /Model\s+OpenAI gpt-audio-mini\n/);
  assert.match(text, /OPENAI_API_KEY/);
  // A thinking level in settings that it can't use is no reason to say "not applied"
  assert.doesNotMatch(text, /whisprflow restart/);

  const offline = renderStatus(
    {
      status: { ...status, key: { ...status.key, verified: false } },
      version: "0.1.0",
      settings: openaiSettings,
      stats: noStats,
    },
    plain,
  );
  assert.match(offline, /couldn't reach OpenAI/);
});

test("local mode: shows the mode, what each step uses, and how far the local model download is", () => {
  const status = {
    ...ready,
    provider: null,
    mode: "local",
    model: null,
    thinking: null,
    transcriber: "qwen3-asr-0.6b-q8",
    polish: "ollama/qwen3:4b-instruct",
    key: { state: "ready", source: "none", problem: null },
    localModel: { state: "downloading", model: "qwen3-asr-0.6b-q8", received: 425_000_000, total: 850_000_000 },
  };
  const localSettings = { ...settings, mode: { value: "local", source: "file" } };
  const text = renderStatus({ status, version: "0.1.0", settings: localSettings, stats: noStats }, plain);
  assert.match(text, /Mode\s+Local: /);
  assert.match(text, /Model\s+qwen3-asr-0\.6b-q8 → Ollama qwen3:4b-instruct/);
  assert.match(text, /Local model\s+downloading 50% \(425 \/ 850 MB\)/);
  assert.match(text, /Key\s+Not needed/);
  assert.doesNotMatch(text, /whisprflow restart/);

  const readyText = renderStatus(
    {
      status: { ...status, localModel: { state: "ready", model: "qwen3-asr-0.6b-q8", backend: "MTL0" } },
      version: "0.1.0",
      settings: localSettings,
      stats: noStats,
    },
    plain,
  );
  assert.match(readyText, /Local model\s+ready · Metal/);

  // It never downloads on its own: not downloaded says how; while the user downloads it, how far
  const missing = (localModel) =>
    renderStatus(
      { status: { ...status, localModel }, version: "0.1.0", settings: localSettings, stats: noStats },
      plain,
    );
  assert.match(
    missing({ state: "missing", model: "qwen3-asr-0.6b-q8" }),
    /Local model\s+not downloaded: whisprflow transcriber download qwen3-asr-0\.6b-q8/,
  );
  assert.match(
    missing({ state: "missing", model: "qwen3-asr-0.6b-q8", received: 425_000_000, total: 850_000_000 }),
    /Local model\s+downloading 50% \(425 \/ 850 MB\)/,
  );
});
