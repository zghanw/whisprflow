import assert from "node:assert/strict";
import { test } from "node:test";
import { findModel } from "../../../src/models/catalog.mjs";
import { startTranscriber } from "../../../src/server/asr/start.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const MODEL = findModel("qwen3-asr-0.6b-q8");

/** Fake model store: installed decides whether the model is there; any download request is recorded (there should be none) */
function fakeStore(installed) {
  const calls = [];
  return {
    calls,
    isInstalled: () => installed,
    dirOf: (model) => `/models/${model.id}`,
    async install(model) {
      calls.push(model.id);
    },
  };
}

const fakeSpawn = async (request) => ({ request });

test("a downloaded model loads in the transcriber process", async () => {
  const store = fakeStore(true);
  const { request } = await startTranscriber({ modelId: MODEL.id, log: quiet, store, spawn: fakeSpawn });
  assert.equal(request.model, MODEL);
  assert.equal(request.dir, `/models/${MODEL.id}`);
  assert.deepEqual(store.calls, []);
});

test("a model never downloaded is not fetched automatically: it is an error. The user decides on downloads (models/library.mjs)", async () => {
  const store = fakeStore(false);
  await assert.rejects(
    startTranscriber({ modelId: MODEL.id, log: quiet, store, spawn: fakeSpawn }),
    /not downloaded yet/,
  );
  assert.deepEqual(store.calls, []);
});

test("a model not in the catalog is an error", async () => {
  await assert.rejects(
    startTranscriber({ modelId: "nope", log: quiet, store: fakeStore(true), spawn: fakeSpawn }),
    /nope/,
  );
});

test("with automatic acceleration, a failed GPU load (an error, or a crashed transcriber process) loads again on the CPU and is logged", async () => {
  const tried = [];
  const warned = [];
  const spawn = async (request) => {
    tried.push(request.options?.backend);
    if (request.options?.backend !== "cpu")
      throw new Error("The transcriber process exited before loading the model (exit code 3221225477)");
    return { request };
  };
  const log = { ...quiet, warn: (event, fields) => warned.push([event, fields.model]) };
  const { request } = await startTranscriber({ modelId: MODEL.id, log, store: fakeStore(true), spawn });
  assert.deepEqual(tried, ["auto", "cpu"]);
  assert.equal(request.options.backend, "cpu");
  assert.deepEqual(warned, [["transcriber_gpu_failed", MODEL.id]]);
});

test("CPU only: the runtime is told to use the CPU from the start; a failed CPU load is reported with no further attempts", async () => {
  const tried = [];
  const spawn = async (request) => {
    tried.push(request.options?.backend);
    return { request };
  };
  await startTranscriber({ modelId: MODEL.id, log: quiet, store: fakeStore(true), spawn, acceleration: "cpu" });
  assert.deepEqual(tried, ["cpu"]);

  const failing = async () => {
    throw new Error("broken");
  };
  await assert.rejects(
    startTranscriber({ modelId: MODEL.id, log: quiet, store: fakeStore(true), spawn: failing, acceleration: "cpu" }),
    /broken/,
  );
});

test("a CPU-only runtime (sherpa-onnx) that fails to load is reported right away: trying the CPU again is the same thing", async () => {
  let attempts = 0;
  const spawn = async () => {
    attempts += 1;
    throw new Error("corrupt model file");
  };
  const sherpa = findModel("qwen3-asr-0.6b-int8");
  await assert.rejects(
    startTranscriber({ modelId: sherpa.id, log: quiet, store: fakeStore(true), spawn }),
    /corrupt model file/,
  );
  assert.equal(attempts, 1);
});
