import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPriceBook } from "../../src/app/model-plaza.mjs";
import { findLocale } from "../../src/i18n/index.mjs";
import { CHIPS, findModel } from "../../src/models/catalog.mjs";
import { PRESETS, presetsFor } from "../../src/models/presets.mjs";
import { CLOUD_TRANSCRIBERS, cloudTranscriberOf } from "../../src/server/asr/cloud/vendors.mjs";
import { CHAT_VENDORS } from "../../src/server/chat/vendors.mjs";
import { MODES } from "../../src/server/modes.mjs";
import { PROVIDERS } from "../../src/server/providers/index.mjs";
import { MODE_SETTINGS, patchSettings, resolveSettings, routeOf } from "../../src/storage/settings.mjs";
import { estimateTime, monthlyCost } from "../../src/usage/estimate.mjs";

// Rules for the recommended setups (src/models/presets.mjs): adding or removing one touches only that table and its wording; this file checks the rest.
// It names the preset whose model was delisted, which carries a setting outside its mode, whose monthly cost can't be computed, or which lacks wording.

const DEFAULT_SETTINGS = resolveSettings({ file: "/nonexistent/settings.json", env: {} });
const routeOfPreset = ({ mode, settings }) => routeOf(patchSettings(DEFAULT_SETTINGS, settings), mode);

/** Listed in the registry and called with a real key (not unverified) */
function listed(registry, vendor, model) {
  return (
    registry.find(({ id }) => id === vendor)?.models.find((entry) => entry.id === model && !entry.unverified) ?? null
  );
}

test("ids are unique; the mode is one of three; settings belong to that mode (mode switching only takes those)", () => {
  assert.equal(new Set(PRESETS.map(({ id }) => id)).size, PRESETS.length);
  for (const preset of PRESETS) {
    assert.ok(
      MODES.some(({ id }) => id === preset.mode),
      `${preset.id}: unknown mode ${preset.mode}`,
    );
    for (const name of Object.keys(preset.settings)) {
      assert.ok(MODE_SETTINGS[preset.mode].includes(name), `${preset.id}: ${name} does not belong to ${preset.mode}`);
    }
  }
});

test("referenced models are listed and were called with a real key; chips are known ones", () => {
  for (const preset of PRESETS) {
    const route = routeOfPreset(preset);
    if (route.mode === "native") {
      assert.ok(listed(PROVIDERS, route.model.provider, route.model.model), `${preset.id}: native model not listed`);
    } else {
      const cloud = cloudTranscriberOf(route.transcriber);
      assert.ok(
        cloud ? listed(CLOUD_TRANSCRIBERS, cloud.vendor, cloud.model) : findModel(route.transcriber),
        `${preset.id}: transcriber ${route.transcriber} not listed`,
      );
      if (route.mode === "local") {
        assert.ok(
          listed(CHAT_VENDORS, route.polish.vendor, route.polish.model),
          `${preset.id}: cleanup model not listed (a custom service can't be a recommended setup)`,
        );
      }
    }
    for (const chip of preset.chips ?? []) {
      assert.ok(
        CHIPS.some(({ id }) => id === chip),
        `${preset.id}: unknown chip ${chip}`,
      );
    }
  }
});

test("every chip with a release build has on-device presets (one private, one on-device transcription plus cleanup)", () => {
  // Release builds exist for these chips; Windows on ARM has none
  for (const chip of ["apple-silicon", "intel-mac", "windows-x64"]) {
    const ours = presetsFor(chip);
    assert.ok(
      ours.some(({ mode }) => mode === "private"),
      `${chip}: no private mode preset`,
    );
    assert.ok(
      ours.some(({ mode, settings }) => mode === "local" && findModel(settings.transcriber)),
      `${chip}: no on-device transcription plus cleanup preset`,
    );
  }
});

test("every preset has a computable monthly cost (an unmeasured vendor needs its typical usage in usage/estimate.mjs first)", async () => {
  const { costOf } = await loadPriceBook();
  const at = estimateTime(new Date("2026-10-19T00:00:00Z"));
  for (const preset of PRESETS) {
    const cost = monthlyCost(routeOfPreset(preset), costOf, at);
    assert.ok(cost !== null && cost >= 0, `${preset.id}: monthly cost can't be computed`);
  }
});

test("every preset has a name and description, and no wording is left for a removed preset", () => {
  const ids = PRESETS.map(({ id }) => id).sort();
  for (const locale of ["en"]) {
    const texts = findLocale(locale).messages.presets?.items ?? {};
    for (const id of ids) {
      assert.equal(typeof texts[id]?.name, "string", `${locale} is missing presets.${id}.name`);
      assert.equal(typeof texts[id]?.desc, "string", `${locale} is missing presets.${id}.desc`);
    }
    const extra = Object.keys(texts).filter((key) => !ids.includes(key));
    assert.deepEqual(extra, [], `${locale} has wording for presets that don't exist`);
  }
});
