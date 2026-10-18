import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeWav, downsample, encodeWav, mixDown, SPEECH_SAMPLE_RATE } from "../../../src/server/audio/pcm.mjs";

const sine = (frequency, sampleRate, seconds) =>
  Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, i) =>
    Math.sin((2 * Math.PI * frequency * i) / sampleRate),
  );

/** RMS after dropping both ends, where the filter isn't filled yet */
function rms(samples) {
  const middle = samples.subarray(200, samples.length - 200);
  let sum = 0;
  for (const value of middle) sum += value * value;
  return Math.sqrt(sum / middle.length);
}

test("WAV: the 44-byte header is right (mono, 16-bit, the given rate), followed by little-endian 16-bit samples", () => {
  const wav = encodeWav(Float32Array.from([0, 0.5, -0.5, 1, -1]), 16_000);
  assert.equal(wav.length, 44 + 5 * 2);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(wav.readUInt16LE(20), 1, "PCM");
  assert.equal(wav.readUInt16LE(22), 1, "mono");
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt32LE(28), 32_000, "bytes per second");
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), 10);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((i) => wav.readInt16LE(44 + i * 2)),
    [0, 16384, -16384, 32767, -32768],
  );
});

test("WAV: samples beyond +-1 are clipped, never wrapped to the opposite sign", () => {
  const wav = encodeWav(Float32Array.from([1.7, -3]), 16_000);
  assert.deepEqual([wav.readInt16LE(44), wav.readInt16LE(46)], [32767, -32768]);
});

test("multiple channels average into mono; a mono recording comes back as is", () => {
  const left = Float32Array.from([1, 0.5]);
  assert.equal(mixDown([left]), left);
  assert.deepEqual(Array.from(mixDown([left, Float32Array.from([0, -0.5])])), [0.5, 0]);
});

test("48 kHz to 16 kHz: a third of the length, with the speech band (1 kHz) at the same level", () => {
  const input = sine(1_000, 48_000, 0.5);
  const output = downsample(input, 48_000, 16_000);
  assert.equal(output.length, Math.ceil(input.length / 3));
  assert.ok(Math.abs(rms(output) / rms(input) - 1) < 0.01, `gain ${rms(output) / rms(input)}`);
});

test("sound above 8 kHz is filtered before downsampling so it doesn't fold back as noise", () => {
  // Unfiltered, 12 kHz would fold to 4 kHz, right in the speech band
  const input = sine(12_000, 48_000, 0.5);
  const output = downsample(input, 48_000, 16_000);
  assert.ok(rms(output) / rms(input) < 0.01, `residue ${rms(output) / rms(input)}`);
});

test("audio already at the rate comes back as is; non-integer factors are refused instead of quietly producing off-pitch audio", () => {
  const input = sine(440, 16_000, 0.1);
  assert.equal(downsample(input, 16_000, 16_000), input);
  assert.throws(() => downsample(sine(440, 44_100, 0.1), 44_100, 16_000), /44100/);
});

test("the common WAV format reads back to samples: the rate from the header, values off only by 16-bit quantization", () => {
  const samples = Float32Array.from([0, 0.5, -0.5, 1, -1, 0.123]);
  const decoded = decodeWav(encodeWav(samples, SPEECH_SAMPLE_RATE));
  assert.equal(decoded.sampleRate, 16_000);
  assert.equal(decoded.samples.length, samples.length);
  for (let i = 0; i < samples.length; i++) assert.ok(Math.abs(decoded.samples[i] - samples[i]) < 1e-4, `sample ${i}`);
});

test("a WAV not in the common format is not guessed at: it is an error saying what is wrong", () => {
  const wav = encodeWav(Float32Array.from([0, 0.5]), 16_000);
  assert.throws(() => decodeWav(Buffer.from("not a wav file at all, just some bytes here")), /Not a WAV/);
  const stereo = Buffer.from(wav);
  stereo.writeUInt16LE(2, 22);
  assert.throws(() => decodeWav(stereo), /channels/);
  const float = Buffer.from(wav);
  float.writeUInt16LE(3, 20);
  assert.throws(() => decodeWav(float), /PCM/);
  assert.throws(() => decodeWav(wav.subarray(0, wav.length - 1)), /length/);
});
