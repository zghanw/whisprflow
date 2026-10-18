import assert from "node:assert/strict";
import { test } from "node:test";
import { startService } from "../../src/app/service.mjs";
import { createTranslator } from "../../src/i18n/index.mjs";
import { ModelError } from "../../src/server/providers/errors.mjs";

const en = createTranslator("en");
/** The user-facing sentence in the error, as translated */
const said = (pattern) => (error) => pattern.test(en.text(error.problem ?? error.message));

const quietLog = { info() {}, warn() {}, error() {} };
const OGG_CHUNK = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60)]);

/** Sends a short "recording" over the dictation protocol and returns the last message from the server */
function dictateOnce(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const audioId = crypto.randomUUID();
    socket.onerror = () => reject(new Error("Can't reach the built-in service"));
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "start_audio", audio_id: audioId }));
      socket.send(
        JSON.stringify({ type: "set_audio_chunk_info", audio_id: audioId, index: 1, size: OGG_CHUNK.length }),
      );
      socket.send(OGG_CHUNK);
      socket.send(JSON.stringify({ type: "end_audio", audio_id: audioId }));
    };
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.K === "audio_processing_completed" || message.K === "audio_processing_error") {
        socket.close();
        resolve(message);
      }
    };
  });
}

const fakeRefiner = (text, warmUp = async () => {}) => ({ warmUp, refine: async () => text });

// Errors from the model layer arrive classified (src/server/providers/errors.mjs)
const UNAVAILABLE = () =>
  new ModelError({
    kind: "unavailable",
    problem: "Gemini is unavailable right now (The service is currently unavailable). Try again later",
    detail: "503",
  });
const OFFLINE = () =>
  new ModelError({ kind: "unavailable", problem: "Can't reach Gemini. Check your network", detail: "fetch failed" });
const INVALID = () =>
  new ModelError({
    kind: "key",
    problem: "This key is invalid. Check it was copied in full",
    detail: "API key not valid",
  });
const GEMINI = { mode: "native", model: { provider: "gemini", model: "gemini-3.5-flash" }, thinkingLevel: "LOW" };
const OPENAI = { mode: "native", model: { provider: "openai", model: "gpt-audio-mini" }, thinkingLevel: "LOW" };

test("without a key the service still listens; dictation fails and says to enter a key", async (t) => {
  const service = await startService({
    log: quietLog,
    route: GEMINI,
    createRefiner: () => fakeRefiner("should not be used"),
  });
  t.after(() => service.close());
  assert.equal(service.ready, false);
  const reply = await dictateOnce(service.url);
  assert.equal(reply.K, "audio_processing_error");
  assert.match(reply.V.detail, /API key/);
});

test("after switching to a key that passes verification, dictation works at the same address", async (t) => {
  const seen = [];
  const service = await startService({
    log: quietLog,
    route: GEMINI,
    createRefiner: (options) => {
      seen.push(options.apiKey);
      return fakeRefiner("Finished text");
    },
  });
  t.after(() => service.close());
  const urlBefore = service.url;
  await service.useKey("key-1");
  assert.equal(service.ready, true);
  assert.equal(service.url, urlBefore);
  assert.deepEqual(seen, ["key-1"]);
  const reply = await dictateOnce(service.url);
  assert.equal(reply.K, "audio_processing_completed");
  assert.equal(reply.V.refined_text, "Finished text");
});

test("a new key that fails verification is an error, and the working key stays in use", async (t) => {
  const service = await startService({
    log: quietLog,
    route: GEMINI,
    createRefiner: ({ apiKey }) =>
      apiKey === "good"
        ? fakeRefiner("using the good key")
        : fakeRefiner("using the bad key", async () => {
            throw INVALID();
          }),
  });
  t.after(() => service.close());
  await service.useKey("good");
  await assert.rejects(service.useKey("bad"), said(/invalid/));
  assert.equal(service.ready, true);
  assert.equal((await dictateOnce(service.url)).V.refined_text, "using the good key");
});

test("forgetKey returns to the no-key state", async (t) => {
  const service = await startService({ log: quietLog, route: GEMINI, createRefiner: () => fakeRefiner("text") });
  t.after(() => service.close());
  await service.useKey("key-1");
  service.forgetKey();
  assert.equal(service.ready, false);
  assert.equal((await dictateOnce(service.url)).K, "audio_processing_error");
});

test("at startup a key may be used before verification: also when Gemini answers 503, a good key is not judged unusable", async (t) => {
  const busy = async () => {
    throw UNAVAILABLE();
  };
  const service = await startService({ log: quietLog, route: GEMINI, createRefiner: () => fakeRefiner("text", busy) });
  t.after(() => service.close());
  const unverified = await service.useKey("stored-key", { allowUnverified: true });
  assert.equal(unverified.verified, false);
  assert.match(en.text(unverified.problem), /Gemini is unavailable right now/);
  assert.equal(service.ready, true);
});

test("at startup a key may be used before verification: unable to reach Gemini, the key is enabled anyway and reported as not yet verified", async (t) => {
  const offline = async () => {
    throw OFFLINE();
  };
  const service = await startService({
    log: quietLog,
    route: GEMINI,
    createRefiner: () => fakeRefiner("connected later", offline),
  });
  t.after(() => service.close());
  // Without that allowance (a key the user just entered), unreachable means not passed
  await assert.rejects(service.useKey("stored-key"), said(/Can't reach/));
  assert.equal(service.ready, false);

  const unverified = await service.useKey("stored-key", { allowUnverified: true });
  assert.equal(unverified.verified, false);
  assert.equal(en.text(unverified.problem), "Can't reach Gemini. Check your network");
  assert.equal(service.ready, true);
  assert.equal((await dictateOnce(service.url)).V.refined_text, "connected later");
});

test("the allowance only covers unreachable vendors: an invalid key is still refused", async (t) => {
  const invalid = async () => {
    throw INVALID();
  };
  const service = await startService({
    log: quietLog,
    route: GEMINI,
    createRefiner: () => fakeRefiner("should not be used", invalid),
  });
  t.after(() => service.close());
  await assert.rejects(service.useKey("bad", { allowUnverified: true }), said(/invalid/));
  assert.equal(service.ready, false);
});

test("passing verification is reported; verify checks the key in use again", async (t) => {
  let online = false;
  const warmUp = async () => {
    if (!online) throw OFFLINE();
  };
  const service = await startService({
    log: quietLog,
    route: GEMINI,
    createRefiner: () => fakeRefiner("text", warmUp),
  });
  t.after(() => service.close());
  await assert.rejects(service.verify(), said(/API key/));
  await service.useKey("k", { allowUnverified: true });
  await assert.rejects(service.verify(), said(/Can't reach/));
  online = true;
  await service.verify();
  assert.deepEqual(await service.useKey("k"), { verified: true });
});

test("the no-key hint names the vendor: with OpenAI chosen it says OpenAI", async (t) => {
  const service = await startService({
    log: quietLog,
    route: OPENAI,
    createRefiner: () => fakeRefiner("should not be used"),
  });
  t.after(() => service.close());
  assert.match(en.text((await dictateOnce(service.url)).V.problem), /No OpenAI API key yet/);
});

test("built from the route in settings; probe tries another route with another key without replacing the one in use; all share one billing callback", async (t) => {
  const built = [];
  const onModelCall = () => {};
  const service = await startService({
    log: quietLog,
    route: GEMINI,
    onModelCall,
    createRefiner: async (options) => {
      built.push(options);
      return fakeRefiner(`using ${options.route.model.provider}`, async () => {
        if (options.apiKey === "bad") throw INVALID();
      });
    },
  });
  t.after(() => service.close());
  await service.useKey("gemini-key");
  assert.deepEqual({ route: built[0].route, apiKey: built[0].apiKey }, { route: GEMINI, apiKey: "gemini-key" });

  const openai = { ...OPENAI, model: { provider: "openai", model: "gpt-audio-1.5" } };
  await service.probe({ route: openai, apiKey: "openai-key" });
  assert.deepEqual(built[1].route, openai);
  assert.deepEqual(
    built.map(({ onCall }) => onCall),
    [onModelCall, onModelCall],
  );
  await assert.rejects(service.probe({ route: openai, apiKey: "bad" }), said(/invalid/));
  assert.equal((await dictateOnce(service.url)).V.refined_text, "using gemini");
});

test("setRoute switches routes at once without verifying: the key in hand is dropped and the no-key hint follows; only a verified key makes it usable", async (t) => {
  const service = await startService({
    log: quietLog,
    route: GEMINI,
    createRefiner: async (options) =>
      fakeRefiner(`using ${options.route.model.provider}`, async () => {
        if (options.apiKey === "bad") throw INVALID();
      }),
  });
  t.after(() => service.close());
  await service.useKey("gemini-key");
  assert.equal((await dictateOnce(service.url)).V.refined_text, "using gemini");

  service.setRoute(OPENAI);
  assert.deepEqual(service.route, OPENAI);
  assert.equal(service.ready, false);
  assert.match(en.text((await dictateOnce(service.url)).V.problem), /No OpenAI API key yet/);

  await assert.rejects(service.useKey("bad"), said(/invalid/));
  assert.equal(service.ready, false);
  await service.useKey("openai-key");
  assert.equal((await dictateOnce(service.url)).V.refined_text, "using openai");
});

test("the route changing while a key is verified: that key was checked for the old route, so it is not installed and stale comes back; dictation says the new route lacks a key", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const service = await startService({
    log: quietLog,
    route: GEMINI,
    createRefiner: async (options) => fakeRefiner(`using ${options.route.model.provider}`, () => gate),
  });
  t.after(() => service.close());
  const verifying = service.useKey("gemini-key");
  service.setRoute(OPENAI);
  release();
  assert.deepEqual(await verifying, { verified: true, stale: true });
  assert.equal(service.ready, false);
  assert.match(en.text((await dictateOnce(service.url)).V.problem), /No OpenAI API key yet/);
});

test("preparing when speech starts goes to the refiner in use; without a key nothing happens", async (t) => {
  let prepared = 0;
  const service = await startService({
    log: quietLog,
    route: GEMINI,
    createRefiner: () => ({ ...fakeRefiner("text"), prepare: async () => void prepared++ }),
  });
  t.after(() => service.close());
  /** Opens a recording and waits for the server's audio_session_started */
  const startRecording = async () => {
    const socket = new WebSocket(service.url);
    await new Promise((resolve) => {
      socket.onopen = resolve;
    });
    socket.send(JSON.stringify({ type: "start_audio", audio_id: crypto.randomUUID() }));
    await new Promise((resolve) => {
      socket.onmessage = resolve;
    });
    socket.close();
  };
  await startRecording();
  assert.equal(prepared, 0);
  await service.useKey("gemini-key");
  await startRecording();
  assert.equal(prepared, 1);
});

const LOCAL = {
  mode: "local",
  transcriber: "qwen3-asr-0.6b-q8",
  polish: { vendor: "custom", model: "qwen3:8b" },
  customUrl: "http://127.0.0.1:8080/v1",
};

/** Fake local model: the test decides when it finishes loading, and counts unloads */
function fakeLocal() {
  const control = { started: [], accelerations: [], disposed: 0 };
  const startLocal = (options) =>
    new Promise((resolve, reject) => {
      control.started.push(options.modelId);
      control.accelerations.push(options.acceleration);
      control.finish = () =>
        resolve({
          backend: "fake",
          transcribe: async (samples) => ({ text: `transcribed ${samples.length}` }),
          dispose: () => control.disposed++,
        });
      control.fail = (error) => reject(error);
    });
  return { control, startLocal };
}

/** Fake model library: installed are the downloaded ones; downloads is progress in flight */
function fakeModels(installed = ["qwen3-asr-0.6b-q8", "qwen3-asr-0.6b-int8"]) {
  const models = {
    installed: new Set(installed),
    downloads: new Map(),
    isInstalled: (id) => models.installed.has(id),
    status: (id) => ({ download: models.downloads.get(id) ?? null }),
  };
  return models;
}

/** Fake refiner: uses the transcriber per the route, to expose the local model step's state */
const throughTranscriber = async ({ transcriber }) => ({
  warmUp: async () => {},
  refine: async () => (await transcriber.transcribe(new Float32Array(3))).text,
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A service on the local path, with fake local model and model library */
async function localService(
  t,
  { models = fakeModels(), onLocalModel, createRefiner = throughTranscriber, acceleration } = {},
) {
  const { control, startLocal } = fakeLocal();
  const service = await startService({
    log: quietLog,
    route: LOCAL,
    models,
    startLocal,
    createRefiner,
    onLocalModel,
    acceleration,
  });
  t.after(() => service.close());
  return { service, control, models };
}

test("local path: a downloaded model loads at startup; pressing the hotkey while loading says to wait; once loaded it works", async (t) => {
  let changes = 0;
  const { service, control } = await localService(t, { onLocalModel: () => changes++ });
  assert.deepEqual(control.started, ["qwen3-asr-0.6b-q8"]);
  assert.equal(service.localModel.state, "loading");
  await service.useKey("deepseek-key");
  assert.match(en.text((await dictateOnce(service.url)).V.problem), /loading/);

  control.finish();
  await tick();
  assert.equal(service.localModel.state, "ready");
  assert.equal((await dictateOnce(service.url)).V.refined_text, "transcribed 3");
  assert.ok(changes >= 2);
});

test("the acceleration setting goes to the model load; a change unloads and reloads (cancelling a load in progress), no change does nothing", async (t) => {
  const { service, control } = await localService(t, { acceleration: "cpu" });
  assert.deepEqual(control.accelerations, ["cpu"]);
  control.finish();
  await tick();
  assert.equal(service.localModel.state, "ready");

  service.setAcceleration("cpu");
  assert.deepEqual(control.accelerations, ["cpu"]);

  service.setAcceleration("auto");
  assert.equal(control.disposed, 1);
  assert.deepEqual(control.accelerations, ["cpu", "auto"]);
  assert.equal(service.localModel.state, "loading");
  control.finish();
  await tick();
  assert.equal(service.localModel.state, "ready");
});

test("a model not downloaded yet is never fetched automatically, it stays missing; pressing the hotkey says where to download it", async (t) => {
  const { service, control } = await localService(t, { models: fakeModels([]) });
  assert.deepEqual(control.started, []);
  assert.deepEqual(service.localModel, { state: "missing", model: "qwen3-asr-0.6b-q8" });
  await service.useKey("deepseek-key");
  const problem = en.text((await dictateOnce(service.url)).V.problem);
  assert.match(
    problem,
    /Qwen3-ASR 0\.6B \(Q8_0\) isn't downloaded.*whisprflow transcriber download qwen3-asr-0\.6b-q8/,
  );
});

test("while the user downloads it: the state carries progress, the hotkey says how far, and it loads as soon as it is done", async (t) => {
  const models = fakeModels([]);
  const { service, control } = await localService(t, { models });
  await service.useKey("deepseek-key");
  models.downloads.set("qwen3-asr-0.6b-q8", { received: 50, total: 100 });
  service.modelsChanged();
  assert.deepEqual(service.localModel, { state: "missing", model: "qwen3-asr-0.6b-q8", received: 50, total: 100 });
  assert.match(en.text((await dictateOnce(service.url)).V.problem), /downloading \(50%\)/);

  models.downloads.delete("qwen3-asr-0.6b-q8");
  models.installed.add("qwen3-asr-0.6b-q8");
  service.modelsChanged();
  assert.deepEqual(control.started, ["qwen3-asr-0.6b-q8"]);
  control.finish();
  await tick();
  assert.equal(service.localModel.state, "ready");
  // Already loaded: later library changes (downloading another model) don't reload it
  service.modelsChanged();
  assert.equal(control.started.length, 1);
});

test("a local model that failed to load: the state is failed with the reason, and the hotkey says that reason", async (t) => {
  const { service, control } = await localService(t);
  await service.useKey("deepseek-key");
  control.fail(new Error("the transcriber process would not start"));
  await tick();
  assert.equal(service.localModel.state, "failed");
  assert.match(en.text(service.localModel.problem), /couldn't be set up: the transcriber process would not start/);
  assert.match(en.text((await dictateOnce(service.url)).V.problem), /couldn't be set up/);
});

test("switching to the native path unloads the local model and frees its memory; switching back loads it again", async (t) => {
  const { service, control } = await localService(t);
  control.finish();
  await tick();
  assert.equal(service.localModel.state, "ready");

  service.setRoute(GEMINI);
  assert.equal(control.disposed, 1);
  assert.deepEqual(service.localModel, { state: "off" });

  service.setRoute(LOCAL);
  assert.deepEqual(control.started, ["qwen3-asr-0.6b-q8", "qwen3-asr-0.6b-q8"]);
});

test("changing the key or the cleanup vendor leaves the local model alone; only changing the local model reloads", async (t) => {
  const { service, control } = await localService(t);
  await service.useKey("key-1");
  service.setRoute({ ...LOCAL, polish: { vendor: "custom", model: "m" }, customUrl: "http://x/v1" });
  await service.useKey("key-2");
  assert.deepEqual(control.started, ["qwen3-asr-0.6b-q8"]);

  service.setRoute({ ...LOCAL, transcriber: "qwen3-asr-0.6b-int8" });
  assert.deepEqual(control.started, ["qwen3-asr-0.6b-q8", "qwen3-asr-0.6b-int8"]);
  assert.equal(service.localModel.model, "qwen3-asr-0.6b-int8");
});

test("changing local step one alone only changes the local model, without re-verifying the cleanup vendor or touching the key; outside local mode it is refused", async (t) => {
  let built = 0;
  const createRefiner = async (options) => {
    built++;
    return throughTranscriber(options);
  };
  const { service, control } = await localService(t, { createRefiner });
  await service.useKey("ds-key");
  assert.equal(built, 1);

  service.switchTranscriber("qwen3-asr-0.6b-int8");
  assert.equal(built, 1);
  assert.equal(service.ready, true);
  assert.equal(service.route.transcriber, "qwen3-asr-0.6b-int8");
  assert.deepEqual(service.route.polish, LOCAL.polish);
  assert.deepEqual(control.started, ["qwen3-asr-0.6b-q8", "qwen3-asr-0.6b-int8"]);

  const native = await startService({ log: quietLog, route: GEMINI, createRefiner: async () => fakeRefiner("x") });
  t.after(() => native.close());
  assert.throws(() => native.switchTranscriber("qwen3-asr-0.6b-int8"), /local/);
});

test("choosing the same model again after a failed load reloads it (the way to retry); once loaded, choosing it again does not reload", async (t) => {
  const { service, control } = await localService(t);
  control.fail(new Error("the transcriber process would not start"));
  await tick();
  assert.equal(service.localModel.state, "failed");

  service.switchTranscriber("qwen3-asr-0.6b-q8");
  assert.deepEqual(control.started, ["qwen3-asr-0.6b-q8", "qwen3-asr-0.6b-q8"]);
  control.finish();
  await tick();
  assert.equal(service.localModel.state, "ready");
  service.switchTranscriber("qwen3-asr-0.6b-q8");
  assert.equal(control.started.length, 2);
});

// ---------- Checking on-device models ----------

test("checking the on-device model in use transcribes with it directly once loaded, without loading another copy", async (t) => {
  const { service, control } = await localService(t);
  control.finish();
  await tick();
  const result = await service.checkTranscriber("qwen3-asr-0.6b-q8", new Float32Array(7));
  assert.equal(result.text, "transcribed 7");
  assert.equal(result.loadMs, null);
  assert.equal(result.backend, "fake");
  assert.equal(typeof result.transcribeMs, "number");
  assert.deepEqual(control.started, ["qwen3-asr-0.6b-q8"]);
  assert.equal(control.disposed, 0);
});

test("checking the one still loading waits for it to load, without loading another copy", async (t) => {
  const { service, control } = await localService(t);
  const pending = service.checkTranscriber("qwen3-asr-0.6b-q8", new Float32Array(2));
  control.finish();
  assert.equal((await pending).text, "transcribed 2");
  assert.deepEqual(control.started, ["qwen3-asr-0.6b-q8"]);
});

test("checking an on-device model not in use loads a temporary one and unloads it afterwards; the one in use is untouched", async (t) => {
  const { service, control } = await localService(t);
  control.finish();
  await tick();
  const pending = service.checkTranscriber("qwen3-asr-0.6b-int8", new Float32Array(5));
  control.finish();
  const result = await pending;
  assert.equal(result.text, "transcribed 5");
  assert.equal(typeof result.loadMs, "number");
  assert.deepEqual(control.started, ["qwen3-asr-0.6b-q8", "qwen3-asr-0.6b-int8"]);
  assert.equal(control.disposed, 1);
  assert.equal(service.localModel.state, "ready");
  assert.equal(service.localModel.model, "qwen3-asr-0.6b-q8");
});

test("a check that fails to load reports it honestly; the one in use is untouched", async (t) => {
  const { service, control } = await localService(t);
  control.finish();
  await tick();
  const pending = service.checkTranscriber("qwen3-asr-0.6b-int8", new Float32Array(5));
  control.fail(new Error("corrupt model file"));
  await assert.rejects(pending, /corrupt model file/);
  assert.equal(service.localModel.state, "ready");
});
