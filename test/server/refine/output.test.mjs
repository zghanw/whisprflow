import assert from "node:assert/strict";
import { test } from "node:test";
import { textFromModelOutput } from "../../../src/server/refine/output.mjs";
import { NO_SPEECH_MARK, SYSTEM_PROMPT } from "../../../src/server/refine/prompt.mjs";

test("the no-speech marker in the prompt is the one the code checks for", () => {
  assert.ok(SYSTEM_PROMPT.includes(`output only ${NO_SPEECH_MARK} and nothing else`));
});

test("the no-speech marker or no output at all gives an empty string", () => {
  assert.equal(textFromModelOutput(NO_SPEECH_MARK), "");
  assert.equal(textFromModelOutput(` ${NO_SPEECH_MARK}\n`), "");
  assert.equal(textFromModelOutput(undefined), "");
  assert.equal(textFromModelOutput("  "), "");
});

test("surrounding whitespace is trimmed; the marker is kept when the speaker actually said it in a sentence", () => {
  assert.equal(textFromModelOutput(" Are we meeting on Friday?\n"), "Are we meeting on Friday?");
  assert.equal(textFromModelOutput(`The marker is ${NO_SPEECH_MARK} here`), `The marker is ${NO_SPEECH_MARK} here`);
});

test("echoed transcript tags and quotes around the whole answer are removed; quotes inside are kept", () => {
  assert.equal(textFromModelOutput("<transcript>Meet at 3pm.</transcript>"), "Meet at 3pm.");
  assert.equal(textFromModelOutput('"What time does the meeting start?"'), "What time does the meeting start?");
  assert.equal(textFromModelOutput('She said "ship it" today.'), 'She said "ship it" today.');
  assert.equal(textFromModelOutput('"'), '"');
});

test("spaces at the ends of lines (Markdown line breaks after list items) are removed, the lines kept", () => {
  assert.equal(
    textFromModelOutput("- Update the docs  \n- Fix the login bug  \n- Ship the release"),
    "- Update the docs\n- Fix the login bug\n- Ship the release",
  );
});
