import assert from "node:assert/strict";
import { test } from "node:test";

import { createWave, REST, WAVE_BARS } from "../../../src/renderer/bar/wave.mjs";

/** A fixed-seed random number: the same every run, yet not a constant */
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random always in the very middle: no jitter, no shift, every wave that should rise does, so the shape shows */
const steady = () => 0.5;

const FRAME_MS = 16;
const CENTER = Math.floor(WAVE_BARS / 2);

/**
 * Runs a stretch at the page's pace: hears a volume every 50 ms and draws once per frame.
 * @returns {number[][]} each frame's bar heights
 */
function play(wave, levels, { from = 0, until = from + levels.length * 50 } = {}) {
  const frames = [];
  for (let now = from; now < until; now += FRAME_MS) {
    const tick = Math.floor((now - from) / 50);
    if (tick < levels.length && (now - from) % 50 < FRAME_MS) wave.hear(levels[tick], now);
    frames.push(wave.frame(now));
  }
  return frames;
}

test("the bar count is odd: one in the very middle, where the wave starts", () => {
  assert.equal(WAVE_BARS % 2, 1);
  assert.equal(createWave({ bars: WAVE_BARS }).frame(0).length, WAVE_BARS);
});

test("with no sound, only background noise, the bars lie flat and still", () => {
  // Pauses in real recordings are the lowest step (1/128), occasionally two
  const wave = createWave({ bars: WAVE_BARS, random: seeded(1) });
  for (const heights of play(
    wave,
    Array.from({ length: 40 }, (_, i) => [0, 1 / 128, 2 / 128][i % 3]),
  )) {
    assert.deepEqual(heights, Array(WAVE_BARS).fill(REST));
  }
});

test("one word: the middle bar rises first, then it passes bar by bar to both sides, high in the middle and low at the sides", () => {
  const wave = createWave({ bars: WAVE_BARS, random: steady });
  wave.hear(0.1, 1000);
  const first = wave.frame(1000);
  assert.ok(first[CENTER] > 0.8, String(first[CENTER]));
  assert.equal(first[0], REST);
  assert.equal(first[WAVE_BARS - 1], REST);

  const spread = wave.frame(1150);
  for (const height of spread) assert.ok(height > REST, spread.join());
  for (let i = 0; i < CENTER; i++) {
    assert.ok(spread[i] < spread[i + 1], `left bar ${i} should be lower than the one inside it: ${spread.join()}`);
    assert.ok(
      spread[WAVE_BARS - 1 - i] < spread[WAVE_BARS - 2 - i],
      `right bar ${i} should be lower than the one inside it: ${spread.join()}`,
    );
  }
  assert.ok(spread[0] < spread[CENTER] * 0.6, spread.join());
});

test("settles back after speaking: all flat after a second and a half", () => {
  const wave = createWave({ bars: WAVE_BARS, random: seeded(2) });
  const frames = play(wave, [0.1, 0.15, 0.08], { from: 1000, until: 1000 + 150 + 1500 });
  assert.ok(frames[10].some((height) => height > 0.5));
  assert.deepEqual(frames.at(-1), Array(WAVE_BARS).fill(REST));
});

test("soft speech still raises most of the way, loud words clearly higher; two steps or less raise nothing", () => {
  const peakOf = (level) => {
    const wave = createWave({ bars: WAVE_BARS, random: steady });
    wave.hear(level, 0);
    return wave.frame(0)[CENTER];
  };
  // Speech volumes in real recordings: soft is 3 steps, normal is 8 to 20
  assert.ok(peakOf(3 / 128) > 0.5, String(peakOf(3 / 128)));
  assert.ok(peakOf(16 / 128) - peakOf(3 / 128) > 0.2, `${peakOf(16 / 128)} ${peakOf(3 / 128)}`);
  assert.ok(peakOf(1) <= 1);
  assert.equal(peakOf(2 / 128), REST);
});

test("while speaking it keeps jumping: the middle bar changes almost every frame with clear rises and falls, and the sides are lower than the middle", () => {
  // 3 seconds of speech from a real recording (a volume every 50 ms, in units of 1/128)
  const speech = [
    28, 80, 62, 50, 51, 51, 29, 10, 3, 3, 20, 34, 33, 13, 22, 17, 6, 5, 20, 20, 17, 17, 17, 5, 3, 12, 26, 18, 2, 1, 1,
    1, 1, 12, 18, 6, 3, 3, 16, 24, 14, 4, 3, 13, 14, 13, 17, 20, 14, 1, 1, 2, 17, 23, 23, 4, 1, 3, 18, 14,
  ].map((step) => step / 128);
  const frames = play(createWave({ bars: WAVE_BARS, random: seeded(3) }), speech);
  const center = frames.map((heights) => heights[CENTER]);
  const edges = frames.map((heights) => (heights[0] + heights[WAVE_BARS - 1]) / 2);
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

  const moving = center.slice(1).filter((height, i) => Math.abs(height - center[i]) > 0.005).length;
  assert.ok(moving / (center.length - 1) > 0.8, `only ${moving}/${center.length - 1} frames changed`);
  assert.ok(Math.max(...center) - Math.min(...center) > 0.3, `range ${Math.min(...center)} to ${Math.max(...center)}`);
  assert.ok(mean(center) > 0.5, `middle average ${mean(center)}`);
  assert.ok(mean(edges) < mean(center) * 0.6, `sides average ${mean(edges)}, middle ${mean(center)}`);
});

test("whatever volume arrives, heights stay between flat and full", () => {
  const random = seeded(4);
  const wave = createWave({ bars: WAVE_BARS, random: seeded(5) });
  const levels = Array.from({ length: 400 }, () => random() ** 2 * 1.5);
  for (const heights of play(wave, levels)) {
    for (const height of heights) assert.ok(height >= REST && height <= 1, String(height));
  }
});

test("after a reset everything lies flat, and waves not yet arrived stop", () => {
  const wave = createWave({ bars: WAVE_BARS, random: steady });
  wave.hear(0.2, 0);
  wave.frame(0);
  wave.reset();
  assert.deepEqual(wave.frame(16), Array(WAVE_BARS).fill(REST));
  assert.deepEqual(wave.frame(200), Array(WAVE_BARS).fill(REST));
});
