import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../src/i18n/index.mjs";
import { DEFAULT_TRANSCRIBER } from "../../src/models/catalog.mjs";
import { boot, requests } from "./route-harness.mjs";

// Private mode end to end: on-device transcription only, no key from anyone, no requests out (./route-harness.mjs).

const en = createTranslator("en");
const PRIVATE = { mode: "private" };
const LOCAL = { mode: "local", polish: "custom/qwen3:8b", customUrl: "http://x.example/v1" };

test("starting in private mode works without any key; the key state is no key needed, and no request goes out", async (t) => {
  requests.length = 0;
  const app = await boot(t, { settings: PRIVATE });
  const started = await app.keys.loadAtStartup();
  assert.equal(started.state, "ready");
  assert.equal(started.source, "none");
  assert.equal(app.service.ready, true);
  assert.equal(app.keys.provider, null);
  assert.deepEqual(requests, []);
});

test("switching into private asks for no key and sends nothing; switching back to local uses the cleanup vendor's key again", async (t) => {
  const app = await boot(t, { settings: LOCAL, stored: { custom: "custom-good" } });
  await app.keys.loadAtStartup();
  requests.length = 0;
  assert.equal((await app.modes.switchMode("private")).ok, true);
  assert.deepEqual(requests, []);
  assert.equal(app.service.route.mode, "private");
  assert.equal(app.keys.current.source, "none");
  assert.equal(app.saved().mode, "private");

  assert.equal((await app.modes.switchMode("local")).ok, true);
  assert.equal(app.keys.current.state, "ready");
  assert.equal(app.keys.current.source, "stored");
  assert.equal(app.keys.provider.id, "custom");
});

test("switching into private before its model is downloaded still switches; no key needed, and the model waits as not downloaded", async (t) => {
  const app = await boot(t, { settings: LOCAL, stored: { custom: "custom-good" }, installed: ["qwen3-asr-0.6b-int8"] });
  await app.keys.loadAtStartup();
  assert.equal((await app.modes.switchMode("private")).ok, true);
  assert.equal(app.service.route.mode, "private");
  assert.equal(app.keys.current.source, "none");
  assert.deepEqual(app.service.localModel, { state: "missing", model: DEFAULT_TRANSCRIBER });
});

test("changing the model in private saves its own setting and leaves local's step one alone; non-catalog models are refused", async (t) => {
  const app = await boot(t, { settings: { ...PRIVATE, transcriber: "qwen3-asr-0.6b-q8" } });
  await app.keys.loadAtStartup();
  assert.equal((await app.modes.setTranscriber("qwen3-asr-0.6b-int8")).ok, true);
  assert.equal(app.service.route.transcriber, "qwen3-asr-0.6b-int8");
  assert.equal(app.saved().privateTranscriber, "qwen3-asr-0.6b-int8");
  assert.equal(app.saved().transcriber, "qwen3-asr-0.6b-q8");

  const cloud = await app.modes.setTranscriber("example/cloud-asr");
  assert.equal(cloud.ok, false);
  assert.match(en.text(cloud.problem), /qwen3-asr-0\.6b-q8/);
  assert.equal(app.service.route.transcriber, "qwen3-asr-0.6b-int8");
});

test("saving a key and deleting models in private: a key must name its vendor; the model in use can't be deleted", async (t) => {
  const app = await boot(t, { settings: PRIVATE });
  await app.keys.loadAtStartup();
  const unnamed = await app.keys.save("oa-good");
  assert.equal(unnamed.ok, false);
  assert.match(en.text(unnamed.problem), /say which provider/);
  assert.deepEqual(await app.keys.save("oa-good", { provider: "openai" }), { ok: true });
  assert.equal(app.keys.current.source, "none", "saving another vendor's key doesn't change the no-key state");

  const removed = await app.modes.removeModel(DEFAULT_TRANSCRIBER);
  assert.equal(removed.ok, false);
  assert.equal((await app.modes.removeModel("qwen3-asr-0.6b-int8")).ok, true);
});

test("checking private mode works without a key", async (t) => {
  const app = await boot(t, { settings: LOCAL });
  const result = await app.modes.check("private", {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.source, "none");
});
