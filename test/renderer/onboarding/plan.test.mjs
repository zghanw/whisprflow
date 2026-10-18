import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changesOf,
  hasKey,
  inEffect,
  localModelOf,
  needsOf,
  planOf,
  readinessOf,
  vendorsFor,
} from "../../../src/renderer/onboarding/plan.mjs";

const QWEN = "qwen3-asr-0.6b-q8";
const INT8 = "qwen3-asr-0.6b-int8";
/** A cloud step one, as the model page can set it up */
const CLOUD = "openai/gpt-4o-transcribe";
/** Polish vendors that need no key */
const KEYLESS = ["ollama", "custom"];

/**
 * Each mode as the main process computes it from the settings (ways in app/model-plaza.mjs): the route and what is missing.
 * A simplified copy of its rules: an on-device model not downloaded, a provider without a key (not in sources), a custom service without an address
 */
function waysOf({ native, transcriber, privateTranscriber, polish, customUrl, installed, sources }) {
  const first = (id) =>
    id.includes("/") ? { platform: id.split("/")[0], maker: "openai", name: id } : { platform: "local" };
  const way = (mode) => {
    const local = mode === "native" ? null : mode === "private" ? privateTranscriber : transcriber;
    const vendor = mode === "native" ? native.split("/")[0] : mode === "local" ? polish.split("/")[0] : null;
    const needs = [];
    if (local && !local.includes("/") && !installed.includes(local)) needs.push({ kind: "download", model: local });
    if (local?.includes("/") && !sources[local.split("/")[0]])
      needs.push({ kind: "key", platform: local.split("/")[0] });
    if (vendor && !KEYLESS.includes(vendor) && !sources[vendor]) needs.push({ kind: "key", platform: vendor });
    if (vendor === "custom" && !customUrl) needs.push({ kind: "url" });
    return { hops: local ? [first(local)] : [], needs };
  };
  return { native: way("native"), local: way("local"), private: way("private") };
}

/** The parts of getSetup onboarding uses: as on first open, native, Gemini, no key, nothing downloaded */
function setup({
  mode = "native",
  native = "gemini/gemini-3.6-flash",
  transcriber = QWEN,
  privateTranscriber = QWEN,
  polish = "ollama/qwen3:4b-instruct",
  customUrl = "",
  installed = [],
  downloading = [],
  keys = {},
  provider = "gemini",
  key = "missing",
  localModel = null,
  presets = [
    { mode: "local", settings: { transcriber: QWEN, polish: "ollama/qwen3:4b-instruct" } },
    { mode: "native", settings: { model: "gemini/gemini-3.6-flash" } },
    { mode: "local", settings: { transcriber: CLOUD, polish: "ollama/qwen3:4b-instruct" } },
    { mode: "private", settings: { privateTranscriber: QWEN } },
  ],
} = {}) {
  const vendor = (id) => ({ id, key: keys[id] ?? null });
  // The service holds that provider's key (ready, verifying, rejected, unreadable): it counts as stored
  const holding = provider && key !== "missing" ? { [provider]: "stored" } : {};
  const sources = { ...keys, ...holding };
  return {
    mode: { value: mode },
    native: { model: native, providers: ["gemini", "openai"].map(vendor) },
    local: {
      transcriber,
      polish,
      transcribers: [QWEN, INT8].map((id) => ({
        id,
        installed: installed.includes(id),
        download: downloading.includes(id) ? { received: 1, total: 10 } : null,
      })),
      vendors: ["ollama", "custom"].map(vendor),
    },
    private: { transcriber: privateTranscriber },
    plaza: {
      presets,
      ways: waysOf({ native, transcriber, privateTranscriber, polish, customUrl, installed, sources }),
    },
    provider: provider ? { id: provider } : null,
    key: { state: key, problem: key === "rejected" ? "This key is invalid" : null },
    localModel,
  };
}

test("providers to pick from: native lists the audio providers; transcribe + polish lists the polish ones, leaving custom services to the model page", () => {
  assert.deepEqual(
    vendorsFor(setup(), "native").map(({ id }) => id),
    ["gemini", "openai"],
  );
  assert.deepEqual(
    vendorsFor(setup(), "local").map(({ id }) => id),
    ["ollama"],
  );
  assert.deepEqual(vendorsFor(setup(), "private"), []);
});

test("the plan follows the current settings (clicks switch at once); a custom polish service is honestly custom", () => {
  assert.deepEqual(planOf(setup()), { mode: "native", native: "gemini", polish: "ollama" });
  assert.deepEqual(planOf(setup({ mode: "local", native: "openai", polish: "custom/qwen3:8b" })), {
    mode: "local",
    native: "openai",
    polish: "custom",
  });
});

test("on-device model: the one in the settings if downloaded, otherwise the one in this machine's presets", () => {
  assert.equal(localModelOf(setup({ privateTranscriber: INT8, installed: [INT8] }), "private"), INT8);
  // An Intel Mac's presets recommend the CPU build: the Q8 model in the settings isn't downloaded, so recommend that
  const intel = [{ mode: "private", settings: { privateTranscriber: INT8 } }];
  assert.equal(localModelOf(setup({ presets: intel }), "private"), INT8);
  // A transcribe + polish preset whose step one is in the cloud doesn't count
  const cloudFirst = [{ mode: "local", settings: { transcriber: CLOUD } }];
  assert.equal(localModelOf(setup({ presets: cloudFirst, transcriber: INT8 }), "local"), INT8);
  // Cloud transcription in the settings and no recommendation: the first in the catalog
  assert.equal(localModelOf(setup({ presets: [], transcriber: CLOUD }), "local"), QWEN);
  // The mode in use: the one in the settings, said honestly even if not downloaded, never swapped for the recommendation
  assert.equal(localModelOf(setup({ mode: "private", presets: intel }), "private"), QWEN);
  assert.equal(localModelOf(setup({ mode: "private", privateTranscriber: INT8 }), "private"), INT8);
});

test("whether there is a key: the provider the service holds goes by that key's state, others by whether one is stored", () => {
  assert.equal(hasKey(setup({ key: "ready" }), "native", "gemini"), true);
  assert.equal(hasKey(setup({ key: "checking" }), "native", "gemini"), true);
  // Stored but rejected: counts as none
  assert.equal(hasKey(setup({ key: "rejected", keys: { gemini: "stored" } }), "native", "gemini"), false);
  assert.equal(hasKey(setup({ keys: { openai: "env" } }), "native", "openai"), true);
  assert.equal(hasKey(setup(), "native", "openai"), false);
});

test("what is missing follows the main process: native only a key, transcribe + polish a download or a cloud key, private only a download", () => {
  const plan = (mode, extra = {}) => ({ mode, native: "gemini", polish: "ollama", ...extra });
  assert.deepEqual(needsOf(plan("native"), setup()), [{ kind: "key", vendor: "gemini" }]);
  assert.deepEqual(needsOf(plan("native"), setup({ key: "ready" })), []);
  assert.deepEqual(needsOf(plan("local"), setup()), [{ kind: "download", model: QWEN, downloading: false }]);
  assert.deepEqual(needsOf(plan("local"), setup({ transcriber: CLOUD })), [{ kind: "key", vendor: "openai" }]);
  // The provider in use has a stored key that failed: the main process only checks whether one exists, so it is added here
  assert.deepEqual(needsOf(plan("native"), setup({ key: "rejected" })), [{ kind: "key", vendor: "gemini" }]);
  // Setups from the model page count honestly: a cloud step one (with its key) needs no download, a custom service needs no key
  const cloud = setup({ mode: "local", provider: null, key: "ready", transcriber: CLOUD, keys: { openai: "stored" } });
  assert.deepEqual(needsOf(plan("local"), cloud), []);
  const custom = setup({
    mode: "local",
    provider: "custom",
    key: "ready",
    polish: "custom/qwen3:8b",
    customUrl: "http://127.0.0.1:8080/v1",
    installed: [QWEN],
  });
  assert.deepEqual(needsOf(planOf(custom), custom), []);
  assert.deepEqual(needsOf(plan("private"), setup({ downloading: [QWEN] })), [
    { kind: "download", model: QWEN, downloading: true },
  ]);
  assert.deepEqual(needsOf(plan("private"), setup({ installed: [QWEN] })), []);
});

test("within the mode in use: clicking again carries nothing; another provider carries only that, leaving a model-page step one alone", () => {
  const cloud = setup({ mode: "local", transcriber: CLOUD, polish: "custom/qwen3:8b" });
  assert.deepEqual(changesOf(planOf(cloud), cloud), {});
  assert.equal(inEffect(planOf(cloud), cloud), true);
  assert.deepEqual(changesOf({ ...planOf(cloud), polish: "ollama" }, cloud), { polish: "ollama" });
  const privateNow = setup({ mode: "private", privateTranscriber: INT8 });
  assert.deepEqual(changesOf(planOf(privateNow), privateNow), {});
});

test("settings carried when switching over: none for the provider already in the settings, so a chosen model isn't reset to the default", () => {
  const s = setup({ mode: "native", native: "openai/gpt-audio-mini", polish: "custom/qwen3:8b" });
  assert.deepEqual(changesOf({ mode: "native", native: "openai" }, s), {});
  assert.deepEqual(changesOf({ mode: "native", native: "gemini" }, s), { model: "gemini" });
  assert.deepEqual(changesOf({ mode: "local", polish: "custom" }, s), { transcriber: QWEN });
  assert.deepEqual(changesOf({ mode: "local", polish: "ollama" }, s), { transcriber: QWEN, polish: "ollama" });
  assert.deepEqual(changesOf({ mode: "private" }, s), { privateTranscriber: QWEN });
});

test("already this set (clicking again needs no switch): same mode and the same settings to carry", () => {
  const plan = { mode: "private", native: "gemini", polish: "ollama" };
  assert.equal(inEffect(plan, setup({ mode: "native", installed: [QWEN] })), false);
  assert.equal(inEffect(plan, setup({ mode: "private", installed: [QWEN] })), true);
  // A model not downloaded yet counts too: the settings already point at it
  assert.equal(inEffect(plan, setup({ mode: "private", privateTranscriber: INT8 })), true);
  assert.equal(inEffect({ ...plan, mode: "native", native: "openai" }, setup({ key: "ready" })), false);
  assert.equal(inEffect({ ...plan, mode: "native" }, setup()), true);
});

test("whether dictation works now: null with nothing missing; only a model downloading is progress; a missing key or unstarted download is a problem; a key verifying or model loading is progress", () => {
  assert.equal(readinessOf(setup({ key: "ready" })), null);
  // Stored but failed: comes with the reason, more precise than "missing key"
  assert.deepEqual(readinessOf(setup({ key: "rejected" })), {
    tone: "problem",
    needs: [{ kind: "key", vendor: "gemini" }],
    problem: "This key is invalid",
  });
  assert.deepEqual(readinessOf(setup()), { tone: "problem", needs: [{ kind: "key", vendor: "gemini" }] });
  assert.deepEqual(readinessOf(setup({ mode: "private", downloading: [QWEN] })), {
    tone: "progress",
    needs: [{ kind: "download", model: QWEN, downloading: true }],
  });
  const noAddress = setup({ mode: "local", downloading: [QWEN], polish: "custom/qwen3:8b" });
  assert.equal(readinessOf(noAddress).tone, "problem", "the custom service address is still missing");
  assert.equal(readinessOf(setup({ mode: "private" })).tone, "problem", "download not started");
  assert.deepEqual(readinessOf(setup({ key: "checking" })), { tone: "progress", needs: [] });
  const loading = setup({
    mode: "private",
    installed: [QWEN],
    provider: null,
    key: "ready",
    localModel: { state: "loading" },
  });
  assert.deepEqual(readinessOf(loading), { tone: "progress", needs: [] });
  const failed = { state: "failed", problem: "The on-device model failed to load" };
  assert.deepEqual(readinessOf(setup({ mode: "private", installed: [QWEN], key: "ready", localModel: failed })), {
    tone: "problem",
    needs: [],
    problem: "The on-device model failed to load",
  });
});
