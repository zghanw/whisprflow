import assert from "node:assert/strict";
import { test } from "node:test";
import { windowed } from "../../../src/server/asr/engines/index.mjs";
import { FAMILIES as SHERPA } from "../../../src/server/asr/engines/sherpa-onnx.mjs";

const RATE = 16_000;
const tone = (seconds) => Float32Array.from({ length: seconds * RATE }, (_, i) => 0.3 * Math.sin(i / 5));
const concat = (...parts) => {
  const all = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  return all;
};

/** Fake transcriber: records the length of each piece and answers "one", "two", ... in order */
function fake() {
  const calls = [];
  return {
    calls,
    backend: "cpu",
    dispose() {},
    async transcribe(samples) {
      calls.push(samples.length / RATE);
      return { text: ["one", "two", "three", "four", "five"][calls.length - 1] };
    },
  };
}

test("one interface: long recordings are split at the limit and the texts joined in order; backend and dispose pass through", async () => {
  const inner = fake();
  const outer = windowed(inner, 20);
  const { text } = await outer.transcribe(concat(tone(15), new Float32Array(RATE), tone(15)));
  assert.equal(text, "one two");
  assert.equal(inner.calls.length, 2);
  for (const seconds of inner.calls) assert.ok(seconds <= 20);
  assert.equal(outer.backend, "cpu");
  assert.equal(outer.dispose, inner.dispose);
});

test("one interface: a fully silent recording never reaches the model and gives empty text, with or without a limit", async () => {
  const inner = fake();
  assert.deepEqual(await windowed(inner, null).transcribe(new Float32Array(8 * RATE)), { text: "" });
  assert.deepEqual(inner.calls, []);
  assert.deepEqual(await windowed(inner, null).transcribe(tone(3)), { text: "one" });
});

test("Qwen3 on sherpa-onnx: the None it outputs for no speech becomes empty, real text is unchanged", () => {
  const { clean } = SHERPA["qwen3-asr"];
  assert.equal(clean("None"), "");
  assert.equal(clean("Sounds good, let us do it."), "Sounds good, let us do it.");
});

test("transcribe.cpp: on a GPU, a synthesized sound warms it up right after loading; on the CPU it does not", async () => {
  const { load } = await import("../../../src/server/asr/engines/transcribe-cpp.mjs");
  const fakeRuntime = (backend, runs) => async () => ({
    TranscribeModel: {
      load: async () => ({
        backend,
        createSession: () => ({
          run: async (samples) => {
            runs.push(samples.length);
            return { text: "" };
          },
          dispose() {},
        }),
        dispose() {},
      }),
    },
  });
  const request = { model: { family: "qwen3-asr" }, file: () => "model.gguf" };

  const gpuRuns = [];
  const gpu = await load(request, { runtime: fakeRuntime("Vulkan0", gpuRuns) });
  assert.equal(gpu.backend, "Vulkan0");
  assert.deepEqual(gpuRuns, [16_000 * 1.5]);
  assert.equal(typeof gpu.warmupMs, "number");

  const cpuRuns = [];
  const cpu = await load(request, { runtime: fakeRuntime("CPU", cpuRuns) });
  assert.deepEqual(cpuRuns, []);
  assert.equal(cpu.warmupMs, null);
});
