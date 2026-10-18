import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createModeSwitch } from "../../src/app/modes.mjs";
import { createTranslator, msg } from "../../src/i18n/index.mjs";
import { resolveSettings, routeOf, saveSetting } from "../../src/storage/settings.mjs";

const en = createTranslator("en");

let dir;
let file;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "whisprflow-modes-"));
  file = join(dir, "settings.json");
  // These start from native, so every switch below is a real change (a fresh install starts in local)
  saveSetting(file, "mode", "native");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const saved = (name) => resolveSettings({ file, env: {} })[name].value;

/**
 * Fake service and key manager: keys.switchRoute switches to the route at once (like the real one, without verifying); verdict only simulates when switching is impossible
 * (connected to a separately started server). calls records what the core did to them
 */
function setup({
  verdict = () => ({ ok: true }),
  env = {},
  installed = ["qwen3-asr-0.6b-q8", "qwen3-asr-0.6b-int8"],
  transcribe = async () => ({
    text: "The meeting is at three this afternoon.",
    transcribeMs: 300,
    loadMs: null,
    backend: "metal",
  }),
  speech = async (locale) => ({ samples: new Float32Array(16), said: `spoke ${locale}` }),
} = {}) {
  const calls = [];
  const models = {
    installed: new Set(installed),
    isInstalled: (id) => models.installed.has(id),
    remove(id) {
      calls.push({ remove: id });
      models.installed.delete(id);
      return { ok: true };
    },
  };
  const service = {
    route: routeOf(resolveSettings({ file, env })),
    switchTranscriber(model) {
      calls.push({ switchTranscriber: model });
      service.route = { ...service.route, transcriber: model };
    },
  };
  service.checkTranscriber = async (model, samples) => {
    calls.push({ checkTranscriber: model, samples: samples.length });
    return transcribe(model, samples);
  };
  const keys = {
    switchRoute(route) {
      calls.push({ switchRoute: route });
      const result = verdict(route);
      if (!result.ok) return result;
      service.route = route;
      return { ok: true, settled: keys.settled };
    },
    /** When the key lookup and check settle: at once by default */
    settled: Promise.resolve(),
    async check(route) {
      calls.push({ check: route });
      return { ok: true, source: "stored", ms: 5 };
    },
  };
  const log = { info() {}, warn() {} };
  const modes = createModeSwitch({ service, keys, models, settingsFile: file, env, log, speech });
  return { modes, service, calls, models, keys };
}

// ---------- The mode layer ----------

test("switching modes builds the route from that mode's own settings, switches at once, and saves it", async () => {
  saveSetting(file, "polish", "ollama/llama3.2:3b");
  const { modes, service, calls } = setup();
  assert.deepEqual(await modes.switchMode("local"), { ok: true });
  assert.deepEqual(calls, [
    {
      switchRoute: {
        mode: "local",
        transcriber: "qwen3-asr-0.6b-q8",
        polish: { vendor: "ollama", model: "llama3.2:3b" },
        customUrl: null,
      },
    },
  ]);
  assert.equal(service.route.mode, "local");
  assert.equal(saved("mode"), "local");
});

test("once switched, settings are saved before the key lookup and check settle: if the UI asks meanwhile, mode and settings agree", async () => {
  const { modes, service, keys } = setup();
  let release;
  keys.settled = new Promise((resolve) => {
    release = resolve;
  });
  const switching = modes.switchMode("private");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.route.mode, "private");
  assert.equal(saved("mode"), "private");
  let done = false;
  switching.then(() => {
    done = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false, "answers only once the key has a verdict");
  release();
  assert.deepEqual(await switching, { ok: true });
});

test("when the key manager can not switch (a separately started server), nothing changes and the reason comes back", async () => {
  const problem = msg("key.externalModel");
  const { modes, service } = setup({ verdict: () => ({ ok: false, problem }) });
  const result = await modes.switchMode("local");
  assert.equal(result.ok, false);
  assert.match(en.text(result.problem), /separately started server/);
  assert.equal(service.route.mode, "native");
  assert.equal(saved("mode"), "native");
});

test("switching to the mode in use needs no verification; a misspelled mode lists the choices", async () => {
  const { modes, calls } = setup();
  assert.deepEqual(await modes.switchMode("native"), { ok: true });
  assert.deepEqual(calls, []);
  const wrong = await modes.switchMode("cloud");
  assert.equal(wrong.ok, false);
  assert.match(en.text(wrong.problem), /native \/ local/);
});

// ---------- The native layer ----------

test("native model change: switched at once in native mode; only model is written, local settings untouched", async () => {
  const { modes, service } = setup();
  assert.deepEqual(await modes.setModel("openai"), { ok: true });
  assert.deepEqual(service.route.model, { provider: "openai", model: "gpt-audio-mini" });
  assert.equal(saved("model"), "openai/gpt-audio-mini");
  assert.equal(saved("polish"), "ollama/qwen3:4b-instruct");
});

test("a native model change while in local mode: not switched or saved, it says to switch to native first", async () => {
  saveSetting(file, "mode", "local");
  const { modes, service, calls } = setup();
  const result = await modes.setModel("openai/gpt-audio-1.5");
  assert.equal(result.ok, false);
  assert.match(en.text(result.problem), /in local mode.*native mode/);
  assert.deepEqual(calls, []);
  assert.equal(service.route.mode, "local");
  assert.equal(saved("model"), "gemini/gemini-3.6-flash");
});

test("native only takes audio vendors: cleanup vendors and misspelled names are refused", async () => {
  const { modes, calls } = setup();
  const result = await modes.setModel("deepseek/deepseek-flash");
  assert.equal(result.ok, false);
  assert.match(en.text(result.problem), /gemini \/ openai/);
  assert.deepEqual(calls, []);
  assert.equal(saved("model"), "gemini/gemini-3.6-flash");
});

// ---------- Local's two steps ----------

test("local step one changes the on-device model: no key check, the service just changes models (loaded in the background)", async () => {
  saveSetting(file, "mode", "local");
  const { modes, calls } = setup();
  assert.deepEqual(await modes.setTranscriber("qwen3-asr-0.6b-int8"), { ok: true });
  assert.deepEqual(calls, [{ switchTranscriber: "qwen3-asr-0.6b-int8" }]);
  assert.equal(saved("transcriber"), "qwen3-asr-0.6b-int8");
});

test("local step two changes the cleanup: switched at once; a custom service changes and saves its address with it", async () => {
  saveSetting(file, "mode", "local");
  const { modes, service } = setup();
  const result = await modes.setPolish("custom/qwen3:8b", { customUrl: "http://127.0.0.1:11434/v1/chat/completions" });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(service.route.polish, { vendor: "custom", model: "qwen3:8b" });
  assert.equal(service.route.customUrl, "http://127.0.0.1:11434/v1");
  assert.equal(saved("polish"), "custom/qwen3:8b");
  assert.equal(saved("customUrl"), "http://127.0.0.1:11434/v1");
});

test("when local step two can not switch (a separately started server), neither cleanup nor address is saved", async () => {
  saveSetting(file, "mode", "local");
  const { modes } = setup({ verdict: () => ({ ok: false, problem: msg("key.externalModel") }) });
  const result = await modes.setPolish("custom/m", { customUrl: "http://x.example/v1" });
  assert.equal(result.ok, false);
  assert.equal(saved("polish"), "ollama/qwen3:4b-instruct");
  assert.equal(saved("customUrl"), "");
});

test("local's two steps in native mode can not change (they are not selectable): no check, no save, it says to switch to local", async () => {
  const { modes, calls } = setup();
  const first = await modes.setTranscriber("qwen3-asr-0.6b-int8");
  assert.equal(first.ok, false);
  assert.match(en.text(first.problem), /on-device transcription model \(step 1\).*local mode/);
  const second = await modes.setPolish("ollama/llama3.2:3b");
  assert.match(en.text(second.problem), /polishing model \(step 2\).*local mode/);
  assert.deepEqual(calls, []);
  assert.equal(saved("transcriber"), "qwen3-asr-0.6b-q8");
  assert.equal(saved("polish"), "ollama/qwen3:4b-instruct");
});

test("each local step takes only its own kind: step one refuses cloud audio models, step two refuses audio vendors", async () => {
  saveSetting(file, "mode", "local");
  const { modes } = setup();
  assert.match(en.text((await modes.setTranscriber("gemini")).problem), /qwen3-asr-0\.6b-q8/);
  assert.match(en.text((await modes.setPolish("openai/gpt-audio-mini")).problem), /ollama/);
});

test("switching modes can carry that mode's own settings, switched and saved together (straight to a custom service)", async () => {
  const { modes, service } = setup();
  const result = await modes.switchMode("local", { polish: "custom/qwen3:8b", customUrl: "http://127.0.0.1:11434/v1" });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(service.route.polish, { vendor: "custom", model: "qwen3:8b" });
  assert.deepEqual(
    [saved("mode"), saved("polish"), saved("customUrl")],
    ["local", "custom/qwen3:8b", "http://127.0.0.1:11434/v1"],
  );
});

test("settings carried with a switch that belong to another mode: no switch, and it says why", async () => {
  const { modes, calls } = setup();
  const result = await modes.switchMode("local", { model: "openai" });
  assert.equal(result.ok, false);
  assert.match(en.text(result.problem), /model isn't a local setting.*transcriber/);
  assert.deepEqual(calls, []);
});

test("carrying settings but unable to switch (a separately started server): neither the mode nor those settings are saved", async () => {
  const { modes, service } = setup({ verdict: () => ({ ok: false, problem: msg("key.externalModel") }) });
  const result = await modes.switchMode("local", { polish: "custom/m", customUrl: "http://x.example/v1" });
  assert.equal(result.ok, false);
  assert.equal(service.route.mode, "native");
  assert.deepEqual([saved("mode"), saved("polish")], ["native", "ollama/qwen3:4b-instruct"]);
});

test("already in local, switching to local with a step-one model switches it (the same route does nothing)", async () => {
  saveSetting(file, "mode", "local");
  const { modes, service, calls } = setup();
  assert.deepEqual(await modes.switchMode("local"), { ok: true });
  assert.deepEqual(calls, []);
  assert.deepEqual(await modes.switchMode("local", { transcriber: "qwen3-asr-0.6b-int8" }), { ok: true });
  assert.equal(service.route.transcriber, "qwen3-asr-0.6b-int8");
});

// ---------- On-device model not downloaded: never blocking ----------

test("switching to local with the on-device model not downloaded still switches and saves; downloading is the user's call (the service waits and loads it once downloaded)", async () => {
  const { modes, service, calls } = setup({ installed: [] });
  assert.deepEqual(await modes.switchMode("local"), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(service.route.mode, "local");
  assert.equal(saved("mode"), "local");
});

test("changing to an undownloaded on-device model in local still changes and saves it, and only tells the service to change models", async () => {
  saveSetting(file, "mode", "local");
  const { modes, calls } = setup({ installed: ["qwen3-asr-0.6b-q8"] });
  assert.deepEqual(await modes.setTranscriber("qwen3-asr-0.6b-int8"), { ok: true });
  assert.deepEqual(calls, [{ switchTranscriber: "qwen3-asr-0.6b-int8" }]);
  assert.equal(saved("transcriber"), "qwen3-asr-0.6b-int8");
});

test("deleting an on-device model: the one in use is refused with a hint to switch first; others are deleted (one only remembered by settings in native mode counts as unused)", async () => {
  saveSetting(file, "mode", "local");
  const { modes, calls } = setup();
  const refused = await modes.removeModel("qwen3-asr-0.6b-q8");
  assert.equal(refused.ok, false);
  assert.match(en.text(refused.problem), /Qwen3-ASR 0\.6B \(Q8_0\) is in use and can't be deleted/);
  assert.deepEqual(await modes.removeModel("qwen3-asr-0.6b-int8"), { ok: true });
  assert.deepEqual(calls, [{ remove: "qwen3-asr-0.6b-int8" }]);

  saveSetting(file, "mode", "native");
  const native = setup();
  assert.deepEqual(await native.modes.removeModel("qwen3-asr-0.6b-q8"), { ok: true });
  assert.equal((await native.modes.removeModel("nope")).ok, false);
});

// ---------- Saving settings ----------

test("a saved setting overridden by an environment variable still switches, with a note that the next launch uses the variable", async () => {
  const { modes } = setup({ env: { WHISPRFLOW_MODEL: "gemini" } });
  const result = await modes.setModel("openai");
  assert.equal(result.ok, true);
  assert.match(en.text(result.note), /WHISPRFLOW_MODEL/);
});

// ---------- The route used for verification ----------

test("which route verifies a key before saving it: audio vendors use native, cleanup vendors use local; the model to switch to can come along", () => {
  saveSetting(file, "model", "openai/gpt-audio-1.5");
  const { modes } = setup();
  assert.deepEqual(modes.routeForVendor("openai").model, { provider: "openai", model: "gpt-audio-1.5" });
  assert.deepEqual(modes.routeForVendor("gemini").model, { provider: "gemini", model: "gemini-3.6-flash" });
  assert.deepEqual(modes.routeForVendor("ollama").polish, { vendor: "ollama", model: "qwen3:4b-instruct" });
  const custom = modes.routeForVendor("custom", { polish: "custom/m", customUrl: "http://x.example/v1" });
  assert.deepEqual([custom.mode, custom.polish.model, custom.customUrl], ["local", "m", "http://x.example/v1"]);
  // The custom service has no default model
  assert.throws(
    () => modes.routeForVendor("custom"),
    (error) => /custom\/<model name>/.test(en.text(error.problem)),
  );
});

test("check builds the route for that layer and hands it to the key manager to try, without replacing the route in use", async () => {
  const { modes, calls } = setup();
  assert.equal((await modes.check("local", { polish: "ollama/llama3.2:3b" })).ok, true);
  assert.deepEqual(calls[0].check.polish, { vendor: "ollama", model: "llama3.2:3b" });
  assert.equal((await modes.check("native", {})).ok, true);
  assert.deepEqual(calls[1].check.model, { provider: "gemini", model: "gemini-3.6-flash" });
  const wrong = await modes.check("native", { model: "nobody/x" });
  assert.deepEqual([wrong.ok, wrong.cause], [false, "other"]);
});

// ---------- Checking an on-device model ----------

test("checking an on-device model speaks a sentence in the UI language and says what was spoken and transcribed; works in any mode", async () => {
  const { modes, calls } = setup();
  const result = await modes.checkTranscriber("qwen3-asr-0.6b-int8", { locale: "en" });
  assert.deepEqual(result, {
    ok: true,
    said: "spoke en",
    text: "The meeting is at three this afternoon.",
    transcribeMs: 300,
    loadMs: null,
    backend: "metal",
  });
  assert.deepEqual(calls, [{ checkTranscriber: "qwen3-asr-0.6b-int8", samples: 16 }]);
});

test("checking an unknown or undownloaded model transcribes nothing and says to download first", async () => {
  const { modes, calls } = setup({ installed: ["qwen3-asr-0.6b-q8"] });
  assert.match(en.text((await modes.checkTranscriber("nope", { locale: "en" })).problem), /no model called nope/);
  const missing = await modes.checkTranscriber("qwen3-asr-0.6b-int8", { locale: "en" });
  assert.equal(missing.ok, false);
  assert.match(en.text(missing.problem), /Qwen3-ASR 0\.6B \(int8\) isn't downloaded yet/);
  assert.deepEqual(calls, []);
});

test("checking: failing to speak, a transcription error, and no words at all each say their own thing", async () => {
  const noVoice = setup({
    speech: async () => {
      throw new Error("say: command not found");
    },
  });
  const spoken = await noVoice.modes.checkTranscriber("qwen3-asr-0.6b-q8", { locale: "en" });
  assert.equal(spoken.ok, false);
  assert.match(en.text(spoken.problem), /Couldn't speak.*say: command not found/);

  const broken = setup({
    transcribe: async () => {
      throw new Error("the transcriber process exited");
    },
  });
  const failed = await broken.modes.checkTranscriber("qwen3-asr-0.6b-q8", { locale: "en" });
  assert.match(
    en.text(failed.problem),
    /Qwen3-ASR 0\.6B \(Q8_0\) failed to transcribe: the transcriber process exited/,
  );

  const silent = setup({ transcribe: async () => ({ text: "  ", transcribeMs: 1, loadMs: 9, backend: "cpu" }) });
  const empty = await silent.modes.checkTranscriber("qwen3-asr-0.6b-q8", { locale: "en" });
  assert.match(en.text(empty.problem), /didn't transcribe a single word/);
});
