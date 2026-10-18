import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import { Action, initialState, Phase, transition } from "../../../src/renderer/bar/machine.mjs";

const en = createTranslator("en");

/** Feeds events in order and returns the final state and each step's actions */
function run(...events) {
  let state = initialState;
  const steps = [];
  for (const event of events) {
    const result = transition(state, typeof event === "string" ? { type: event } : event);
    state = result.state;
    steps.push(result.actions);
  }
  return { state, steps };
}

test("tap to start, tap again to finish, back to idle when the result arrives", () => {
  const { state, steps } = run("KEY_DOWN", "MIC_READY", "KEY_UP", "KEY_DOWN", "KEY_UP", "RESULT");
  assert.deepEqual(steps, [
    [Action.START, Action.ARM_HOLD_TIMER],
    [],
    [Action.CLEAR_HOLD_TIMER],
    [Action.STOP],
    [],
    [],
  ]);
  assert.deepEqual(state, initialState);
});

test("releasing before the microphone is ready still goes on to recording", () => {
  const { state } = run("KEY_DOWN", "KEY_UP", "MIC_READY");
  assert.deepEqual(state, { phase: Phase.RECORDING, held: false, message: null });
});

test("holding past the limit cancels and tells the user push-to-talk isn't supported", () => {
  const { state, steps } = run("KEY_DOWN", "MIC_READY", "LONG_HOLD");
  assert.equal(state.phase, Phase.IDLE);
  assert.match(en.text(state.message), /No need to hold/);
  assert.deepEqual(steps.at(-1), [Action.CANCEL]);
  // Releasing after the cancel must trigger nothing more
  assert.deepEqual(transition(state, { type: "KEY_UP" }), { state, actions: [] });
});

test("after release, a late long-press timer has no effect", () => {
  const { state, steps } = run("KEY_DOWN", "MIC_READY", "KEY_UP", "LONG_HOLD");
  assert.equal(state.phase, Phase.RECORDING);
  assert.deepEqual(steps.at(-1), []);
});

test("the hotkey plus another key is a combination: cancel quietly, no hint", () => {
  const { state, steps } = run("KEY_DOWN", "OTHER_KEY");
  assert.deepEqual(state, initialState);
  assert.deepEqual(steps.at(-1), [Action.CANCEL, Action.CLEAR_HOLD_TIMER]);
});

test("normal typing while recording doesn't affect the recording", () => {
  const { state, steps } = run("KEY_DOWN", "MIC_READY", "KEY_UP", "OTHER_KEY");
  assert.equal(state.phase, Phase.RECORDING);
  assert.deepEqual(steps.at(-1), []);
});

test("if the release event was lost, another press still finishes; a late long-press timer won't cancel it", () => {
  const { state, steps } = run("KEY_DOWN", "MIC_READY", "KEY_DOWN", "LONG_HOLD");
  assert.equal(state.phase, Phase.FINISHING);
  assert.deepEqual(steps.slice(-2), [[Action.STOP], []]);
});

test("a second press before the microphone is ready: dropped", () => {
  const { state, steps } = run("KEY_DOWN", "KEY_UP", "KEY_DOWN");
  assert.deepEqual(state, initialState);
  assert.deepEqual(steps.at(-1), [Action.CANCEL]);
});

test("pressing the hotkey while waiting for the result doesn't start a new one", () => {
  const { state, steps } = run("KEY_DOWN", "MIC_READY", "KEY_UP", "KEY_DOWN", "KEY_UP", "KEY_DOWN");
  assert.equal(state.phase, Phase.FINISHING);
  assert.deepEqual(steps.at(-1), []);
});

test("recording ends by itself at the limit", () => {
  const { state, steps } = run("KEY_DOWN", "MIC_READY", "KEY_UP", "MAX_DURATION");
  assert.equal(state.phase, Phase.FINISHING);
  assert.deepEqual(steps.at(-1), [Action.STOP]);
});

test("a result can return to idle with a hint", () => {
  const { state } = run("KEY_DOWN", "MIC_READY", "KEY_UP", "KEY_DOWN", {
    type: "RESULT",
    message: "Didn't hear anything",
  });
  assert.deepEqual(state, { phase: Phase.IDLE, held: false, message: "Didn't hear anything" });
});

test("errors: the recording phase releases the microphone, the waiting phase doesn't; the hotkey starts again afterwards", () => {
  const starting = run("KEY_DOWN", { type: "FAILED", message: "Can't open the microphone" });
  assert.deepEqual(starting.state, { phase: Phase.ERROR, held: false, message: "Can't open the microphone" });
  assert.deepEqual(starting.steps.at(-1), [Action.CANCEL, Action.CLEAR_HOLD_TIMER]);

  const finishing = run("KEY_DOWN", "MIC_READY", "KEY_UP", "KEY_DOWN", {
    type: "FAILED",
    message: "The server didn't respond",
  });
  assert.equal(finishing.state.phase, Phase.ERROR);
  assert.deepEqual(finishing.steps.at(-1), []);

  const retry = transition(finishing.state, { type: "KEY_DOWN" });
  assert.equal(retry.state.phase, Phase.STARTING);
  assert.equal(retry.state.message, null);
});

test("cancelling while recording (X or esc) discards the recording and returns to idle without a hint; works before the microphone is ready too", () => {
  const recording = run("KEY_DOWN", "MIC_READY", "KEY_UP", "USER_CANCEL");
  assert.deepEqual(recording.state, initialState);
  assert.deepEqual(recording.steps.at(-1), [Action.CANCEL, Action.CLEAR_HOLD_TIMER]);

  const starting = run("KEY_DOWN", "USER_CANCEL");
  assert.deepEqual(starting.state, initialState);
  assert.deepEqual(starting.steps.at(-1), [Action.CANCEL, Action.CLEAR_HOLD_TIMER]);
  // Releasing the hotkey after the cancel must trigger nothing more
  assert.deepEqual(transition(starting.state, { type: "KEY_UP" }), { state: starting.state, actions: [] });
});

test("cancel only works while speaking: not while waiting for the result, and harmless when idle or after an error", () => {
  const finishing = run("KEY_DOWN", "MIC_READY", "KEY_UP", "KEY_DOWN", "USER_CANCEL");
  assert.equal(finishing.state.phase, Phase.FINISHING);
  assert.deepEqual(finishing.steps.at(-1), []);
  assert.deepEqual(run("USER_CANCEL").state, initialState);
  const failed = run("KEY_DOWN", { type: "FAILED", message: "Can't open the microphone" }, "USER_CANCEL");
  assert.equal(failed.state.phase, Phase.ERROR);
  assert.deepEqual(failed.steps.at(-1), []);
});

test("clicking done equals pressing the hotkey again: ends recording and asks for the result; ignored before the microphone is ready or while already waiting", () => {
  const { state, steps } = run("KEY_DOWN", "MIC_READY", "KEY_UP", "USER_CONFIRM");
  assert.deepEqual(state, { phase: Phase.FINISHING, held: false, message: null });
  assert.deepEqual(steps.at(-1), [Action.STOP]);

  const starting = run("KEY_DOWN", "KEY_UP", "USER_CONFIRM");
  assert.equal(starting.state.phase, Phase.STARTING);
  assert.deepEqual(starting.steps.at(-1), []);
  const twice = run("KEY_DOWN", "MIC_READY", "KEY_UP", "USER_CONFIRM", "USER_CONFIRM");
  assert.equal(twice.state.phase, Phase.FINISHING);
  assert.deepEqual(twice.steps.at(-1), []);
  assert.deepEqual(run("USER_CONFIRM").state, initialState);
});

test("results and errors arriving while idle are ignored; unknown events throw", () => {
  assert.deepEqual(run("RESULT").state, initialState);
  assert.deepEqual(run({ type: "FAILED", message: "x" }).state, initialState);
  assert.throws(() => transition(initialState, { type: "NOPE" }), /Unknown state machine event/);
});
