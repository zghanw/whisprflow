import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../src/i18n/index.mjs";
import {
  CHIPS,
  chipOf,
  DEFAULT_SOURCE,
  DEFAULT_TRANSCRIBER,
  downloadSize,
  downloadUrls,
  findModel,
  findSource,
  MODELS,
  measuredOn,
  SOURCES,
  TAGS,
  tagsOn,
} from "../../src/models/catalog.mjs";
import { backendText, measuredFacts, measuredText, nameParts, tagTexts } from "../../src/models/describe.mjs";
import { findEngine } from "../../src/server/asr/engines/index.mjs";

const CHIP_IDS = CHIPS.map(({ id }) => id);
const en = createTranslator("en");

test("catalog: ids are unique and use only lowercase letters, digits, dots, and hyphens (they are also directory names)", () => {
  const ids = MODELS.map((model) => model.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9.-]*$/);
  assert.equal(findModel(ids[0]), MODELS[0]);
  assert.equal(findModel("nope"), null);
  assert.ok(findModel(DEFAULT_TRANSCRIBER), "the default transcriber is in the catalog");
});

test("catalog: every file is a relative path in the repository with a size and sha256; origins are pinned to a commit", () => {
  for (const model of MODELS) {
    assert.match(model.origin.repo, /^[\w.-]+\/[\w.-]+$/, model.id);
    assert.match(model.origin.revision, /^[0-9a-f]{40}$/, model.id);
    if ("maxSeconds" in model) assert.ok(model.maxSeconds > 0, `${model.id} maxSeconds`);
    for (const file of Object.values(model.files)) {
      assert.match(file.path, /^[\w.-]+(\/[\w.-]+)*$/, `${model.id} ${file.path}`);
      assert.ok(!file.path.split("/").includes(".."), `${model.id} ${file.path}`);
      assert.match(file.sha256, /^[0-9a-f]{64}$/, `${model.id} ${file.path}`);
      assert.ok(Number.isInteger(file.size) && file.size > 0, `${model.id} ${file.path}`);
    }
  }
  const sizes = Object.values(MODELS[0].files).map((file) => file.size);
  assert.equal(
    downloadSize(MODELS[0]),
    sizes.reduce((a, b) => a + b, 0),
  );
});

test("catalog: licenses have a name and a text address, and the original author's repository is credited", () => {
  for (const model of MODELS) {
    assert.ok(model.license.name, model.id);
    assert.match(model.license.url, /^https:\/\//, model.id);
    assert.match(model.author, /^[\w.-]+\/[\w.-]+$/, model.id);
    if (model.origin.notice !== undefined) assert.match(model.origin.notice, /^[\w.-]+$/, model.id);
  }
});

test("catalog: each runtime is registered, knows the family, and every file its config asks for is in the catalog", async () => {
  for (const model of MODELS) {
    const engine = findEngine(model.engine);
    assert.ok(engine, `${model.id} runtime ${model.engine}`);
    const { FAMILIES } = await engine.load();
    assert.ok(FAMILIES[model.family], `${engine.name} knows ${model.family}`);
    const asked = [];
    FAMILIES[model.family].config((role) => {
      assert.ok(model.files[role], `${model.id} is missing ${role}`);
      asked.push(role);
      return `/models/${model.id}/${model.files[role].path}`;
    });
    assert.ok(asked.length > 0);
  }
});

test("tags follow measurements: every chip and backend tag has a matching entry in measured", () => {
  for (const model of MODELS) {
    for (const tag of model.tags) {
      assert.ok(Object.hasOwn(TAGS, tag), `${model.id} tag ${tag} is not registered`);
      if (TAGS[tag] === "chip") {
        assert.ok(CHIP_IDS.includes(tag), `${tag} is not in CHIPS`);
        assert.ok(
          model.measured.some(({ chip }) => chip === tag),
          `${model.id} is tagged ${tag} but was never measured on it`,
        );
      }
      if (TAGS[tag] === "backend") {
        assert.ok(
          model.measured.some(({ backend }) => backend === tag),
          `${model.id} is tagged ${tag} but never ran on it`,
        );
      }
    }
    for (const entry of model.measured) {
      assert.ok(CHIP_IDS.includes(entry.chip), `${model.id} measured chip ${entry.chip}`);
      assert.equal(TAGS[entry.backend], "backend", `${model.id} ${entry.backend} must be registered as a backend`);
      assert.ok(entry.score >= 0 && entry.score <= 5, `${model.id} score`);
      for (const name of ["p50Ms", "realtime", "peakMB"]) assert.ok(entry[name] > 0, `${model.id} ${name}`);
    }
  }
});

test("tags shown depend on this machine's chip: chip and backend tags measured elsewhere are not claimed; strengths are chip-independent", () => {
  const model = {
    tags: ["apple-silicon", "metal", "cpu", "zh-en"],
    measured: [
      { chip: "apple-silicon", backend: "metal" },
      { chip: "apple-silicon", backend: "cpu" },
      { chip: "windows-x64", backend: "cpu" },
    ],
  };
  assert.deepEqual(tagsOn(model, "apple-silicon"), ["apple-silicon", "metal", "cpu", "zh-en"]);
  assert.deepEqual(tagsOn(model, "windows-x64"), ["cpu", "zh-en"]);
  assert.deepEqual(tagsOn(model, null), ["zh-en"]);
});

test("device names from the runtime become backends: MTL0 is Metal, Vulkan0 is Vulkan, CPU is CPU, unknown ones stay as they are", () => {
  assert.equal(en.text(backendText("MTL0")), "Metal");
  assert.equal(en.text(backendText("Vulkan0")), "Vulkan");
  assert.equal(en.text(backendText("CPU")), "CPU");
  assert.equal(en.text(backendText("CUDA0")), "CUDA0");
});

test("on Windows (x64): the Q8 model is tagged for Windows, Vulkan, and CPU, never Apple silicon or Metal; the int8 one was measured too", () => {
  const model = findModel("qwen3-asr-0.6b-q8");
  const tags = tagsOn(model, "windows-x64");
  for (const tag of ["windows-x64", "vulkan", "cpu"]) assert.ok(tags.includes(tag), `${model.id} is missing ${tag}`);
  assert.ok(!tags.includes("apple-silicon") && !tags.includes("metal"), `${model.id}: ${tags}`);
  assert.equal(measuredOn(model, "windows-x64")[0].backend, "vulkan", `${model.id} is fastest on Vulkan on Windows`);
  assert.ok(measuredOn(findModel("qwen3-asr-0.6b-int8"), "windows-x64").length > 0);
});

test("every tag, chip, backend, and download source has wording", () => {
  for (const tag of Object.keys(TAGS)) assert.notEqual(en(`localModels.tags.${tag}`), `localModels.tags.${tag}`);
  for (const chip of CHIP_IDS) assert.notEqual(en(`localModels.chips.${chip}`), `localModels.chips.${chip}`);
  for (const [backend, kind] of Object.entries(TAGS)) {
    if (kind === "backend") assert.notEqual(en(`localModels.backends.${backend}`), `localModels.backends.${backend}`);
  }
  for (const { id } of SOURCES) assert.notEqual(en(`modelSources.${id}`), `modelSources.${id}`);
});

test("chips: Apple silicon, Intel Mac, and two Windows kinds; anything else is null", () => {
  assert.equal(chipOf("darwin", "arm64"), "apple-silicon");
  assert.equal(chipOf("darwin", "x64"), "intel-mac");
  assert.equal(chipOf("win32", "x64"), "windows-x64");
  assert.equal(chipOf("win32", "arm64"), "windows-arm64");
  assert.equal(chipOf("linux", "x64"), null);
});

test("measurements on a chip: fastest first, written as one sentence; unmeasured and unknown chips say so", () => {
  const q8 = findModel("qwen3-asr-0.6b-q8");
  const measured = measuredOn(q8, "apple-silicon");
  assert.deepEqual(
    measured.map(({ backend }) => backend),
    ["metal", "cpu"],
  );
  assert.equal(
    en.text(measuredText(measured, "apple-silicon")),
    "Measured on Apple silicon (Metal): 4.14/5 · 68× real time · 2.0 GB memory",
  );
  assert.equal(
    en.text(measuredText(measuredOn(q8, "windows-x64"), "windows-x64")),
    "Measured on Windows (x64) (Vulkan): 4.16/5 · 73× real time · 0.5 GB memory",
  );
  assert.deepEqual(measuredOn(q8, "intel-mac"), []);
  assert.equal(en.text(measuredText([], "intel-mac")), "Not yet measured on Intel Macs");
  assert.equal(en.text(measuredText([], null)), "Not yet measured on this kind of machine");
  assert.deepEqual(
    tagTexts(["metal", "zh-en"]).map((text) => en.text(text)),
    ["Metal-accelerated", "strong on mixed Chinese and English"],
  );
});

test("the app's model list splits measurements into three figures plus where they were measured; unmeasured has only that line", () => {
  const facts = measuredFacts(measuredOn(findModel("qwen3-asr-0.6b-q8"), "apple-silicon"), "apple-silicon");
  assert.deepEqual(
    facts.figures.map(({ value, unit, label }) => [value, unit, en.text(label)]),
    [
      ["4.14", "/5", "score"],
      ["68", "×", "speed"],
      ["2.0", "GB", "memory"],
    ],
  );
  assert.equal(en.text(facts.where), "Measured on Apple silicon · Metal");
  const untested = measuredFacts([], "windows-x64");
  assert.deepEqual(untested.figures, []);
  assert.equal(en.text(untested.where), "Not yet measured on Windows (x64)");
  assert.equal(en.text(measuredFacts([], null).where), "Not yet measured on this kind of machine");
});

test("a model name splits into name and quantization; without parentheses the whole thing is the name", () => {
  assert.deepEqual(nameParts("Qwen3-ASR 0.6B (Q8_0)"), { base: "Qwen3-ASR 0.6B", variant: "Q8_0" });
  assert.deepEqual(nameParts("Qwen3-ASR 0.6B (int8)"), { base: "Qwen3-ASR 0.6B", variant: "int8" });
  assert.deepEqual(nameParts("Whisper"), { base: "Whisper", variant: null });
  for (const { name } of MODELS) assert.notEqual(nameParts(name).variant, null, name);
});

test("download sources: Hugging Face first by default, the mirror as fallback; choosing the mirror reverses them. Files are checked by sha256 either way", () => {
  assert.ok(findSource(DEFAULT_SOURCE));
  assert.equal(new Set(SOURCES.map(({ id }) => id)).size, SOURCES.length);
  const model = findModel("qwen3-asr-0.6b-q8");
  const file = model.files.gguf;
  const { revision, repo } = model.origin;
  const hf = `https://huggingface.co/${repo}/resolve/${revision}/Qwen3-ASR-0.6B-Q8_0.gguf`;
  const mirror = `https://hf-mirror.com/${repo}/resolve/${revision}/Qwen3-ASR-0.6B-Q8_0.gguf`;
  assert.deepEqual(downloadUrls(model, file), [hf, mirror]);
  assert.deepEqual(downloadUrls(model, file, "mirror"), [mirror, hf]);
  assert.throws(() => downloadUrls(model, file, "ftp"), /ftp.*original \/ mirror/);
});
