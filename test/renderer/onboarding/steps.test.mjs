import assert from "node:assert/strict";
import { test } from "node:test";
import {
  firstStepOf,
  GROUPS,
  groupStates,
  STEPS,
  startStep,
  stepDone,
} from "../../../src/renderer/onboarding/steps.mjs";

const QWEN = "qwen3-asr-0.6b-q8";

const setup = ({ mode = "native", key = "missing", installed = false, switchable = true, permissions = {} } = {}) => ({
  mode: { value: mode },
  native: { model: "gemini/gemini-3.6-flash", providers: [{ id: "gemini", key: null }] },
  local: {
    transcriber: QWEN,
    polish: "ollama/qwen3:4b-instruct",
    transcribers: [{ id: QWEN, installed, download: null }],
    vendors: [{ id: "ollama", key: null }],
  },
  private: { transcriber: QWEN },
  // What each mode is missing, as the main process computes it from the settings (ways in app/model-plaza.mjs)
  plaza: {
    presets: [],
    ways: {
      native: { hops: [], needs: key === "missing" ? [{ kind: "key", platform: "gemini" }] : [] },
      local: { hops: [{ platform: "local" }], needs: [] },
      private: { hops: [{ platform: "local" }], needs: installed ? [] : [{ kind: "download", model: QWEN }] },
    },
  },
  provider: mode === "private" ? null : { id: "gemini" },
  key: { state: key },
  switchable,
  permissions: { microphone: "granted", listen: true, trusted: true, ...permissions },
});

test("onboarding order: choose how to use it, prepare models, permissions, microphone test, shortcut test, try it, done", () => {
  assert.deepEqual(STEPS, ["way", "prepare", "permissions", "microphone", "hotkey", "try", "done"]);
});

test("where it starts: at choosing how to use it while the set in use can't work yet; at permissions once it can", () => {
  assert.equal(startStep(setup()), "way");
  assert.equal(startStep(setup({ key: "rejected" })), "way");
  assert.equal(startStep(setup({ key: "ready" })), "permissions");
  // A key being verified isn't asked for again
  assert.equal(startStep(setup({ key: "checking" })), "permissions");
  assert.equal(startStep(setup({ mode: "private" })), "way");
  assert.equal(startStep(setup({ mode: "private", installed: true })), "permissions");
  // Connected to a separately started server: that server decides the mode
  assert.equal(startStep(setup({ switchable: false })), "permissions");
});

test("whether each step is done: unfinished steps say Skip and still allow moving on", () => {
  const state = (extra = {}) => ({ setup: setup(), said: false, ...extra });
  assert.equal(stepDone("way", state()), true);
  assert.equal(stepDone("prepare", state()), false);
  assert.equal(stepDone("prepare", state({ setup: setup({ key: "ready" }) })), true);
  assert.equal(stepDone("permissions", state()), true);
  assert.equal(stepDone("permissions", state({ setup: setup({ permissions: { listen: false } }) })), false);
  assert.equal(stepDone("permissions", state({ setup: setup({ permissions: { microphone: "denied" } }) })), false);
  // Accessibility can be granted later
  assert.equal(stepDone("permissions", state({ setup: setup({ permissions: { trusted: false } }) })), true);
  // The microphone and shortcut tests rely on their own "Yes, continue"
  assert.equal(stepDone("microphone", state()), false);
  assert.equal(stepDone("hotkey", state()), false);
  assert.equal(stepDone("try", state()), false);
  assert.equal(stepDone("try", state({ said: true })), true);
});

test("the three top segments: clicking one goes to its first step; done, current, and todo", () => {
  assert.deepEqual(GROUPS, ["model", "setup", "try"]);
  assert.deepEqual(GROUPS.map(firstStepOf), ["way", "permissions", "try"]);
  assert.deepEqual(groupStates("prepare"), { model: "current", setup: "todo", try: "todo" });
  assert.deepEqual(groupStates("hotkey"), { model: "done", setup: "current", try: "todo" });
  assert.deepEqual(groupStates("done"), { model: "done", setup: "done", try: "current" });
});
