import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import {
  apiKeyProblem,
  DEFAULT_MODEL_CHOICE,
  findProvider,
  formatModelChoice,
  PROVIDERS,
  parseModelChoice,
} from "../../../src/server/providers/index.mjs";

const en = createTranslator("en");
/** The user-facing sentence in the error, as translated */
const said = (pattern) => (error) => pattern.test(en.text(error.problem ?? error.message));

test("registered vendors: Gemini and OpenAI, each with its key variable, key page, and default model", () => {
  assert.deepEqual(
    PROVIDERS.map(({ id, name, keyEnv }) => ({ id, name, keyEnv })),
    [
      { id: "gemini", name: "Gemini", keyEnv: "GEMINI_API_KEY" },
      { id: "openai", name: "OpenAI", keyEnv: "OPENAI_API_KEY" },
    ],
  );
  for (const provider of PROVIDERS) {
    assert.match(provider.keyPage, /^https:\/\//);
    assert.equal(typeof provider.defaultModel, "string");
    assert.equal(typeof provider.load, "function");
    // One model per list entry, the default among them
    const ids = provider.models.map(({ id }) => id);
    assert.ok(ids.includes(provider.defaultModel), `${provider.id} default model is not listed`);
    for (const model of provider.models) assert.ok(model.name && model.maker, `${provider.id}/${model.id}`);
  }
  // Only Gemini has thinking levels
  assert.deepEqual(findProvider("gemini").thinkingLevels, ["MINIMAL", "LOW", "MEDIUM", "HIGH"]);
  assert.equal(findProvider("openai").thinkingLevels, null);
});

test("Gemini 3.6 Flash is the default: 3.5 Flash is retired and its requests already go to 3.6, so upgraded users get the same model", () => {
  assert.deepEqual(DEFAULT_MODEL_CHOICE, { provider: "gemini", model: "gemini-3.6-flash" });
});

test("findProvider: by id, case-insensitive; unknown ids are null, and prototype names find nothing", () => {
  assert.equal(findProvider("openai").name, "OpenAI");
  assert.equal(findProvider("OpenAI").id, "openai");
  assert.equal(findProvider("deepseek"), null);
  assert.equal(findProvider("constructor"), null);
});

test("model choice: vendor/model; vendor alone uses its default model", () => {
  assert.deepEqual(parseModelChoice("openai/gpt-audio-1.5"), { provider: "openai", model: "gpt-audio-1.5" });
  assert.deepEqual(parseModelChoice(" OpenAI/gpt-audio-1.5 "), { provider: "openai", model: "gpt-audio-1.5" });
  assert.deepEqual(parseModelChoice("openai"), { provider: "openai", model: findProvider("openai").defaultModel });
  assert.deepEqual(parseModelChoice("gemini"), { provider: "gemini", model: "gemini-3.6-flash" });
  assert.equal(formatModelChoice({ provider: "openai", model: "gpt-audio-1.5" }), "openai/gpt-audio-1.5");
});

test("older form: a bare Gemini model name (older settings files and GEMINI_MODEL) still works", () => {
  assert.deepEqual(parseModelChoice("gemini-3.5-flash-lite"), { provider: "gemini", model: "gemini-3.5-flash-lite" });
});

test("a wrong choice says what is wrong and what is available", () => {
  assert.throws(() => parseModelChoice("deepseek/deepseek-flash"), said(/unknown provider deepseek.*gemini \/ openai/));
  assert.throws(() => parseModelChoice("openai/"), said(/model name/));
  assert.throws(() => parseModelChoice(""), said(/empty/));
  assert.throws(() => parseModelChoice("openai/gpt audio"), said(/model name/));
  assert.throws(() => parseModelChoice("openai/a/b"), said(/model name/));
});

test("key shape: visible ASCII characters only; a wrong one says what is wrong without including the key", () => {
  assert.equal(apiKeyProblem("AIzaSy-not_a.real-key"), null);
  assert.equal(apiKeyProblem("sk-proj-Abc_123-xyz"), null);
  // Multi-line input piped in, or extra characters copied along, all fall here
  for (const bad of [
    "line-one-SECRET\nline-two-SECRET",
    "has SECRET space",
    "tab\tSECRET",
    "cl\u00e9SECRET",
    "x-SECRET\u0007",
  ]) {
    const problem = apiKeyProblem(bad);
    assert.equal(typeof problem.key, "string");
    assert.doesNotMatch(en.text(problem), /SECRET/);
    assert.doesNotMatch(JSON.stringify(problem), /SECRET/);
  }
  assert.match(en.text(apiKeyProblem("a b")), /spaces or line breaks/);
  assert.match(en.text(apiKeyProblem("k".repeat(600))), /too long/);
});

test("the prefixed forms the Gemini SDK accepted (models/..., tunedModels/...) still count as Gemini", () => {
  assert.deepEqual(parseModelChoice("models/gemini-3.5-flash"), {
    provider: "gemini",
    model: "models/gemini-3.5-flash",
  });
  assert.deepEqual(parseModelChoice("tunedModels/my-model"), { provider: "gemini", model: "tunedModels/my-model" });
  assert.deepEqual(parseModelChoice("gemini/models/gemini-3.5-flash"), {
    provider: "gemini",
    model: "models/gemini-3.5-flash",
  });
  // Other vendors' model names never contain slashes
  assert.throws(() => parseModelChoice("openai/models/x"), said(/model name/));
});
