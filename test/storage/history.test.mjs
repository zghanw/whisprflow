import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { createTranslator } from "../../src/i18n/index.mjs";
import { openHistory } from "../../src/storage/history.mjs";

const en = createTranslator("en");
/** The user-facing sentence in the error, as translated */
const said = (pattern) => (error) => pattern.test(en.text(error.problem ?? error.message));

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "whisprflow-history-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (overrides = {}) => ({
  id: "a1",
  status: "completed",
  refinedText: "We meet on Friday.",
  error: null,
  duration: 4.2,
  audioLocalPath: "/tmp/a1.webm",
  createdAt: "2026-10-13T08:00:00.000Z",
  ...overrides,
});

test("saved entries read back as they were, newest first; a missing directory is created", () => {
  const history = openHistory(join(dir, "nested", "history.db"));
  history.add(entry());
  history.add(
    entry({
      id: "a2",
      status: "failed",
      refinedText: "",
      error: "The server did not respond",
      createdAt: "2026-10-13T09:00:00.000Z",
    }),
  );
  // Entries never billed (failed before reaching a model, or saved before billing existed) have null usage
  assert.deepEqual(history.list(), [
    {
      ...entry({
        id: "a2",
        status: "failed",
        refinedText: "",
        error: "The server did not respond",
        createdAt: "2026-10-13T09:00:00.000Z",
      }),
      usage: null,
    },
    { ...entry(), usage: null },
  ]);
  assert.equal(history.list({ limit: 1 }).length, 1);
  history.close();
});

test("closing and reopening keeps the entries and does not create the tables again", () => {
  const path = join(dir, "history.db");
  const first = openHistory(path);
  first.add(entry());
  first.close();
  const second = openHistory(path);
  assert.equal(second.list().length, 1);
  second.close();
});

test("a recording can not be saved twice; status is only completed or failed", () => {
  const history = openHistory(join(dir, "history.db"));
  history.add(entry());
  assert.throws(() => history.add(entry()), /UNIQUE|constraint/i);
  assert.throws(() => history.add(entry({ id: "a3", status: "pending" })), /CHECK|constraint/i);
  history.close();
});

test("a database newer than the program is refused and left alone", () => {
  const path = join(dir, "history.db");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA user_version = 99");
  db.close();
  assert.throws(() => openHistory(path), said(/version 99/));
});

test("statistics count only completed dictations, optionally after a moment", () => {
  const history = openHistory(join(dir, "history.db"));
  history.add(entry({ id: "a", createdAt: "2026-10-12T08:00:00.000Z", refinedText: "said yesterday", duration: 6 }));
  history.add(entry({ id: "b", createdAt: "2026-10-13T08:00:00.000Z", refinedText: "first today", duration: 4 }));
  history.add(entry({ id: "c", createdAt: "2026-10-13T09:00:00.000Z", refinedText: "second today", duration: 5.5 }));
  history.add(
    entry({
      id: "d",
      createdAt: "2026-10-13T10:00:00.000Z",
      status: "failed",
      refinedText: "",
      error: "unreachable",
      duration: 9,
    }),
  );

  assert.deepEqual(history.stats(), {
    dictations: 3,
    characters: "said yesterday".length + "first today".length + "second today".length,
    seconds: 15.5,
    failed: 1,
    costUsd: 0,
    unpricedCalls: 0,
  });
  assert.deepEqual(history.stats({ since: "2026-10-13T00:00:00.000Z" }), {
    dictations: 2,
    characters: "first today".length + "second today".length,
    seconds: 9.5,
    failed: 1,
    costUsd: 0,
    unpricedCalls: 0,
  });
  history.close();
});

test("home page statistics: every completed dictation with only time, text, and length, oldest first; failed and silent ones excluded", () => {
  const history = openHistory(join(dir, "history.db"));
  history.add(entry({ id: "b", createdAt: "2026-10-13T09:00:00.000Z", refinedText: "second", duration: 2 }));
  history.add(entry({ id: "a", createdAt: "2026-10-12T09:00:00.000Z", refinedText: "first", duration: 1 }));
  history.add(entry({ id: "c", status: "failed", refinedText: "", error: "timeout" }));
  // A stray press with no speech: the model returned empty text, saved as completed but not counted as speech
  history.add(entry({ id: "d", createdAt: "2026-10-14T09:00:00.000Z", refinedText: "", duration: 3 }));
  assert.deepEqual(history.dictations(), [
    { createdAt: "2026-10-12T09:00:00.000Z", text: "first", duration: 1 },
    { createdAt: "2026-10-13T09:00:00.000Z", text: "second", duration: 2 },
  ]);
  history.close();
});

test("an empty history gives all zeros", () => {
  const history = openHistory(join(dir, "history.db"));
  assert.deepEqual(history.stats(), {
    dictations: 0,
    characters: 0,
    seconds: 0,
    failed: 0,
    costUsd: 0,
    unpricedCalls: 0,
  });
  history.close();
});

test("read-only: can read but not write, and never creates a missing database", () => {
  const dbPath = join(dir, "history.db");
  assert.equal(openHistory(dbPath, { readOnly: true }), null);
  assert.equal(existsSync(dbPath), false);

  const writable = openHistory(dbPath);
  writable.add(entry());
  writable.close();

  const readOnly = openHistory(dbPath, { readOnly: true });
  assert.equal(readOnly.list().length, 1);
  assert.throws(() => readOnly.add(entry({ id: "b" })), /readonly/);
  readOnly.close();
});

test("read-only with a database version that does not match the program does not read", () => {
  const dbPath = join(dir, "history.db");
  openHistory(dbPath).close();
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA user_version = 99");
  db.close();
  assert.throws(() => openHistory(dbPath, { readOnly: true }), said(/version/));
});

// ---------- Billing: one entry per model call (shaped like onCall in src/server/refine/refiner.mjs) ----------

const call = (overrides = {}) => ({
  purpose: "dictation",
  audioId: "a1",
  provider: "gemini",
  model: "gemini-3.6-flash",
  inputTokens: 1390,
  audioTokens: 25,
  cachedTokens: 0,
  outputTokens: 4,
  thinkingTokens: 0,
  costUsd: 0.001,
  latencyMs: 1700,
  createdAt: "2026-10-13T08:00:00.000Z",
  ...overrides,
});

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≠ ${expected}`);

test("each history entry carries its usage, with retried calls added up", () => {
  const history = openHistory(join(dir, "history.db"));
  // Billing comes first: recorded when the model replies, history only after the text is pasted
  history.addCall(call({ latencyMs: 1500, costUsd: 0.001 }));
  history.addCall(call({ latencyMs: 1200, costUsd: 0.002, outputTokens: 6 }));
  history.add(entry());
  const [row] = history.list();
  assert.deepEqual(
    { ...row.usage, costUsd: 0 },
    {
      calls: 2,
      inputTokens: 2780,
      outputTokens: 10,
      costUsd: 0,
      latencyMs: 2700,
    },
  );
  close(row.usage.costUsd, 0.003);
  history.close();
});

test("if one call in an entry has an unknown price, the entry's cost is unknown, never half counted as the whole", () => {
  const history = openHistory(join(dir, "history.db"));
  history.addCall(call({ costUsd: 0.001 }));
  history.addCall(call({ model: "gemini-9-ultra", costUsd: null }));
  history.add(entry());
  assert.equal(history.list()[0].usage.costUsd, null);
  history.close();
});

test("usage summary: dictations, key checks, token breakdown, cost, optionally after a moment", () => {
  const history = openHistory(join(dir, "history.db"));
  history.addCall(call({ audioId: "old", createdAt: "2026-10-12T08:00:00.000Z", costUsd: 0.5 }));
  history.addCall(call({ audioId: "a", latencyMs: 1000 }));
  history.addCall(call({ audioId: "a", latencyMs: 900, cachedTokens: 1024, thinkingTokens: 3, outputTokens: 7 }));
  history.addCall(call({ audioId: "b", latencyMs: 3000, provider: "openai", model: "gpt-audio-mini-2025-12-15" }));
  history.addCall(
    call({ purpose: "check", audioId: null, inputTokens: 2, audioTokens: 0, outputTokens: 0, latencyMs: 600 }),
  );
  history.addCall(call({ audioId: "c", model: "gemini-9-ultra", costUsd: null, latencyMs: 2000 }));

  const today = history.usage({ since: "2026-10-13T00:00:00.000Z" });
  const { models, costUsd, ...totals } = today;
  assert.deepEqual(totals, {
    calls: 5,
    checks: 1,
    dictations: 3,
    inputTokens: 1390 * 4 + 2,
    audioTokens: 25 * 4,
    cachedTokens: 1024,
    outputTokens: 4 * 3 + 7,
    thinkingTokens: 3,
    cacheCostUsd: 0,
    unpricedCalls: 1,
    // Each dictation's wait on models (retries added up), fastest first
    latenciesMs: [1900, 2000, 3000],
  });
  close(costUsd, 0.004);

  // Split by model, biggest spend first; each model has its own waits
  assert.deepEqual(
    models.map(({ provider, model, calls, checks, dictations, unpricedCalls, latenciesMs }) => ({
      provider,
      model,
      calls,
      checks,
      dictations,
      unpricedCalls,
      latenciesMs,
    })),
    [
      {
        provider: "gemini",
        model: "gemini-3.6-flash",
        calls: 3,
        checks: 1,
        dictations: 1,
        unpricedCalls: 0,
        latenciesMs: [1900],
      },
      {
        provider: "openai",
        model: "gpt-audio-mini-2025-12-15",
        calls: 1,
        checks: 0,
        dictations: 1,
        unpricedCalls: 0,
        latenciesMs: [3000],
      },
      {
        provider: "gemini",
        model: "gemini-9-ultra",
        calls: 1,
        checks: 0,
        dictations: 1,
        unpricedCalls: 1,
        latenciesMs: [2000],
      },
    ],
  );

  assert.equal(history.usage().calls, 6);
  close(history.usage().costUsd, 0.504);
  history.close();
});

test("on-device transcription is billed too: a dictation is counted once; the total wait is both steps, split by model each on its own", () => {
  const history = openHistory(join(dir, "history.db"));
  const local = { provider: "local", model: "qwen3-asr-0.6b-q8", inputTokens: 0, audioTokens: 0, outputTokens: 0 };
  history.addCall(call({ audioId: "l1", ...local, costUsd: 0, latencyMs: 300 }));
  history.addCall(
    call({ audioId: "l1", provider: "deepseek", model: "deepseek-flash", costUsd: 0.0001, latencyMs: 1200 }),
  );
  history.addCall(call({ audioId: "l2", ...local, costUsd: 0, latencyMs: 250 }));
  history.addCall(
    call({ audioId: "l2", provider: "deepseek", model: "deepseek-flash", costUsd: 0.0001, latencyMs: 900 }),
  );
  const usage = history.usage();
  assert.equal(usage.dictations, 2);
  assert.equal(usage.unpricedCalls, 0);
  assert.deepEqual(usage.latenciesMs, [1150, 1500]);
  assert.deepEqual(
    usage.models.map(({ provider, dictations, latenciesMs }) => ({ provider, dictations, latenciesMs })),
    [
      { provider: "deepseek", dictations: 2, latenciesMs: [900, 1200] },
      { provider: "local", dictations: 2, latenciesMs: [250, 300] },
    ],
  );
  history.close();
});

test("today's spend is in the statistics too, key checks included", () => {
  const history = openHistory(join(dir, "history.db"));
  history.add(entry({ id: "a", createdAt: "2026-10-13T08:00:00.000Z" }));
  history.addCall(call({ audioId: "a", costUsd: 0.002 }));
  history.addCall(call({ purpose: "check", audioId: null, costUsd: 0.0001 }));
  history.addCall(call({ audioId: "x", createdAt: "2026-10-12T08:00:00.000Z", costUsd: 1 }));
  const today = history.stats({ since: "2026-10-13T00:00:00.000Z" });
  close(today.costUsd, 0.0021);
  assert.equal(today.unpricedCalls, 0);
  // One call has no price: the cost adds only priced calls, and unpriced ones are reported apart
  history.addCall(call({ audioId: "a", model: "gemini-9-ultra", costUsd: null }));
  assert.equal(history.stats({ since: "2026-10-13T00:00:00.000Z" }).unpricedCalls, 1);
  history.close();
});

test("before any billing, usage is all zeros and waits are empty", () => {
  const history = openHistory(join(dir, "history.db"));
  assert.deepEqual(history.usage(), {
    calls: 0,
    checks: 0,
    dictations: 0,
    inputTokens: 0,
    audioTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    costUsd: 0,
    cacheCostUsd: 0,
    unpricedCalls: 0,
    latenciesMs: [],
    models: [],
  });
  history.close();
});

test("billing takes only the columns the table has: an extra usage field from an adapter still records", () => {
  const history = openHistory(join(dir, "history.db"));
  history.addCall({ ...call(), reasoningSummary: "an extra field" });
  assert.equal(history.usage().calls, 1);
  history.close();
});

test("prompt cache spend (building, storage) is its own kind, reported apart in the summary and belonging to no dictation", () => {
  const history = openHistory(join(dir, "history.db"));
  history.addCall(call({ audioId: "a" }));
  history.addCall(call({ purpose: "cache", audioId: null, inputTokens: 1350, outputTokens: 0, costUsd: 0.0012 }));
  history.addCall(call({ purpose: "cache", audioId: null, inputTokens: 0, outputTokens: 0, costUsd: 0.0001 }));
  const usage = history.usage();
  assert.equal(usage.calls, 3);
  assert.equal(usage.dictations, 1);
  close(usage.cacheCostUsd, 0.0013);
  close(usage.costUsd, 0.0023);
  // Waits count only dictations
  assert.deepEqual(usage.latenciesMs, [1700]);
  history.close();
});

test("billing purposes are only dictation, key check, or prompt cache", () => {
  const history = openHistory(join(dir, "history.db"));
  assert.throws(() => history.addCall(call({ purpose: "other" })), /CHECK|constraint/i);
  history.close();
});

test("a database from before billing (version 1) is upgraded on open: entries kept, billing starts from zero", () => {
  const path = join(dir, "history.db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE history (
     id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
     refined_text TEXT NOT NULL, error TEXT, duration REAL NOT NULL, audio_local_path TEXT, created_at TEXT NOT NULL);
   CREATE INDEX history_created_at ON history (created_at DESC);
   PRAGMA user_version = 1;`);
  old
    .prepare(
      "INSERT INTO history VALUES ('a1', 'completed', 'We meet on Friday.', NULL, 4.2, '/tmp/a1.webm', '2026-10-13T08:00:00.000Z')",
    )
    .run();
  old.close();

  const history = openHistory(path);
  assert.deepEqual(history.list(), [{ ...entry(), usage: null }]);
  assert.equal(history.usage().calls, 0);
  history.addCall(call());
  assert.equal(history.list()[0].usage.calls, 1);
  history.close();
});
