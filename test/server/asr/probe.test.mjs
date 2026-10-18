import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { PROBE_SPEECH, speechSample } from "../../../src/server/asr/probe.mjs";

/** The kind of WAV text-to-speech writes: another chunk between fmt and data (say writes FLLR) */
function sayLikeWav(values, { rate = 16_000, channels = 1, bits = 16 } = {}) {
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * channels * (bits / 8), 16);
  fmt.writeUInt16LE(channels * (bits / 8), 20);
  fmt.writeUInt16LE(bits, 22);
  const filler = Buffer.alloc(8 + 6);
  filler.write("FLLR", 0, "ascii");
  filler.writeUInt32LE(6, 4);
  const data = Buffer.alloc(8 + values.length * 2);
  data.write("data", 0, "ascii");
  data.writeUInt32LE(values.length * 2, 4);
  for (const [i, value] of values.entries()) data.writeInt16LE(value, 8 + i * 2);
  const body = Buffer.concat([Buffer.from("WAVE", "ascii"), fmt, filler, data]);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/** Fake say: records each call's arguments and writes the wav to the -o path; with failVoice the call with -v fails (that voice isn't installed) */
function fakeSay(wav, { failVoice = false } = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push({ file, args });
    if (failVoice && args.includes("-v")) throw new Error("Voice `Samantha' not found.");
    writeFileSync(args[args.indexOf("-o") + 1], wav);
  };
  return { calls, run };
}

test("speaks the check sentence with text-to-speech and reads back 16 kHz mono samples, skipping extra chunks", async () => {
  const { calls, run } = fakeSay(sayLikeWav([0, 16384, -32768, 32767]));
  const { samples, said } = await speechSample("en", { run, platform: "darwin" });
  assert.equal(said, PROBE_SPEECH.en.text);
  assert.deepEqual(samples, new Float32Array([0, 16384 / 32767, -1, 1]));
  assert.equal(calls[0].file, "say");
  assert.deepEqual(calls[0].args.slice(0, 2), ["-v", PROBE_SPEECH.en.voice]);
  assert.ok(calls[0].args.includes("--data-format=LEI16@16000"));
  assert.equal(calls[0].args.at(-1), PROBE_SPEECH.en.text);
});

test("English is spoken for English and for any language without its own sentence", async () => {
  const { calls, run } = fakeSay(sayLikeWav([1, 2]));
  assert.equal((await speechSample("en", { run, platform: "darwin" })).said, PROBE_SPEECH.en.text);
  assert.equal((await speechSample("fr", { run, platform: "darwin" })).said, PROBE_SPEECH.en.text);
  assert.equal(calls[1].args[1], PROBE_SPEECH.en.voice);
});

test("if this computer lacks the voice, the system default voice speaks instead", async () => {
  const { calls, run } = fakeSay(sayLikeWav([1, 2, 3]), { failVoice: true });
  const { samples } = await speechSample("en", { run, platform: "darwin" });
  assert.equal(samples.length, 3);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.includes("-v"), false);
});

test("output that is not 16 kHz mono 16-bit is reported, never transcribed", async () => {
  await assert.rejects(
    speechSample("en", { ...fakeSay(sayLikeWav([1, 2], { rate: 22_050 })), platform: "darwin" }),
    /22050/,
  );
  await assert.rejects(
    speechSample("en", { ...fakeSay(sayLikeWav([1, 2], { channels: 2 })), platform: "darwin" }),
    /channels/,
  );
  await assert.rejects(speechSample("en", { ...fakeSay(Buffer.from("not a wav")), platform: "darwin" }), /WAV/);
});

test("Windows: the built-in synthesizer speaks; the sentence, output file, and language go through environment variables, and the samples read back the same", async () => {
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, env: options.env });
    writeFileSync(options.env.WHISPRFLOW_PROBE_FILE, sayLikeWav([0, 16384]));
  };
  const { samples, said } = await speechSample("en", { run, platform: "win32" });
  assert.equal(said, PROBE_SPEECH.en.text);
  assert.equal(samples.length, 2);
  const [{ file, args, env }] = calls;
  assert.equal(file, "powershell");
  assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  // No outside text is spliced into the script: the sentence lives only in the environment
  assert.ok(!args[3].includes(PROBE_SPEECH.en.text));
  assert.match(args[3], /SpeechAudioFormatInfo 16000/);
  assert.equal(env.WHISPRFLOW_PROBE_TEXT, PROBE_SPEECH.en.text);
  assert.equal(env.WHISPRFLOW_PROBE_CULTURE, "en-US");
});
