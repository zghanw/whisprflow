import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../src/i18n/index.mjs";
import { DEFAULT_TRANSCRIBER, findModel } from "../../src/models/catalog.mjs";
import {
  createModeRefiner,
  describeRoute,
  findMode,
  keyVendorOf,
  keyVendorsOf,
  MODES,
  parseMode,
  usesLocalModel,
} from "../../src/server/modes.mjs";

const en = createTranslator("en");
const quiet = { info() {}, warn() {}, error() {} };
const NATIVE = { mode: "native", model: { provider: "openai", model: "gpt-audio-mini" }, thinkingLevel: "MINIMAL" };
const LOCAL = {
  mode: "local",
  transcriber: "qwen3-asr-0.6b-q8",
  polish: { vendor: "ollama", model: "qwen3:4b-instruct" },
  customUrl: null,
};
const PRIVATE = { mode: "private", transcriber: "qwen3-asr-0.6b-q8" };

test("the three modes are registered as peers, and the default transcriber is in the catalog", () => {
  assert.deepEqual(
    MODES.map(({ id }) => id),
    ["native", "local", "private"],
  );
  assert.ok(findModel(DEFAULT_TRANSCRIBER));
  assert.equal(findMode("LOCAL").id, "local");
  assert.equal(findMode("nope"), null);
});

test("modes are case-insensitive; a wrong one lists the choices", () => {
  assert.equal(parseMode(" Local "), "local");
  assert.throws(
    () => parseMode("cloud"),
    (error) => /native/.test(en.text(error.problem)) && /local/.test(en.text(error.problem)),
  );
});

test("whose key a route needs: the audio vendor for native; none for Ollama cleanup; the custom key for a custom service", () => {
  assert.equal(keyVendorOf(NATIVE).id, "openai");
  assert.deepEqual(keyVendorsOf(LOCAL), []);
  assert.equal(keyVendorOf(LOCAL), undefined);
  assert.equal(keyVendorOf({ ...LOCAL, polish: { vendor: "custom", model: "m" } }).keyEnv, "WHISPRFLOW_CUSTOM_API_KEY");
  assert.equal(usesLocalModel(LOCAL), true);
  assert.equal(usesLocalModel(NATIVE), false);
});

test("a route in one line, for logs and status", () => {
  assert.equal(describeRoute(NATIVE), "native: openai/gpt-audio-mini");
  assert.equal(describeRoute(LOCAL), "local: qwen3-asr-0.6b-q8 → ollama/qwen3:4b-instruct");
});

test("local path: the given transcriber is chained to the route's polisher, and cleanup goes to the chosen vendor", async () => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return Response.json({
      model: "qwen3:4b-instruct",
      choices: [{ finish_reason: "stop", message: { content: "Sounds good." } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  };
  const transcriber = { transcribe: async () => ({ text: "sounds good" }) };
  const refiner = await createModeRefiner({
    route: LOCAL,
    transcriber,
    log: quiet,
    decode: async () => new Float32Array(16_000),
    fetch,
  });
  assert.equal(await refiner.refine(Buffer.from("x"), { mimeType: "audio/webm" }), "Sounds good.");
  assert.equal(requests[0].url, "http://localhost:11434/v1/chat/completions");
});

test("the local path without a transcriber fails right away (the caller must load the model first)", async () => {
  await assert.rejects(createModeRefiner({ route: LOCAL, log: quiet }), /transcriber/);
});

test("private mode: one step, the on-device transcript is used as is; no key from anyone and no requests out", async () => {
  const requests = [];
  const fetch = async (url) => {
    requests.push(url);
    return Response.json({});
  };
  const refiner = await createModeRefiner({
    route: PRIVATE,
    transcriber: { transcribe: async () => ({ text: "  um, I have a few things to do  " }) },
    log: quiet,
    decode: async () => new Float32Array(16_000),
    fetch,
  });
  await refiner.warmUp();
  assert.equal(await refiner.refine(Buffer.from("x"), { mimeType: "audio/webm" }), "um, I have a few things to do");
  assert.deepEqual(requests, []);
  assert.deepEqual(keyVendorsOf(PRIVATE), []);
  assert.equal(keyVendorOf(PRIVATE), undefined);
  assert.equal(usesLocalModel(PRIVATE), true);
  assert.equal(describeRoute(PRIVATE), "private: qwen3-asr-0.6b-q8");
});

test("private mode without a transcriber fails right away", async () => {
  await assert.rejects(createModeRefiner({ route: PRIVATE, log: quiet }), /transcriber/);
});
