import assert from "node:assert/strict";
import { test } from "node:test";
import { costPerDictation, estimateTime, MONTHLY_DICTATIONS, monthlyCost, TYPICAL } from "../../src/usage/estimate.mjs";

// Monthly cost basis: 100 dictations a day, 30 days a month, each using typical-dictation usage; prices come from each vendor's price module (faked here).

/** Fake price lookup: records who was asked with what usage, answers a fixed price per role */
function fakeCosts(prices) {
  const asked = [];
  const costOf = (role, vendor, model, usage, at) => {
    asked.push({ role, vendor, model, usage, at });
    return prices[`${role} ${vendor}/${model}`] ?? null;
  };
  return { asked, costOf };
}

const AT = new Date("2026-10-19T02:30:00Z");
const local = (polish) => ({ mode: "local", transcriber: "qwen3-asr-0.6b-q8", polish });

test("basis: 100 a day, 30 days a month", () => {
  assert.equal(MONTHLY_DICTATIONS, 3000);
});

test("on-device transcription plus Ollama cleanup is free, and no price is looked up", () => {
  const { asked, costOf } = fakeCosts({});
  const route = local({ vendor: "ollama", model: "qwen3:4b-instruct" });
  assert.equal(costPerDictation(route, costOf, AT), 0);
  assert.equal(monthlyCost(route, costOf, AT), 0);
  assert.equal(asked.length, 0);
});

test("native: uses that vendor's typical usage; private mode costs nothing and looks up no price", () => {
  const { asked, costOf } = fakeCosts({ "native gemini/gemini-3.6-flash": 0.0005 });
  const native = { mode: "native", model: { provider: "gemini", model: "gemini-3.6-flash" } };
  assert.equal(costPerDictation(native, costOf, AT), 0.0005);
  assert.equal(asked[0].usage, TYPICAL.native.gemini);
  assert.equal(Math.round(monthlyCost(native, costOf, AT) * 100) / 100, 1.5);

  const quiet = fakeCosts({});
  assert.equal(monthlyCost({ mode: "private", transcriber: "qwen3-asr-0.6b-q8" }, quiet.costOf, AT), 0);
  assert.equal(quiet.asked.length, 0);
});

test("when it can't be computed it is null, never made up: unmeasured vendor, missing price, custom service", () => {
  const { costOf } = fakeCosts({});
  const unmeasured = { mode: "native", model: { provider: "openai", model: "gpt-audio" } };
  assert.equal(costPerDictation(unmeasured, costOf, AT), null, "OpenAI native usage was never measured");
  const unpriced = { mode: "native", model: { provider: "gemini", model: "gemini-3.6-flash" } };
  assert.equal(costPerDictation(unpriced, costOf, AT), null, "not in the price list");
  assert.equal(
    costPerDictation(local({ vendor: "custom", model: "x" }), costOf, AT),
    null,
    "a custom service has no price",
  );
  assert.equal(monthlyCost(local({ vendor: "custom", model: "x" }), costOf, AT), null);
});

test("estimates are priced at 02:30 UTC on a weekday: weekends move to Monday, and the hour of day doesn't change the figure", () => {
  // 2026-10-17 is a Saturday
  assert.equal(estimateTime(new Date("2026-10-17T15:00:00Z")).toISOString(), "2026-10-19T02:30:00.000Z");
  assert.equal(estimateTime(new Date("2026-10-19T23:59:00Z")).toISOString(), "2026-10-19T02:30:00.000Z");
  assert.equal(estimateTime(new Date("2026-10-20T00:01:00Z")).toISOString(), "2026-10-20T02:30:00.000Z");
});
