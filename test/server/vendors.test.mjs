import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOUD_TRANSCRIBERS } from "../../src/server/asr/cloud/vendors.mjs";
import { CHAT_VENDORS } from "../../src/server/chat/vendors.mjs";
import { PROVIDERS } from "../../src/server/providers/index.mjs";
import { findVendor, VENDORS } from "../../src/server/vendors.mjs";

test("every vendor from every role is listed once; each has a name and a key variable, or null when it runs on this computer", () => {
  const ids = VENDORS.map(({ id }) => id);
  assert.deepEqual(ids, [...new Set([...PROVIDERS, ...CHAT_VENDORS, ...CLOUD_TRANSCRIBERS].map(({ id }) => id))]);
  for (const vendor of VENDORS) {
    assert.ok(vendor.name, vendor.id);
    assert.ok(vendor.keyEnv === null || /^[A-Z][A-Z0-9_]*$/.test(vendor.keyEnv), vendor.id);
  }
  assert.equal(findVendor("ollama").keyEnv, null);
});

test("a vendor registered in several roles has the same key variable and key page everywhere: merging keeps the first, and one key is stored", () => {
  for (const vendor of VENDORS) {
    for (const entry of [...PROVIDERS, ...CHAT_VENDORS, ...CLOUD_TRANSCRIBERS].filter(({ id }) => id === vendor.id)) {
      assert.equal(entry.keyEnv, vendor.keyEnv, vendor.id);
      assert.equal(entry.keyPage, vendor.keyPage, vendor.id);
    }
  }
});

test("lookup by id is case-insensitive; unknown ids are null", () => {
  assert.equal(findVendor("OpenAI").keyEnv, "OPENAI_API_KEY");
  assert.equal(findVendor("gemini").keyEnv, "GEMINI_API_KEY");
  assert.equal(findVendor("custom").keyPage, null);
  assert.equal(findVendor("nobody"), null);
});

test("every paid vendor has a price module that prices each listed model; vendors that run on this computer are free", async () => {
  const roles = { native: PROVIDERS, polish: CHAT_VENDORS, transcribe: CLOUD_TRANSCRIBERS };
  for (const [role, registry] of Object.entries(roles)) {
    // The custom service has no list and no known price
    for (const vendor of registry.filter(({ models }) => models.length > 0)) {
      if (vendor.keyEnv === null) {
        assert.equal(vendor.prices, null, `${role} ${vendor.id} runs locally and has no price`);
        continue;
      }
      assert.equal(typeof vendor.prices, "function", `${role} ${vendor.id} has no price module`);
      const { listPrice } = await vendor.prices();
      assert.equal(typeof listPrice, "function", `${role} ${vendor.id} price module has no listPrice`);
      for (const model of vendor.models) {
        assert.ok(listPrice(model.id), `${role} ${vendor.id}/${model.id} has no price`);
      }
    }
  }
});
