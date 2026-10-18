import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import { ModelError } from "../../../src/server/providers/errors.mjs";
import { createLocalRefiner } from "../../../src/server/refine/local.mjs";

const en = createTranslator("en");

function recordingLog() {
  const events = [];
  const record = (level) => (event, fields) => events.push({ level, event, ...fields });
  return { events, info: record("info"), warn: record("warn"), error: record("error") };
}

const SAMPLES = new Float32Array(32_000);

/** All three are fakes: decoding returns a fixed 2 s sample, transcription a fixed transcript, cleanup prefixes the transcript */
function parts({ transcript = "raw text", transcribeError = null, polishError = null } = {}) {
  const seen = { decoded: [], transcribed: [], polished: [] };
  return {
    seen,
    decode: async (audio, mimeType) => {
      seen.decoded.push({ audio, mimeType });
      return SAMPLES;
    },
    transcriber: {
      async transcribe(samples) {
        seen.transcribed.push(samples);
        if (transcribeError) throw transcribeError;
        return { text: transcript };
      },
    },
    polisher: {
      warmUps: 0,
      async warmUp() {
        this.warmUps++;
      },
      async polish(text, options) {
        seen.polished.push({ text, options });
        if (polishError) throw polishError;
        return `Final: ${text}`;
      },
    },
  };
}

test("recording, common format, local transcription, cleanup; the same interface as the native path", async () => {
  const log = recordingLog();
  const { seen, decode, transcriber, polisher } = parts();
  const refiner = createLocalRefiner({ transcriber, polisher, log, decode });
  const audio = Buffer.from("webm");
  const signal = new AbortController().signal;
  assert.equal(await refiner.refine(audio, { mimeType: "audio/webm", signal, audioId: "a1" }), "Final: raw text");
  assert.deepEqual(seen.decoded, [{ audio, mimeType: "audio/webm" }]);
  assert.equal(seen.transcribed[0], SAMPLES);
  assert.deepEqual(seen.polished, [{ text: "raw text", options: { signal, audioId: "a1" } }]);
  await refiner.prepare();
  await refiner.warmUp();
  assert.equal(polisher.warmUps, 1);
});

test("one log line per dictation: how long each step took and the transcript length, never the transcript or result", async () => {
  const log = recordingLog();
  const { decode, transcriber, polisher } = parts({ transcript: "one two three" });
  await createLocalRefiner({ transcriber, polisher, log, decode }).refine(Buffer.from("x"), {
    mimeType: "audio/webm",
    audioId: "a2",
  });
  const entry = log.events.find((e) => e.event === "local_refined");
  assert.equal(entry.audio_id, "a2");
  assert.equal(entry.seconds, 2);
  assert.equal(entry.transcript_length, "one two three".length);
  for (const field of ["decode_ms", "transcribe_ms", "polish_ms"]) assert.ok(Number.isInteger(entry[field]), field);
  assert.ok(!JSON.stringify(log.events).includes("one two three"));
});

test("local transcription error: a classified ModelError that names local transcription, with the original message in detail", async () => {
  const { decode, transcriber, polisher } = parts({
    transcribeError: new Error("Transcriber process exited (code 3)"),
  });
  const refiner = createLocalRefiner({ transcriber, polisher, log: recordingLog(), decode });
  const error = await refiner.refine(Buffer.from("x"), { mimeType: "audio/webm" }).catch((e) => e);
  assert.ok(error instanceof ModelError);
  assert.equal(error.kind, "other");
  assert.match(en.text(error.problem), /Local transcription/);
  assert.match(error.detail, /code 3/);
});

test("errors from cleanup pass through unchanged (already classified)", async () => {
  const failure = new ModelError({ kind: "key", problem: { key: "model.keyInvalid" }, detail: "401" });
  const { decode, transcriber, polisher } = parts({ polishError: failure });
  const refiner = createLocalRefiner({ transcriber, polisher, log: recordingLog(), decode });
  assert.equal(await refiner.refine(Buffer.from("x"), { mimeType: "audio/webm" }).catch((e) => e), failure);
});

test("an undecodable recording reports a ModelError instead of leaking the raw decoder error", async () => {
  const { transcriber, polisher } = parts();
  const decode = async () => {
    throw new Error("bad webm");
  };
  const refiner = createLocalRefiner({ transcriber, polisher, log: recordingLog(), decode });
  const error = await refiner.refine(Buffer.from("x"), { mimeType: "audio/webm" }).catch((e) => e);
  assert.ok(error instanceof ModelError);
  assert.match(error.detail, /bad webm/);
});

test("if the client disconnected by the time transcription finishes, cleanup is not paid for", async () => {
  const { seen, decode, transcriber, polisher } = parts();
  const abort = new AbortController();
  transcriber.transcribe = async () => {
    abort.abort();
    return { text: "raw text" };
  };
  const refiner = createLocalRefiner({ transcriber, polisher, log: recordingLog(), decode });
  await assert.rejects(refiner.refine(Buffer.from("x"), { mimeType: "audio/webm", signal: abort.signal }));
  assert.equal(seen.polished.length, 0);
});

test("the on-device transcription step is billed too: which model, how long, no cost; a failed record doesn't hold up the dictation", async () => {
  const { decode, transcriber, polisher } = parts();
  const calls = [];
  const refiner = createLocalRefiner({
    transcriber,
    polisher,
    log: recordingLog(),
    decode,
    model: "qwen3-asr-0.6b-q8",
    onCall: (call) => calls.push(call),
  });
  await refiner.refine(Buffer.from("webm"), { mimeType: "audio/webm", audioId: "a1" });
  assert.equal(calls.length, 1);
  const { latencyMs, createdAt, ...rest } = calls[0];
  assert.deepEqual(rest, {
    purpose: "dictation",
    audioId: "a1",
    provider: "local",
    model: "qwen3-asr-0.6b-q8",
    inputTokens: 0,
    audioTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    costUsd: 0,
  });
  assert.equal(typeof latencyMs, "number");
  assert.ok(Number.isFinite(Date.parse(createdAt)));

  const log = recordingLog();
  const broken = createLocalRefiner({
    transcriber,
    polisher,
    log,
    decode,
    model: "qwen3-asr-0.6b-q8",
    onCall: () => {
      throw new Error("Database is locked");
    },
  });
  assert.equal(await broken.refine(Buffer.from("webm"), { mimeType: "audio/webm", audioId: "a2" }), "Final: raw text");
  assert.ok(log.events.some(({ event }) => event === "model_call_not_recorded"));
});
