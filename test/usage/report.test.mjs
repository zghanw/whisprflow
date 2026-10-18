import assert from "node:assert/strict";
import { test } from "node:test";
import { percentile, usageReport } from "../../src/usage/report.mjs";

const totals = (overrides = {}) => ({
  calls: 0,
  checks: 0,
  dictations: 0,
  inputTokens: 0,
  audioTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  costUsd: 0,
  unpricedCalls: 0,
  latenciesMs: [],
  ...overrides,
});

/** Fake history store: records which moment each query starts from and answers a different total per moment */
function fakeHistory(bySince) {
  const asked = [];
  return {
    asked,
    usage({ since = "" } = {}) {
      asked.push(since);
      return bySince[since] ?? { ...totals(), models: [] };
    },
  };
}

test("percentile: taken from a list sorted fast to slow, nearest rank; empty is null", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([1700], 0.9), 1700);
  assert.equal(percentile([1000, 2000, 3000, 4000], 0.5), 2000);
  const tenth = Array.from({ length: 10 }, (_, i) => (i + 1) * 100);
  assert.equal(percentile(tenth, 0.9), 900);
  assert.equal(percentile(tenth, 0.5), 500);
});

test("today starts at local midnight, this month at midnight on the 1st, all time has no start", () => {
  const history = fakeHistory({});
  usageReport(history, { now: new Date(2026, 9, 14, 15, 30) });
  assert.deepEqual(
    history.asked.sort(),
    ["", new Date(2026, 9, 1).toISOString(), new Date(2026, 9, 14).toISOString()].sort(),
  );
});

test("each period gives the token total, the usual answer time (median) and the slow one (90% are faster); the top-level per-model split is all time", () => {
  const all = {
    ...totals({
      calls: 12,
      checks: 2,
      dictations: 10,
      inputTokens: 15_000,
      audioTokens: 2_500,
      outputTokens: 400,
      costUsd: 0.012,
      latenciesMs: [1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 5000],
    }),
    models: [
      {
        provider: "gemini",
        model: "gemini-3.6-flash",
        ...totals({ calls: 12, dictations: 10, costUsd: 0.012, latenciesMs: [1000, 5000] }),
      },
    ],
  };
  const report = usageReport(fakeHistory({ "": all }), { now: new Date(2026, 9, 14, 15, 30) });

  const { latenciesMs: _raw, models: _models, ...expectedTotals } = all;
  const { models: _totalModels, ...reportedTotals } = report.total;
  assert.deepEqual(reportedTotals, {
    ...expectedTotals,
    tokens: 15_400,
    latency: { medianMs: 1400, p90Ms: 1800 },
  });
  // No calls yet today: the wait can't be stated, so it is null rather than 0 seconds
  assert.equal(report.today.calls, 0);
  assert.equal(report.today.latency, null);
  assert.deepEqual(
    report.models.map(({ provider, model, latency, latenciesMs }) => ({ provider, model, latency, latenciesMs })),
    [
      {
        provider: "gemini",
        model: "gemini-3.6-flash",
        latency: { medianMs: 1000, p90Ms: 5000 },
        latenciesMs: undefined,
      },
    ],
  );
});

test("each period splits by model, each row says whose it is and whether it ran on-device; the icon follows the vendor", () => {
  const now = new Date(2026, 9, 14, 15, 30);
  const month = {
    ...totals({ calls: 5, dictations: 2 }),
    models: [
      {
        provider: "gemini",
        model: "gemini-3.6-flash",
        ...totals({ calls: 2, dictations: 2, costUsd: 0.0002, latenciesMs: [900, 1200] }),
      },
      { provider: "local", model: "qwen3-asr-0.6b-q8", ...totals({ calls: 2, dictations: 2, latenciesMs: [300] }) },
      { provider: "local", model: "gone-model", ...totals({ calls: 1, dictations: 1 }) },
      { provider: "someone", model: "x", ...totals({ calls: 1 }) },
    ],
  };
  const report = usageReport(fakeHistory({ [new Date(2026, 9, 1).toISOString()]: month }), { now });
  assert.deepEqual(
    report.month.models.map(({ name, icon, local, model, latency }) => ({ name, icon, local, model, latency })),
    [
      {
        name: "Gemini",
        icon: "gemini",
        local: false,
        model: "gemini-3.6-flash",
        latency: { medianMs: 900, p90Ms: 1200 },
      },
      {
        name: "Qwen3-ASR 0.6B (Q8_0)",
        icon: "qwen",
        local: true,
        model: "qwen3-asr-0.6b-q8",
        latency: { medianMs: 300, p90Ms: 300 },
      },
      // An on-device model no longer in the catalog: named by its id
      { name: "gone-model", icon: null, local: true, model: "gone-model", latency: null },
      { name: "someone", icon: "someone", local: false, model: "x", latency: null },
    ],
  );
  assert.deepEqual(report.today.models, []);
  // The all-time split is also kept at the top level
  assert.equal(report.models, report.total.models);
});
