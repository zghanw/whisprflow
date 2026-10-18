import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTranscribers } from "../../../src/cli/render/modes.mjs";
import { downloadSize, MODELS, measuredOn, tagsOn } from "../../../src/models/catalog.mjs";
import { plain } from "./fixtures.mjs";

const view = (chip, overrides = {}) => ({
  models: MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    bytes: downloadSize(model),
    installed: model.id === "qwen3-asr-0.6b-q8",
    // Like whisprflow transcriber: tags are picked for this kind of chip
    tags: tagsOn(model, chip),
    measured: measuredOn(model, chip),
  })),
  chip,
  setting: "qwen3-asr-0.6b-q8",
  source: "original",
  sources: ["original", "mirror"],
  current: "local",
  ...overrides,
});

test("on-device transcription models: one per line with tags and measurements for this chip below; it ends with the download source and how to change it", () => {
  const text = renderTranscribers(view("apple-silicon"), plain);
  assert.match(text, /● qwen3-asr-0\.6b-q8\s+Qwen3-ASR 0\.6B \(Q8_0\)\s+850 MB\s+downloaded/);
  assert.match(
    text,
    /\n\s+suits Apple silicon · Metal-accelerated · runs on CPU alone · strong on mixed Chinese and English\n/,
  );
  assert.match(text, /\n\s+Measured on Apple silicon \(Metal\): 4\.14\/5 · 68× real time · 2\.0 GB memory\n/);
  assert.match(text, /qwen3-asr-0\.6b-int8\s+Qwen3-ASR 0\.6B \(int8\)\s+987 MB\s+not downloaded/);
  assert.match(text, /Downloads from: Hugging Face/);
  assert.match(text, /whisprflow config set modelSource mirror/);
  assert.doesNotMatch(text, /aren't in use/);
});

test("unmeasured chips say so honestly; outside local mode it starts by saying they aren't in use", () => {
  const intel = renderTranscribers(view("intel-mac", { current: "native", source: "mirror" }), plain);
  assert.match(intel, /You're in native mode, so these aren't in use/);
  assert.match(intel, /Not yet measured on Intel Macs/);
  assert.match(intel, /Downloads from: Hugging Face mirror \(hf-mirror\.com\)/);
  assert.match(intel, /modelSource original/);
  // On Windows: tags and measurements are the Windows ones, with no Apple silicon or Metal
  const windows = renderTranscribers(view("windows-x64"), plain);
  assert.match(
    windows,
    /\n\s+suits Windows · GPU-accelerated \(Vulkan\) · runs on CPU alone · strong on mixed Chinese and English\n/,
  );
  assert.match(windows, /Measured on Windows \(x64\) \(Vulkan\): 4\.16\/5 · 73× real time · 0\.5 GB memory/);
  assert.doesNotMatch(windows, /Apple|Metal/);
});
