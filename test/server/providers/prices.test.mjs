import assert from "node:assert/strict";
import { test } from "node:test";
import { costOf as geminiCost, storageCostOf } from "../../../src/server/providers/prices/gemini.mjs";
import { costOf as openaiCost } from "../../../src/server/providers/prices/openai.mjs";

const OCT = new Date("2026-10-14T08:00:00Z");
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≠ ${expected}`);

// A real dictation request (measured 2026-10-14): a 1365-token text system prompt, 25 audio tokens for 1 s of audio, 4 tokens back
const DICTATION = { text: 1365, audio: 25, cachedText: 0, cachedAudio: 0, output: 4 };

test("Gemini 3.6 Flash: one input price for text and audio, one output price; doubled from 2027", () => {
  close(geminiCost("gemini-3.6-flash", DICTATION, OCT), (1390 * 0.75 + 4 * 3.75) / 1e6);
  close(geminiCost("gemini-3.6-flash", DICTATION, new Date("2026-12-31T23:59:59Z")), (1390 * 0.75 + 4 * 3.75) / 1e6);
  close(geminiCost("gemini-3.6-flash", DICTATION, new Date("2027-01-01T00:00:00Z")), (1390 * 1.5 + 4 * 7.5) / 1e6);
});

test("Gemini models priced separately: audio costs more than text; cache hits use the cache price, audio and text apart", () => {
  close(geminiCost("gemini-2.5-flash", DICTATION, OCT), (1365 * 0.3 + 25 * 1 + 4 * 2.5) / 1e6);
  const cached = { text: 1365, audio: 25, cachedText: 1024, cachedAudio: 25, output: 4 };
  close(geminiCost("gemini-2.5-flash", cached, OCT), (341 * 0.3 + 1024 * 0.03 + 25 * 0.1 + 4 * 2.5) / 1e6);
});

test("Gemini Pro: a prompt over 200K tokens prices the whole call at the higher tier", () => {
  const short = { text: 200_000, audio: 0, cachedText: 0, cachedAudio: 0, output: 1000 };
  const long = { ...short, text: 200_001 };
  close(geminiCost("gemini-2.5-pro", short, OCT), (200_000 * 1.25 + 1000 * 10) / 1e6);
  close(geminiCost("gemini-2.5-pro", long, OCT), (200_001 * 2.5 + 1000 * 15) / 1e6);
});

test("retired Gemini models whose requests are redirected price as the target; models missing from the list are null", () => {
  assert.equal(geminiCost("gemini-3.5-flash", DICTATION, OCT), geminiCost("gemini-3.6-flash", DICTATION, OCT));
  assert.equal(geminiCost("gemini-3.7-flash", DICTATION, OCT), geminiCost("gemini-3.8-flash", DICTATION, OCT));
  assert.equal(geminiCost("gemini-9-ultra", DICTATION, OCT), null);
});

test("Gemini explicit cache storage: by cached tokens and time, per million tokens per hour; Flash doubles from 2027 too", () => {
  // 1350 tokens cached for half an hour
  close(storageCostOf("gemini-3.6-flash", 1350, 0.5, OCT), (1350 * 0.5 * 0.5) / 1e6);
  close(storageCostOf("gemini-3.6-flash", 1350, 0.5, new Date("2027-01-01T00:00:00Z")), (1350 * 1 * 0.5) / 1e6);
  close(storageCostOf("gemini-2.5-pro", 1000, 2, OCT), (1000 * 4.5 * 2) / 1e6);
  // Models without explicit caching (4 Argon has only implicit caching) and models missing from the list: can't be computed
  assert.equal(storageCostOf("gemini-4-argon", 1350, 1, OCT), null);
  assert.equal(storageCostOf("gemini-9-ultra", 1350, 1, OCT), null);
});

test("OpenAI gpt-audio: separate text and audio prices, input and output apart; dated snapshot names in replies price as the model", () => {
  // Measured: gpt-audio-mini replies as gpt-audio-mini-2025-12-15, with 1522 text tokens, 10 audio tokens, 4 back
  const tokens = { text: 1522, audio: 10, textOutput: 4, audioOutput: 0 };
  const expected = (1522 * 0.6 + 10 * 10 + 4 * 2.4) / 1e6;
  close(openaiCost("gpt-audio-mini-2025-12-15", tokens), expected);
  close(openaiCost("gpt-audio-mini", tokens), expected);
  close(
    openaiCost("gpt-audio-1.5", { text: 1000, audio: 100, textOutput: 10, audioOutput: 5 }),
    (1000 * 2.5 + 100 * 32 + 10 * 10 + 5 * 64) / 1e6,
  );
  assert.equal(openaiCost("gpt-9-audio", tokens), null);
});
