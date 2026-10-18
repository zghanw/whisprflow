import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeSetup, summaryAsText } from "../../src/app/setup-state.mjs";
import { createTranslator, msg } from "../../src/i18n/index.mjs";

// Checked with the macOS wording; the Windows wording is checked in the i18n test
const en = createTranslator("en", "darwin");
/** The summary's sentences translated before comparing: whoever displays them translates */
const summarize = (setup) => summaryAsText(summarizeSetup(setup), en);

const allGood = {
  key: { state: "ready", source: "stored", problem: null },
  permissions: { microphone: "granted", listen: true, trusted: true },
};
const withKey = (key) => ({ ...allGood, key: { source: null, problem: null, ...key } });
const withPermissions = (permissions) => ({ ...allGood, permissions: { ...allGood.permissions, ...permissions } });

test("everything in place: ready, nothing missing", () => {
  assert.deepEqual(summarize(allGood), { ready: true, missing: [], blocker: null, degraded: null });
});

test("no key or an unreadable key: not ready, with a hint to enter it in Settings", () => {
  for (const state of ["missing", "unreadable"]) {
    const summary = summarize(withKey({ state }));
    assert.equal(summary.ready, false);
    assert.deepEqual(summary.missing, ["Gemini API key"]);
    assert.match(summary.blocker, /Settings/);
  }
});

test("a key that failed verification passes the reason on to the user", () => {
  const summary = summarize(withKey({ state: "rejected", problem: "This key is invalid" }));
  assert.equal(summary.ready, false);
  assert.match(summary.blocker, /This key is invalid/);
});

test("Gemini rejecting the request (a wrong model name or level) is not called a key problem", () => {
  const summary = summarize(
    withKey({ state: "rejected", cause: "other", problem: "Gemini rejected the request: models/x is not found" }),
  );
  assert.equal(summary.ready, false);
  assert.deepEqual(summary.missing, ["Gemini check"]);
  assert.match(summary.blocker, /^Gemini check failed: .*models\/x is not found/);
});

test("a stored key used while offline at startup counts as ready", () => {
  assert.equal(summarize(withKey({ state: "ready", source: "stored", verified: false })).ready, true);
});

test("a key still being checked: not ready, but nothing missing", () => {
  const summary = summarize(withKey({ state: "checking" }));
  assert.equal(summary.ready, false);
  assert.deepEqual(summary.missing, []);
  assert.match(summary.blocker, /one moment/);
});

test("microphone or Input Monitoring not granted are listed as missing", () => {
  assert.deepEqual(summarize(withPermissions({ microphone: "denied" })).missing, ["microphone access"]);
  assert.deepEqual(summarize(withPermissions({ listen: false })).missing, ["Input Monitoring access"]);
  assert.deepEqual(
    summarize(withKey({ state: "missing" })).missing.concat(
      summarize(withPermissions({ microphone: "denied", listen: false })).missing,
    ),
    ["Gemini API key", "microphone access", "Input Monitoring access"],
  );
});

test("key listening not started yet: not ready for now, but no permission missing", () => {
  const summary = summarize(withPermissions({ listen: null, trusted: null }));
  assert.equal(summary.ready, false);
  assert.deepEqual(summary.missing, []);
});

test("only Accessibility missing: still usable, the user just pastes", () => {
  const summary = summarize(withPermissions({ trusted: false }));
  assert.equal(summary.ready, true);
  assert.deepEqual(summary.missing, []);
  assert.match(summary.degraded, /clipboard/);
});

test('the key listener helper stopped: no longer "getting ready", it says the listener is missing', () => {
  const summary = summarize({ ...withPermissions({ listen: null, trusted: null }), helper: "stopped" });
  assert.equal(summary.ready, false);
  assert.deepEqual(summary.missing, ["key listener"]);
});

test("with another vendor's model, a missing key and a failed check name that vendor", () => {
  const missing = summarize({ ...withKey({ state: "missing" }), providerName: "OpenAI" });
  assert.deepEqual(missing.missing, ["OpenAI API key"]);
  assert.match(missing.blocker, /^No OpenAI API key/);
  const rejected = summarize({
    ...withKey({ state: "rejected", cause: "other", problem: "OpenAI doesn't have this model" }),
    providerName: "OpenAI",
  });
  assert.deepEqual(rejected.missing, ["OpenAI check"]);
  assert.match(rejected.blocker, /^OpenAI check failed/);
});

test("an undownloaded local model is missing and says where to get it; while downloading it says how far; loading is not ready but not missing", () => {
  const missing = summarize({ ...allGood, localModel: { state: "missing", model: "qwen3-asr-0.6b-q8" } });
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.missing, ["local model"]);
  assert.match(
    missing.blocker,
    /Qwen3-ASR 0\.6B \(Q8_0\) isn't downloaded.*whisprflow transcriber download qwen3-asr-0\.6b-q8/,
  );

  const downloading = summarize({
    ...allGood,
    localModel: { state: "missing", model: "qwen3-asr-0.6b-q8", received: 425, total: 850 },
  });
  assert.equal(downloading.ready, false);
  assert.deepEqual(downloading.missing, ["local model (downloading, 50%)"]);
  assert.match(downloading.blocker, /downloading.*50%/);
  const loading = summarize({ ...allGood, localModel: { state: "loading", model: "m" } });
  assert.match(loading.blocker, /loading/);
  assert.deepEqual(loading.missing, []);
});

test("a local model that failed to load is missing, with the reason passed on", () => {
  const summary = summarize({
    ...allGood,
    localModel: { state: "failed", model: "m", problem: msg("local.modelFailed", { reason: "disk full" }) },
  });
  assert.equal(summary.ready, false);
  assert.deepEqual(summary.missing, ["local model"]);
  assert.match(summary.blocker, /disk full/);
});

test("a ready local model, or no local path at all, doesn't affect the summary; key problems are mentioned first", () => {
  for (const localModel of [{ state: "ready", model: "m" }, { state: "off" }, null]) {
    assert.equal(summarize({ ...allGood, localModel }).ready, true);
  }
  const both = summarize({
    ...withKey({ state: "missing" }),
    localModel: { state: "missing", model: "qwen3-asr-0.6b-q8" },
  });
  assert.match(both.blocker, /key/);
});

test("the full summary: what's missing, the hotkey sentence, and the degraded note", () => {
  const setup = {
    ...withKey({ state: "missing" }),
    permissions: { microphone: "denied", listen: false, trusted: false },
    providerName: "OpenAI",
  };
  assert.deepEqual(summarize(setup), {
    ready: false,
    missing: ["OpenAI API key", "microphone access", "Input Monitoring access"],
    blocker: "No OpenAI API key: menu bar icon › Settings",
    degraded: "No Accessibility access: text goes to the clipboard, press ⌘V",
  });
  // A reason that is the model's own words is passed on as is
  const rejected = summarize(withKey({ state: "rejected", cause: "other", problem: "models/x is not found" }));
  assert.equal(rejected.blocker, "Gemini check failed: models/x is not found");
});

test("the summary for the CLI translates every sentence to text (the CLI and status --json readers only take text)", () => {
  const summary = summarizeSetup(withPermissions({ microphone: "denied", listen: false, trusted: false }));
  assert.deepEqual(summaryAsText(summary, en), {
    ready: false,
    missing: ["microphone access", "Input Monitoring access"],
    blocker: en.text(summary.blocker),
    degraded: en.text(summary.degraded),
  });
  assert.equal(typeof summaryAsText(summary, en).blocker, "string");
  assert.deepEqual(summaryAsText(summarizeSetup(allGood), en), {
    ready: true,
    missing: [],
    blocker: null,
    degraded: null,
  });
});

test("cleanup on this computer not working yet (Ollama not running): still ready, with a note that what was heard gets pasted", () => {
  const summary = summarize(
    withKey({
      state: "ready",
      source: "none",
      verified: false,
      problem: msg("model.localNotRunning", { provider: "Ollama" }),
    }),
  );
  assert.equal(summary.ready, true);
  assert.deepEqual(summary.missing, []);
  assert.equal(
    summary.degraded,
    "Cleanup is off for now, so dictation pastes what was heard: Ollama isn't running. Start it, or install it from ollama.com",
  );
  // A keyed route used offline at startup isn't described this way: its key is unverified, not its cleanup
  assert.equal(summarize(withKey({ state: "ready", source: "stored", verified: false })).degraded, null);
});
