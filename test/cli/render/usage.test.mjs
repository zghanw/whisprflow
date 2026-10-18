import assert from "node:assert/strict";
import { test } from "node:test";
import { renderUsage } from "../../../src/cli/render/usage.mjs";
import { plain } from "./fixtures.mjs";

/** One period of the report (shaped like src/usage/report.mjs gives it) */
const period = (overrides = {}) => ({
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
  tokens: 0,
  latency: null,
  ...overrides,
});

const report = {
  today: period({
    calls: 12,
    dictations: 12,
    costUsd: 0.0191,
    tokens: 21_300,
    latency: { medianMs: 1600, p90Ms: 2400 },
  }),
  month: period({
    calls: 212,
    dictations: 210,
    costUsd: 0.31,
    tokens: 350_400,
    latency: { medianMs: 1700, p90Ms: 2600 },
  }),
  total: period({
    calls: 834,
    checks: 14,
    dictations: 820,
    inputTokens: 1_380_000,
    audioTokens: 120_000,
    cachedTokens: 0,
    outputTokens: 20_000,
    thinkingTokens: 0,
    costUsd: 1.24,
    tokens: 1_400_000,
    latency: { medianMs: 1700, p90Ms: 2600 },
  }),
  models: [
    {
      provider: "gemini",
      model: "gemini-3.6-flash",
      name: "Gemini",
      icon: "gemini",
      local: false,
      ...period({
        calls: 734,
        dictations: 720,
        costUsd: 1.1,
        tokens: 1_200_000,
        latency: { medianMs: 1700, p90Ms: 2500 },
      }),
    },
    {
      provider: "openai",
      model: "gpt-audio-mini-2025-12-15",
      name: "OpenAI",
      icon: "openai",
      local: false,
      ...period({
        calls: 100,
        dictations: 90,
        costUsd: 0.14,
        tokens: 200_000,
        latency: { medianMs: 2600, p90Ms: 3100 },
      }),
    },
  ],
};

const lines = (text) => text.split("\n").map((line) => line.trimEnd());

test("one row each for today, this month, and all time: cost, tokens, dictations, the usual and slow model reply, columns aligned", () => {
  const text = lines(renderUsage(report, plain));
  assert.match(text[0], /^Usage/);
  const rows = ["Today", "This month", "All time"].map((label) => text.find((line) => line.startsWith(`  ${label}`)));
  assert.match(rows[0], /Today\s+\$0\.019\s+21\.3K\s+12\s+usually 1\.6s, slow 2\.4s$/);
  assert.match(rows[1], /This month\s+\$0\.31\s+350K\s+210\s+usually 1\.7s, slow 2\.6s$/);
  assert.match(rows[2], /All time\s+\$1\.24\s+1\.4M\s+820\s+usually 1\.7s, slow 2\.6s$/);
  // The token column is right-aligned: the three rows end in the same column
  const ends = rows.map((row) => row.search(/\d(K|M)\s/));
  assert.equal(new Set(ends.map((end, i) => end + rows[i].match(/\d(K|M)\s/)[0].length)).size, 1);
});

test("all time split by model: vendor and model, cost, tokens, count, usual reply time", () => {
  const text = renderUsage(report, plain);
  assert.match(text, /By model/);
  assert.match(text, /Gemini gemini-3\.6-flash\s+\$1\.10\s+1\.2M\s+720 dictations\s+usually 1\.7s/);
  assert.match(text, /OpenAI gpt-audio-mini-2025-12-15\s+\$0\.14\s+200K\s+90 dictations\s+usually 2\.6s/);
});

test("it explains the token breakdown, that key checks are included, and that costs are standard-price estimates", () => {
  const text = renderUsage(report, plain);
  assert.match(text, /input 1\.38M \(audio 120K, cached 0\), output 20K \(thinking 0\)/);
  assert.match(text, /Includes 14 key checks/);
  assert.match(text, /standard price/);
  assert.match(text, /free tier/);
});

test("with prompt caching it says how much of the cost is the cache (creating and keeping it); without it, nothing", () => {
  const cached = { ...report, total: { ...report.total, cacheCostUsd: 0.021 } };
  assert.match(renderUsage(cached, plain), /\$0\.021 of the cost is prompt caching \(creating and keeping it\)/);
  assert.doesNotMatch(renderUsage(report, plain), /prompt caching/);
});

test("nothing said today: that row is zeros, with a dash for the wait", () => {
  const text = lines(renderUsage({ ...report, today: period() }, plain));
  assert.match(
    text.find((line) => line.startsWith("  Today")),
    /Today\s+\$0\s+0\s+0\s+-$/,
  );
});

test("models missing from the price list are named, and their cost isn't counted", () => {
  const unknown = {
    ...report,
    total: { ...report.total, unpricedCalls: 3 },
    models: [
      ...report.models,
      {
        provider: "gemini",
        model: "gemini-9-ultra",
        name: "Gemini",
        icon: "gemini",
        local: false,
        ...period({ calls: 3, dictations: 3, unpricedCalls: 3, tokens: 4000 }),
      },
    ],
  };
  const text = renderUsage(unknown, plain);
  assert.match(text, /gemini-9-ultra\s+price unknown/);
  assert.match(text, /Not in the price list: gemini-9-ultra\. Those 3 calls aren't counted/);
});

test("the on-device transcription step has its own row: marked on-device and free, with no tokens", () => {
  const local = {
    ...report,
    models: [
      ...report.models,
      {
        provider: "local",
        model: "qwen3-asr-0.6b-q8",
        name: "Qwen3-ASR 0.6B (Q8_0)",
        icon: "qwen",
        local: true,
        ...period({ calls: 40, dictations: 40, latency: { medianMs: 300, p90Ms: 500 } }),
      },
    ],
  };
  assert.match(
    renderUsage(local, plain),
    /Qwen3-ASR 0\.6B \(Q8_0\) \(on-device\)\s+free\s+-\s+40 dictations\s+usually 0\.3s/,
  );
});

test("with no usage yet it says so", () => {
  for (const empty of [null, { today: period(), month: period(), total: period(), models: [] }]) {
    assert.match(renderUsage(empty, plain), /No usage yet/);
  }
});
