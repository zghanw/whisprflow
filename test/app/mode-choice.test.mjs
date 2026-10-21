import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeSetup } from "../../src/app/setup-state.mjs";
import { createTranslator } from "../../src/i18n/index.mjs";
import { DEFAULT_TRANSCRIBER } from "../../src/models/catalog.mjs";
import { boot, requests } from "./route-harness.mjs";

// Which recognition mode to use is the user's call; whether it works is state, and the two stay apart (app/modes.mjs).
// Requiring keys and downloads before switching would trap someone in native mode with no key and no model downloaded.
// Here the whole core runs end to end (./route-harness.mjs): a switch takes effect at once, what's missing is state, and it works once filled in.

const en = createTranslator("en");
/** Native with nothing else set and no key saved: the hardest place to switch away from */
const FRESH = { mode: "native" };
const ON_DEVICE = DEFAULT_TRANSCRIBER;
const CUSTOM = { polish: "custom/qwen3:8b", customUrl: "http://x.example/v1" };

/** Waits for the on-device model to load (the fake loader is asynchronous) */
async function loaded(app) {
  for (let i = 0; i < 50 && app.service.localModel.state !== "ready"; i++) await new Promise((r) => setTimeout(r, 2));
  return app.service.localModel.state;
}

test("a fresh install starts in local mode: on-device transcription plus Ollama cleanup, ready with no key", async (t) => {
  const app = await boot(t, { settings: {} });
  await app.keys.loadAtStartup();
  assert.equal(app.service.route.mode, "local");
  assert.deepEqual(app.service.route.polish, { vendor: "ollama", model: "qwen3:4b-instruct" });
  assert.equal(app.keys.provider, null);
  assert.deepEqual([app.keys.current.state, app.keys.current.source], ["ready", "none"]);
});

test("native, model not downloaded: switching to private takes effect at once and the state says the model isn't downloaded; once downloaded it loads and works", async (t) => {
  const installed = [];
  const app = await boot(t, { settings: FRESH, installed });
  await app.keys.loadAtStartup();
  assert.equal(app.keys.current.state, "missing", "starting point: native without a Gemini key");

  requests.length = 0;
  assert.equal((await app.modes.switchMode("private")).ok, true);
  assert.equal(app.service.route.mode, "private");
  assert.equal(app.saved().mode, "private");
  assert.deepEqual(requests, []);
  assert.deepEqual([app.keys.current.state, app.keys.current.source], ["ready", "none"]);
  assert.equal(app.service.localModel.state, "missing");

  installed.push(ON_DEVICE);
  app.service.modelsChanged();
  assert.equal(await loaded(app), "ready");
});

test("native without a key: switching to local with Ollama cleanup works at once with no key", async (t) => {
  const app = await boot(t, { settings: FRESH });
  await app.keys.loadAtStartup();
  assert.equal((await app.modes.switchMode("local")).ok, true);
  assert.equal(app.service.route.mode, "local");
  assert.equal(app.saved().mode, "local");
  assert.equal(app.keys.provider, null);
  assert.deepEqual([app.keys.current.state, app.keys.current.source], ["ready", "none"]);
});

test("native without a key, custom service without a key: switching still works, the state names the missing key, and saving one makes it work", async (t) => {
  const app = await boot(t, { settings: FRESH });
  await app.keys.loadAtStartup();
  assert.equal((await app.modes.switchMode("local", CUSTOM)).ok, true);
  assert.equal(app.keys.provider.id, "custom");
  assert.equal(app.keys.current.state, "missing");
  const summary = summarizeSetup({
    key: app.keys.current,
    permissions: { microphone: "granted", listen: true, trusted: true },
    providerName: "x.example",
    localModel: app.service.localModel,
  });
  assert.match(en.text(summary.blocker), /x\.example/);
  assert.doesNotMatch(en.text(summary.blocker), /Gemini/);

  assert.deepEqual(await app.keys.save("custom-good"), { ok: true });
  assert.equal(app.keys.current.state, "ready");
});

test("modes that aren't ready can still switch back and forth: each time the state describes the mode switched to, never the old one", async (t) => {
  const app = await boot(t, { settings: FRESH, installed: [] });
  await app.keys.loadAtStartup();
  assert.equal((await app.modes.switchMode("local")).ok, true);
  assert.equal((await app.modes.switchMode("private")).ok, true);
  assert.equal(app.keys.current.source, "none");
  assert.equal((await app.modes.switchMode("native")).ok, true);
  assert.equal(app.keys.provider.id, "gemini");
  assert.equal(app.keys.current.state, "missing");
});

test("switching to a vendor without a key and to an undownloaded model: both switch, and the state says so", async (t) => {
  const app = await boot(t, { settings: { mode: "local" }, installed: [ON_DEVICE] });
  await app.keys.loadAtStartup();
  assert.equal(app.keys.current.state, "ready");

  assert.equal((await app.modes.setTranscriber("qwen3-asr-0.6b-int8")).ok, true);
  assert.equal(app.saved().transcriber, "qwen3-asr-0.6b-int8");
  assert.equal(app.service.localModel.state, "missing");
  assert.equal(app.keys.current.state, "ready", "changing only the step-one model leaves cleanup as it was");

  assert.equal((await app.modes.setPolish(CUSTOM.polish, { customUrl: CUSTOM.customUrl })).ok, true);
  assert.equal(app.keys.provider.id, "custom");
  assert.equal(app.keys.current.state, "missing");
  assert.equal(app.saved().polish, "custom/qwen3:8b");
});

test("a vendor whose key fails: it still switches with the state rejected; switching back to Ollama works again", async (t) => {
  const app = await boot(t, { settings: { mode: "local" }, stored: { custom: "custom-bad" } });
  await app.keys.loadAtStartup();
  assert.equal((await app.modes.setPolish(CUSTOM.polish, { customUrl: CUSTOM.customUrl })).ok, true);
  assert.deepEqual([app.keys.current.state, app.keys.current.cause], ["rejected", "key"]);
  assert.equal((await app.modes.setPolish("ollama")).ok, true);
  assert.equal(app.keys.current.state, "ready");
});
