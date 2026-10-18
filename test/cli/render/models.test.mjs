import assert from "node:assert/strict";
import { test } from "node:test";
import { renderModels } from "../../../src/cli/render/models.mjs";
import { PROVIDERS } from "../../../src/server/providers/index.mjs";
import { plain } from "./fixtures.mjs";

test("one vendor per line: the one in use is marked with its model, others show their default; whether each has a key is stated honestly", () => {
  const text = renderModels(
    {
      providers: PROVIDERS,
      setting: { value: "gemini/gemini-3.8-flash", source: "file" },
      keys: { gemini: "stored", openai: null },
    },
    plain,
  );
  assert.match(text, /^Models\n/);
  assert.match(text, /\n {2}● gemini\s+Gemini\s+gemini-3\.8-flash\s+key saved\n/);
  assert.match(text, /\n {4}openai\s+OpenAI\s+gpt-audio-mini \(default\)\s+no key yet\n/);
  assert.match(text, /Using Gemini gemini-3\.8-flash · from the settings file/);
  // The example given is the other vendor
  assert.match(text, /whisprflow model openai\b/);
  assert.match(text, /whisprflow model openai\/gpt-audio-mini/);
  assert.match(text, /whisprflow model check/);
  assert.ok(!text.includes("\x1b["));
});

test("a key from the environment names the variable; settings overridden by the environment are stated honestly too", () => {
  const text = renderModels(
    {
      providers: PROVIDERS,
      setting: { value: "openai/gpt-audio-mini", source: "env" },
      keys: { gemini: null, openai: "env" },
    },
    plain,
  );
  assert.match(text, /● openai\s+OpenAI\s+gpt-audio-mini\s+key from the OPENAI_API_KEY env var/);
  assert.match(text, /Using OpenAI gpt-audio-mini · from the WHISPRFLOW_MODEL env var this run/);
  assert.match(text, /whisprflow model gemini\b/);
});
