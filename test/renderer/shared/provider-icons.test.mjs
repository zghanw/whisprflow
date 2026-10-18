import assert from "node:assert/strict";
import { test } from "node:test";
import { MODELS, makerOf } from "../../../src/models/catalog.mjs";
import { PROVIDER_ICON_PATHS } from "../../../src/renderer/shared/provider-icons.mjs";
import { CHAT_VENDORS } from "../../../src/server/chat/vendors.mjs";
import { PROVIDERS } from "../../../src/server/providers/index.mjs";

const PATH = /^[Mm][\d.\s,a-zA-Z-]+z?$/;
/** One path, or layers of { d, opacity, rule } */
const isIcon = (icon) =>
  typeof icon === "string"
    ? PATH.test(icon)
    : Array.isArray(icon) && icon.length > 0 && icon.every(({ d }) => PATH.test(d));

test("every model vendor has an icon: a newly added vendor never shows as a bare name in settings and onboarding", () => {
  for (const { id } of PROVIDERS) assert.ok(isIcon(PROVIDER_ICON_PATHS[id]), id);
});

test("every cleanup vendor has an icon too; the custom service uses a generic one", () => {
  for (const { id, models } of CHAT_VENDORS) {
    assert.ok(isIcon(PROVIDER_ICON_PATHS[id]), id);
    // One platform can host models from several makers; the icon follows the maker
    for (const { maker } of models) assert.ok(isIcon(PROVIDER_ICON_PATHS[maker]), `${maker} on ${id}`);
  }
});

test("on-device models get their maker's icon: the organization name of the author's repository", () => {
  assert.equal(makerOf(MODELS.find(({ id }) => id === "qwen3-asr-0.6b-q8")), "qwen");
  for (const model of MODELS) assert.ok(isIcon(PROVIDER_ICON_PATHS[makerOf(model)]), model.id);
});
