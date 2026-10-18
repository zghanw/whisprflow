import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, describePlaza, loadPriceBook } from "../../src/app/model-plaza.mjs";
import { presetsFor } from "../../src/models/presets.mjs";
import { CLOUD_TRANSCRIBERS } from "../../src/server/asr/cloud/vendors.mjs";
import { CHAT_VENDORS } from "../../src/server/chat/vendors.mjs";
import { PROVIDERS } from "../../src/server/providers/index.mjs";
import { patchSettings, resolveSettings, routeOf } from "../../src/storage/settings.mjs";

const view = async (overrides = {}) =>
  describePlaza({
    mode: "local",
    chosen: { native: DEFAULTS.native, transcriber: DEFAULTS.transcribe, polish: DEFAULTS.polish, customUrl: "" },
    keys: { gemini: "env" },
    status: { "qwen3-asr-0.6b-q8": { installed: true, download: null, partial: 0, problem: null } },
    chip: "apple-silicon",
    freeBytes: 446e9,
    prices: await loadPriceBook(),
    routes: routesWith({}),
    presets: [],
    at: new Date("2026-10-19T02:30:00Z"),
    ...overrides,
  });

const settingsWith = (changes) =>
  patchSettings(resolveSettings({ file: "/nonexistent/settings.json", env: {} }), changes);

/** The route each mode takes with factory settings plus changes (as in the main process: routeOf in storage/settings.mjs) */
function routesWith(changes) {
  const settings = settingsWith(changes);
  return Object.fromEntries(["native", "local", "private"].map((mode) => [mode, routeOf(settings, mode)]));
}

/** Presets that suit this chip, each with the route after applying its settings (as in the main process) */
const presetsWith = (changes, chip) =>
  presetsFor(chip).map((preset) => ({
    preset,
    route: routeOf(settingsWith({ ...changes, ...preset.settings }), preset.mode),
  }));

const group = (shelf, id) => shelf.find((found) => found.id === id);

test("cleanup models are grouped by maker with the platform as the channel; Ollama's default is free and the custom service comes last", async () => {
  const { shelves } = await view();
  const qwen = group(shelves.polish, "qwen");
  assert.deepEqual(qwen.channels, ["ollama"]);
  const instruct = qwen.items.find(({ name }) => name === "Qwen3 4B Instruct");
  assert.equal(instruct.offers.ollama.choice, "ollama/qwen3:4b-instruct");
  // Runs on this computer: no price
  assert.equal(instruct.offers.ollama.price, null);
  // The factory default, evaluated
  assert.deepEqual(
    instruct.tags.map(({ kind }) => kind),
    ["default", "tested"],
  );
  assert.equal(shelves.polish.at(-1).kind, "custom");
});

test("native: known issues become tags; prices are in USD", async () => {
  const { shelves } = await view();
  const openai = group(shelves.native, "openai");
  assert.deepEqual(openai.items.find(({ name }) => name === "GPT Audio 1.5").tags, [
    { kind: "issue", issue: "jsonWrapped" },
  ]);
  const flash = group(shelves.native, "gemini").items[0];
  assert.equal(flash.offers.gemini.price.currency, "USD");
});

test("transcription: the on-device group with specs from the fastest measurement on this chip and download state", async () => {
  const { shelves } = await view();
  const [local] = shelves.transcribe;
  assert.equal(local.kind, "local");
  const q8 = local.items.find(({ choice }) => choice === "qwen3-asr-0.6b-q8");
  assert.equal(q8.name, "Qwen3-ASR 0.6B");
  assert.equal(q8.variant, "Q8_0");
  assert.equal(q8.backend, "metal");
  assert.equal(q8.installed, true);
  assert.equal(q8.specs.zh, 4.32);
  assert.ok(Math.abs(q8.specs.minuteSeconds - 60 / 67.5) < 1e-9);
  assert.deepEqual(
    q8.tags.map(({ kind }) => kind),
    ["default"],
  );
  // Models not installed are still listed, marked as not installed
  assert.equal(local.items.find(({ choice }) => choice === "qwen3-asr-0.6b-int8").installed, false);
});

test("the key table: one row per platform with where its key is and how many models it has on each shelf; Ollama first, custom last", async () => {
  const { platforms } = await view();
  assert.deepEqual(
    platforms.map(({ id }) => id),
    ["ollama", "gemini", "openai", "custom"],
  );
  const ollama = platforms[0];
  assert.equal(ollama.keyEnv, null);
  assert.deepEqual(ollama.coverage, { native: 0, transcribe: 0, polish: 1 });
  assert.equal(platforms.find(({ id }) => id === "gemini").key, "env");
  assert.equal(platforms.find(({ id }) => id === "openai").key, null);
});

test("models never called with a real key are marked unverified on that channel's offer, not as a tag on the row", async () => {
  const { shelves } = await view();
  const registries = { transcribe: CLOUD_TRANSCRIBERS, polish: CHAT_VENDORS, native: PROVIDERS };
  let offers = 0;
  for (const [role, registry] of Object.entries(registries)) {
    const listed = new Map(registry.flatMap((v) => v.models.map((m) => [`${v.id}/${m.id}`, Boolean(m.unverified)])));
    for (const item of shelves[role].filter(({ kind }) => kind === "cloud").flatMap(({ items }) => items)) {
      // Unverified follows the channel, not the row: the same model sold elsewhere may be verified
      assert.ok(!item.tags.some(({ kind }) => kind === "unverified"), item.name);
      for (const offer of Object.values(item.offers)) {
        assert.equal(offer.unverified, listed.get(offer.choice), offer.choice);
        offers += 1;
      }
    }
  }
  assert.ok(offers >= 4);
});

test("the three modes: which models the audio passes through (names from the catalog), and what is still missing before switching (keys, downloads)", async () => {
  const { ways } = await view({
    routes: routesWith({ model: "openai", privateTranscriber: "qwen3-asr-0.6b-int8" }),
    keys: {},
  });
  const openai = PROVIDERS.find(({ id }) => id === "openai");
  assert.deepEqual(ways.native.hops, [
    {
      role: "native",
      platform: "openai",
      maker: "openai",
      name: openai.models.find(({ id }) => id === openai.defaultModel).name,
    },
  ]);
  assert.deepEqual(ways.native.needs, [{ kind: "key", platform: "openai" }]);

  // On-device transcription, then Ollama: nothing missing, no key needed
  assert.deepEqual(
    ways.local.hops.map(({ role, platform }) => [role, platform]),
    [
      ["transcribe", "local"],
      ["polish", "ollama"],
    ],
  );
  assert.deepEqual(ways.local.needs, []);

  // Private: no key, only whether the on-device model is downloaded
  assert.deepEqual(
    ways.private.hops.map(({ role, platform }) => [role, platform]),
    [["transcribe", "local"]],
  );
  assert.deepEqual(ways.private.needs, [{ kind: "download", model: "qwen3-asr-0.6b-int8" }]);
});

test("needs is empty when a mode lacks nothing; a custom service without an address counts as missing", async () => {
  const ready = await view();
  assert.deepEqual(ready.ways.local.needs, []);
  assert.deepEqual(ready.ways.private.needs, []);
  assert.deepEqual(ready.ways.native.needs, []);

  const custom = await view({ routes: routesWith({ polish: "custom/my-model" }), keys: { custom: "stored" } });
  assert.deepEqual(custom.ways.local.needs, [{ kind: "url" }]);
  assert.deepEqual(custom.ways.local.hops[1], { role: "polish", platform: "custom", maker: null, name: "my-model" });
});

test("a mode whose settings can't build a route reports the reason honestly", async () => {
  const { ways } = await view({ routes: { ...routesWith({}), local: { problem: { key: "chat.modelRequired" } } } });
  assert.deepEqual(ways.local, { problem: { key: "chat.modelRequired" }, hops: [], needs: [] });
});

test("presets: those suiting this machine in recommended order, each with its models, what's missing, and the monthly cost; the active one is marked", async () => {
  const current = { transcriber: "qwen3-asr-0.6b-q8", polish: "ollama/qwen3:4b-instruct" };
  const { presets } = await view({
    mode: "local",
    routes: routesWith(current),
    presets: presetsWith(current, "apple-silicon"),
    keys: {},
  });
  assert.deepEqual(
    presets.map(({ id }) => id),
    ["local-qwen", "native-gemini", "private-qwen"],
  );
  const [local, native, privately] = presets;

  assert.equal(local.active, true);
  assert.deepEqual(local.needs, []);
  assert.deepEqual(
    local.hops.map(({ role, platform }) => [role, platform]),
    [
      ["transcribe", "local"],
      ["polish", "ollama"],
    ],
  );
  assert.deepEqual(local.monthly, { usd: 0 });

  assert.equal(native.active, false);
  assert.deepEqual(native.needs, [{ kind: "key", platform: "gemini" }]);
  assert.deepEqual(native.settings, { model: "gemini/gemini-3.6-flash" });
  assert.ok(native.monthly.usd > 0);

  assert.equal(privately.monthly.usd, 0);
  assert.equal(privately.active, false, "private is not in use");
});

test("presets follow the chip: Intel Macs get the CPU build of the on-device model", async () => {
  const { presets } = await view({ presets: presetsWith({}, "intel-mac") });
  assert.deepEqual(
    presets.map(({ id }) => id),
    ["native-gemini", "local-qwen-cpu", "private-qwen-cpu"],
  );
});
