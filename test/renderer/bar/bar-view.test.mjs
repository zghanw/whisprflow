import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import { controlsIn, hintFor, LINGER_MS, View, viewOf } from "../../../src/renderer/bar/bar-view.mjs";

const en = createTranslator("en");

import { Phase } from "../../../src/renderer/bar/machine.mjs";

const at = (phase, message = null) => ({ phase, held: false, message });

test("each of the three speaking phases has its own view", () => {
  assert.equal(viewOf(at(Phase.STARTING), Phase.IDLE), View.STARTING);
  assert.equal(viewOf(at(Phase.RECORDING), Phase.STARTING), View.RECORDING);
  assert.equal(viewOf(at(Phase.FINISHING), Phase.RECORDING), View.FINISHING);
});

test("back to idle: a check right after a result; a cancel just disappears; something to say shows that sentence", () => {
  assert.equal(viewOf(at(Phase.IDLE), Phase.FINISHING), View.DONE);
  assert.equal(viewOf(at(Phase.IDLE), Phase.RECORDING), View.HIDDEN);
  assert.equal(viewOf(at(Phase.IDLE), Phase.STARTING), View.HIDDEN);
  assert.equal(viewOf(at(Phase.IDLE), Phase.IDLE), View.HIDDEN);
  assert.equal(viewOf(at(Phase.IDLE, "Didn't hear anything"), Phase.FINISHING), View.NOTICE);
  assert.equal(viewOf(at(Phase.IDLE, "No Gemini API key yet"), Phase.IDLE), View.NOTICE);
  assert.equal(viewOf(at(Phase.ERROR, "Can't reach Gemini"), Phase.FINISHING), View.ERROR);
});

test("closing views disappear on their own; views shown while speaking stay", () => {
  assert.equal(LINGER_MS[View.DONE] < LINGER_MS[View.NOTICE], true);
  assert.equal(LINGER_MS[View.NOTICE], LINGER_MS[View.ERROR]);
  for (const view of [View.STARTING, View.RECORDING, View.FINISHING, View.HIDDEN]) {
    assert.equal(LINGER_MS[view], undefined, view);
  }
});

test("the hint line above says what is happening and which key to press; key names are marked separately", () => {
  const options = { keycap: "Right ⌥", cancellable: true };
  assert.deepEqual(hintFor(View.STARTING, options, en), ["Opening microphone…"]);
  assert.deepEqual(hintFor(View.RECORDING, options, en), [
    "Press ",
    { key: "Right ⌥" },
    " to finish · ",
    { key: "esc" },
    " to cancel",
  ]);
  assert.deepEqual(hintFor(View.FINISHING, options, en), ["Refining"]);
  for (const view of [View.DONE, View.NOTICE, View.ERROR, View.HIDDEN])
    assert.deepEqual(hintFor(view, options, en), []);
});

test("with the hint turned off in the settings no view writes one, leaving the space above the bar empty", () => {
  for (const view of Object.values(View)) {
    assert.deepEqual(hintFor(view, { keycap: "Right ⌥", cancellable: true, shown: false }, en), [], view);
  }
});

test("when cancelling isn't possible (no Accessibility permission, esc can't be captured) the hint doesn't mention esc", () => {
  assert.deepEqual(hintFor(View.RECORDING, { keycap: "fn", cancellable: false }, en), [
    "Press ",
    { key: "fn" },
    " to finish",
  ]);
});

test("which buttons work in which view: only cancel while opening the microphone, cancel and done while listening, none otherwise", () => {
  assert.deepEqual(controlsIn(View.STARTING), ["cancel"]);
  assert.deepEqual(controlsIn(View.RECORDING), ["cancel", "confirm"]);
  for (const view of [View.FINISHING, View.DONE, View.NOTICE, View.ERROR, View.HIDDEN]) {
    assert.deepEqual(controlsIn(view), [], view);
  }
});
