import assert from "node:assert/strict";
import { test } from "node:test";
import { isSilent, joinTexts, planWindows, splitPoints } from "../../../src/server/asr/segment.mjs";

const RATE = 16_000;
/** A "recording": speech (a 440 Hz tone) alternating with pauses (silence), in seconds */
function speech(pattern) {
  const parts = pattern.map(([kind, seconds]) =>
    Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) =>
      kind === "talk" ? 0.3 * Math.sin((2 * Math.PI * 440 * i) / RATE) : 0,
    ),
  );
  const all = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  return all;
}

test("splitting: a recording within the limit is one piece", () => {
  assert.deepEqual(splitPoints(speech([["talk", 12]]), RATE, 20), [[0, 12 * RATE]]);
});

test("splitting: a long recording is cut in pauses, every piece within the limit, back to back without losing a sample", () => {
  // 9 s talk, 0.6 s pause, 9 s talk, 0.6 s pause, 9 s talk, 0.6 s pause, 9 s talk = about 37.8 s
  const samples = speech([
    ["talk", 9],
    ["quiet", 0.6],
    ["talk", 9],
    ["quiet", 0.6],
    ["talk", 9],
    ["quiet", 0.6],
    ["talk", 9],
  ]);
  const segments = splitPoints(samples, RATE, 20);
  assert.ok(segments.length >= 2);
  assert.equal(segments[0][0], 0);
  assert.equal(segments.at(-1)[1], samples.length);
  for (let i = 1; i < segments.length; i++) assert.equal(segments[i][0], segments[i - 1][1], "back to back");
  for (const [start, end] of segments) assert.ok(end - start <= 20 * RATE, `${(end - start) / RATE} s`);
  // Every split point lands in a pause
  const quiet = [
    [9, 9.6],
    [18.6, 19.2],
    [28.2, 28.8],
  ].map(([a, b]) => [a * RATE, b * RATE]);
  for (const [, end] of segments.slice(0, -1)) {
    assert.ok(
      quiet.some(([a, b]) => end >= a && end <= b),
      `split at ${end / RATE} s`,
    );
  }
});

test("splitting: nonstop speech with no pauses is still cut at the limit, never one overlong piece", () => {
  const segments = splitPoints(speech([["talk", 50]]), RATE, 20);
  assert.equal(segments.at(-1)[1], 50 * RATE);
  for (const [start, end] of segments) assert.ok(end - start <= 20 * RATE);
});

test("joining: CJK text joins directly, a space goes in when both sides are Latin letters or digits; empty pieces are skipped", () => {
  assert.equal(joinTexts(["\u4f60\u597d\u3002", "\u5f00\u4f1a\u3002"]), "\u4f60\u597d\u3002\u5f00\u4f1a\u3002");
  assert.equal(joinTexts(["push to GitHub", "\u5f00 PR"]), "push to GitHub\u5f00 PR");
  assert.equal(joinTexts(["deploy to", "staging now"]), "deploy to staging now");
  assert.equal(joinTexts(["", " sounds good ", ""]), "sounds good");
});

test("silence: if even the loudest moment is under the threshold it is silent; any real sound is not", () => {
  assert.equal(isSilent(speech([["quiet", 3]])), true);
  assert.equal(
    isSilent(
      speech([
        ["quiet", 3],
        ["talk", 0.1],
      ]),
    ),
    false,
  );
  assert.equal(isSilent(new Float32Array(0)), true);
});

test("pieces for the model: after splitting, fully silent pieces are dropped; a fully silent recording gives none", () => {
  const samples = speech([
    ["talk", 15],
    ["quiet", 0.6],
    ["talk", 3],
    ["quiet", 25],
  ]);
  const windows = planWindows(samples, RATE, 20);
  assert.ok(windows.length > 0);
  for (const [start, end] of windows) assert.equal(isSilent(samples.subarray(start, end)), false);
  assert.ok(samples.length - windows.at(-1)[1] >= 15 * RATE, "the long silent ending was not handed over");
  assert.deepEqual(planWindows(speech([["quiet", 5]]), RATE, 20), []);
  assert.deepEqual(planWindows(speech([["talk", 5]]), RATE, null), [[0, 5 * RATE]], "no limit means one piece");
});
