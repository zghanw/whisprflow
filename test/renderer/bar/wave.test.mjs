import assert from "node:assert/strict";
import { test } from "node:test";

import { CURVES, createWave, IDLE, loudness, POINTS } from "../../../src/renderer/bar/wave.mjs";

const FRAME_MS = 16;
/** A volume speech often reaches (14 steps of the 8-bit waveform) */
const SPEECH = 14 / 128;

/** The tallest point of the main curve, as a share of the half-height */
const peak = (curves) => Math.max(...curves.at(-1).points.map(([, y]) => Math.abs(y)));

/** Runs a stretch at the page's pace: hears a volume every 50 ms and draws once per frame. Returns each frame's curves */
function play(wave, levels, { from = 0, until = from + levels.length * 50, still = false } = {}) {
  const frames = [];
  for (let now = from; now < until; now += FRAME_MS) {
    const tick = Math.floor((now - from) / 50);
    if (tick < levels.length && (now - from) % 50 < FRAME_MS) wave.hear(levels[tick]);
    frames.push(wave.frame(now, { still }));
  }
  return frames;
}

test("seven curves back to front: echoes in mirrored pairs, the main curve last; points run evenly across the width", () => {
  const curves = createWave().frame(0);
  assert.deepEqual(
    curves.map(({ scale }) => scale),
    [...CURVES],
  );
  assert.deepEqual(
    curves.map(({ main }) => main),
    [false, false, false, false, false, false, true],
  );
  for (const { points } of curves) {
    assert.equal(points.length, POINTS);
    assert.deepEqual([points[0][0], points.at(-1)[0]], [0, 1]);
  }
});

test("silence breathes low: the wave never lies flat, stays near the floor, and keeps moving slowly", () => {
  const wave = createWave();
  const frames = play(wave, [], { until: 2000 });
  for (const curves of frames) {
    assert.ok(peak(curves) > 0.02, "never flat");
    assert.ok(peak(curves) <= IDLE * 0.8 * 1.22 + 1e-9, "never above the breathing floor");
  }
  assert.notDeepEqual(frames.at(-1), frames.at(-20), "still moving");
});

test("the voice lifts the wave at once, and it settles back within a few tenths of a second once quiet", () => {
  const wave = createWave();
  play(wave, [], { until: 200 });
  const resting = peak(wave.frame(200));
  wave.hear(SPEECH);
  const lifted = peak(wave.frame(216));
  assert.ok(lifted > resting * 3, `${lifted} vs ${resting}`);
  // 400 ms later with no voice: back to the floor
  const settled = play(wave, [], { from: 232, until: 650 }).at(-1);
  assert.ok(peak(settled) <= IDLE * 0.8 * 1.22 + 1e-9);
});

test("the ends stay pinned and nothing leaves the drawing area, even at full voice", () => {
  const wave = createWave();
  for (const curves of play(wave, Array(40).fill(1))) {
    for (const { points } of curves) {
      for (const [, y] of points) assert.ok(Math.abs(y) <= 1, `${y}`);
      const middle = Math.max(...points.slice(15, 22).map(([, y]) => Math.abs(y)));
      const ends = Math.max(Math.abs(points[0][1]), Math.abs(points.at(-1)[1]));
      if (middle > 0.1) assert.ok(ends < middle * 0.25, `ends ${ends} vs middle ${middle}`);
    }
  }
});

test("reduce motion: the curves stop swaying, but the height still follows the voice", () => {
  const wave = createWave();
  const quiet = play(wave, [], { until: 500, still: true });
  assert.deepEqual(quiet.at(-1), quiet.at(-10), "no motion in silence");
  wave.hear(SPEECH);
  assert.ok(peak(wave.frame(520, { still: true })) > peak(quiet.at(-1)) * 3);
});

test("starting over returns to the floor at the start of the motion; a frame's time decides its shape, however often frames come", () => {
  const wave = createWave();
  play(wave, Array(10).fill(SPEECH));
  wave.reset();
  assert.deepEqual(wave.frame(0), createWave().frame(0));

  // The same stretch drawn at 60 and at 30 frames a second ends in the same place
  const fast = createWave();
  const slow = createWave();
  for (let now = 0; now <= 960; now += 16) fast.frame(now);
  for (let now = 0; now <= 960; now += 32) slow.frame(now);
  const [a, b] = [fast.frame(1000), slow.frame(1000)];
  for (const [index, curve] of a.entries()) {
    for (const [k, [, y]] of curve.points.entries()) assert.ok(Math.abs(y - b[index].points[k][1]) < 1e-9);
  }
});

test("loudness is logarithmic over the range speech uses: pauses count as silence, loud speech reaches the top", () => {
  assert.equal(loudness(0), 0);
  assert.equal(loudness(1 / 128), 0);
  assert.ok(loudness(SPEECH) > 0.5 && loudness(SPEECH) < 1);
  assert.equal(loudness(0.19), 1);
  assert.equal(loudness(1), 1);
});
