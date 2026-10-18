import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnTranscriber } from "../../../src/server/asr/host.mjs";

const FAKE_WORKER = fileURLToPath(new URL("../../fixtures/asr/fake-worker.mjs", import.meta.url));
const MODEL = { id: "fake-model" };

function recordingLog() {
  const events = [];
  const record = (level) => (event, fields) => events.push({ level, event, ...fields });
  return { events, info: record("info"), warn: record("warn"), error: record("error") };
}

const spawn = (extra = {}) =>
  spawnTranscriber({ model: MODEL, dir: "/models/fake", log: recordingLog(), workerPath: FAKE_WORKER, ...extra });

test("the model loads in a child process; samples go over as a Float32Array and text comes back; unusable after closing", async () => {
  const log = recordingLog();
  const transcriber = await spawn({ log });
  assert.equal(transcriber.backend, "fake");
  assert.deepEqual(await transcriber.transcribe(new Float32Array(16_000)), { text: "fake-model:16000" });
  assert.deepEqual(await transcriber.transcribe(new Float32Array(8)), { text: "fake-model:8" });
  assert.ok(log.events.some((e) => e.event === "transcriber_loaded" && e.backend === "fake"));
  transcriber.dispose();
  await assert.rejects(transcriber.transcribe(new Float32Array(8)), /closed/);
});

test("a model that will not load is an error naming the model", async () => {
  await assert.rejects(spawn({ options: { failLoad: true } }), /Couldn't load model fake-model: .*corrupt model file/s);
});

test("a runtime error loses only that transcription; the process lives on and the next one works", async () => {
  const transcriber = await spawn();
  await assert.rejects(transcriber.transcribe(new Float32Array(3)), /Local transcription failed: .*runtime error/s);
  assert.deepEqual(await transcriber.transcribe(new Float32Array(5)), { text: "fake-model:5" });
  transcriber.dispose();
});

test("a crashed child: that transcription fails and is logged; the next one restarts it and reloads the model", async () => {
  const log = recordingLog();
  const transcriber = await spawn({ log });
  await assert.rejects(transcriber.transcribe(new Float32Array(1)), /The transcriber process exited \(code 3/);
  assert.ok(log.events.some((e) => e.event === "transcriber_exited" && e.code === 3));
  assert.deepEqual(await transcriber.transcribe(new Float32Array(6)), { text: "fake-model:6" });
  assert.equal(log.events.filter((e) => e.event === "transcriber_loaded").length, 2);
  transcriber.dispose();
});

test("a hang with no reply: it times out, the child is ended, and the next one restarts it", async () => {
  const log = recordingLog();
  const transcriber = await spawn({ log, timeoutFor: () => 200 });
  await assert.rejects(transcriber.transcribe(new Float32Array(2)), /no reply/);
  assert.ok(log.events.some((e) => e.event === "transcriber_timeout"));
  assert.deepEqual(await transcriber.transcribe(new Float32Array(7)), { text: "fake-model:7" });
  transcriber.dispose();
});

test("closing is not logged as a crash", async () => {
  const log = recordingLog();
  const transcriber = await spawn({ log });
  transcriber.dispose();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(log.events.filter((e) => e.event === "transcriber_exited").length, 0);
});
