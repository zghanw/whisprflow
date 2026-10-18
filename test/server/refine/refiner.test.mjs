import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator, msg } from "../../../src/i18n/index.mjs";
import { ModelError } from "../../../src/server/providers/errors.mjs";
import { SYSTEM_PROMPT, TASK_REMINDER } from "../../../src/server/refine/prompt.mjs";
import { createModelRefiner, createRefiner, generateClean } from "../../../src/server/refine/refiner.mjs";

const en = createTranslator("en");

function fakeGenerate(outputs) {
  const calls = { count: 0, warnings: [] };
  const generateOnce = async () => outputs[calls.count++];
  const log = { warn: (event, fields) => calls.warnings.push({ event, ...fields }) };
  return { calls, generateOnce, log };
}

test("a stray timestamp in the text triggers one retry; the second result is used and a log line is written", async () => {
  const { calls, generateOnce, log } = fakeGenerate([
    "Ship it, 00:30 migrate everything",
    "Ship it, migrate everything",
  ]);
  assert.equal(await generateClean(generateOnce, log), "Ship it, migrate everything");
  assert.equal(calls.count, 2);
  assert.deepEqual(calls.warnings, [{ event: "refine_retry", reason: "stray timestamp in the text" }]);
});

test("normal text is generated once; version numbers, ratios, and clock times without a leading zero are not timestamps", async () => {
  const { calls, generateOnce, log } = fakeGenerate(["Version 1.5.0, ratio 3:1, meet at 3:30"]);
  assert.equal(await generateClean(generateOnce, log), "Version 1.5.0, ratio 3:1, meet at 3:30");
  assert.equal(calls.count, 1);
  assert.deepEqual(calls.warnings, []);
});

test("if the retry still has the time, the speaker really said it; no further retries", async () => {
  const { calls, generateOnce, log } = fakeGenerate(["Standup at 09:30 tomorrow", "Standup at 09:30 tomorrow"]);
  assert.equal(await generateClean(generateOnce, log), "Standup at 09:30 tomorrow");
  assert.equal(calls.count, 2);
});

// ---------- The shared refining flow: each vendor adapter only "sends the request and returns the text"; the rest is here ----------

/** Usage an adapter returns (shaped like usageOf in openai.mjs) */
const USAGE = {
  model: "gpt-audio-mini-2025-12-15",
  inputTokens: 1532,
  audioTokens: 10,
  cachedTokens: 0,
  outputTokens: 4,
  thinkingTokens: 0,
  costUsd: 0.001,
};

/** Fake adapter: records what each generate call received and returns the given texts (strings) or whole replies (objects) in order */
function fakeClient(outputs, { ping = async () => ({ usage: USAGE }) } = {}) {
  const calls = [];
  return {
    calls,
    ping,
    async generate(request) {
      calls.push(request);
      const next = outputs[calls.length - 1];
      if (next instanceof Error) throw next;
      return typeof next === "string" ? { text: next, problem: null, usage: USAGE } : next;
    },
  };
}

const quietLog = { info() {}, warn() {}, error() {} };
const OpenAI = { id: "openai", name: "OpenAI" };

function refinerWith(client, options = {}) {
  const transcoded = [];
  const refiner = createRefiner({
    provider: OpenAI,
    client,
    audioTypes: ["audio/wav"],
    log: quietLog,
    timeoutMs: 1_000,
    transcode: async (audio, mimeType) => {
      transcoded.push(mimeType);
      return { audio: Buffer.from(`wav:${audio}`), mimeType: "audio/wav" };
    },
    ...options,
  });
  return { refiner, transcoded };
}

test("the model gets the same prompt and reminder, and the result goes through the finishing step", async () => {
  const client = fakeClient(['"We meet on Friday."']);
  const { refiner } = refinerWith(client, { audioTypes: ["audio/webm"] });
  assert.equal(await refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm" }), "We meet on Friday.");
  const [request] = client.calls;
  assert.equal(request.systemPrompt, SYSTEM_PROMPT);
  assert.equal(request.reminder, TASK_REMINDER);
  assert.equal(request.mimeType, "audio/webm");
  assert.equal(String(request.audio), "rec");
});

test("a format the vendor does not take is converted first; a timestamp retry converts only once", async () => {
  const client = fakeClient(["Ship it, 00:30 migrate everything", "Ship it, migrate everything"]);
  const { refiner, transcoded } = refinerWith(client);
  assert.equal(await refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm" }), "Ship it, migrate everything");
  assert.deepEqual(transcoded, ["audio/webm"]);
  assert.deepEqual(
    client.calls.map(({ audio, mimeType }) => [String(audio), mimeType]),
    [
      ["wav:rec", "audio/wav"],
      ["wav:rec", "audio/wav"],
    ],
  );
});

test("a client disconnect cancels the request: the signal given to the adapter follows it", async () => {
  let seen;
  const client = fakeClient([]);
  client.generate = (request) => {
    seen = request.signal;
    return new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason)));
  };
  const { refiner } = refinerWith(client, { audioTypes: ["audio/webm"] });
  const abort = new AbortController();
  const pending = refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm", signal: abort.signal });
  abort.abort();
  await assert.rejects(pending);
  assert.equal(seen.aborted, true);
});

test("errors are classified ModelErrors that name the vendor and say what to do", async () => {
  const offline = new TypeError("fetch failed");
  const { refiner } = refinerWith(fakeClient([offline]), { audioTypes: ["audio/webm"] });
  const error = await refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm" }).catch((thrown) => thrown);
  assert.ok(error instanceof ModelError);
  assert.equal(error.kind, "unavailable");
  assert.equal(en.text(error.problem), "Can't reach OpenAI. Check your network");
});

test("a recording that can not be converted is a ModelError too, never the raw decoder error", async () => {
  const { refiner } = refinerWith(fakeClient([]), {
    transcode: async () => {
      throw new Error("Could not decode the recording (audio/webm): corrupt");
    },
  });
  const error = await refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm" }).catch((thrown) => thrown);
  assert.ok(error instanceof ModelError);
  assert.match(en.text(error.problem), /Could not decode/);
});

test("warmUp sends the adapter's smallest request; failures are classified too", async () => {
  let pinged = 0;
  const { refiner } = refinerWith(
    fakeClient([], {
      ping: async () => {
        pinged++;
        return { usage: USAGE };
      },
    }),
  );
  await refiner.warmUp();
  assert.equal(pinged, 1);

  const invalid = Object.assign(new Error("401"), { status: 401 });
  const { refiner: failing } = refinerWith(
    fakeClient([], {
      ping: async () => {
        throw invalid;
      },
    }),
    { classify: (error) => (error.status === 401 ? { kind: "key", problem: "This key is invalid" } : null) },
  );
  const error = await failing.warmUp().catch((thrown) => thrown);
  assert.deepEqual([error.kind, en.text(error.problem)], ["key", "This key is invalid"]);
});

test("createModelRefiner: sets up the chosen vendor's adapter; an unknown vendor fails right away", async () => {
  const refiner = await createModelRefiner({
    choice: { provider: "openai", model: "gpt-audio-mini" },
    apiKey: "k",
    log: quietLog,
  });
  assert.equal(typeof refiner.refine, "function");
  assert.equal(typeof refiner.warmUp, "function");
  await assert.rejects(
    createModelRefiner({ choice: { provider: "deepseek", model: "x" }, apiKey: "k", log: quietLog }),
    /deepseek/,
  );
});

// ---------- Billing: every call that got a reply is recorded with its cost and time ----------

function recorder() {
  const records = [];
  const events = [];
  const log = {
    info: (event, fields) => events.push({ level: "info", event, ...fields }),
    warn: (event, fields) => events.push({ level: "warn", event, ...fields }),
    error: (event, fields) => events.push({ level: "error", event, ...fields }),
  };
  return { records, events, log, onCall: (record) => records.push(record) };
}

test("every call is recorded: which dictation, which vendor, which model, tokens, cost, and time", async () => {
  const { records, events, log, onCall } = recorder();
  const { refiner } = refinerWith(fakeClient(["Sounds good"]), { audioTypes: ["audio/webm"], log, onCall });
  const before = Date.now();
  await refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm", audioId: "a1" });

  assert.equal(records.length, 1);
  const [{ latencyMs, createdAt, ...record }] = records;
  assert.deepEqual(record, { purpose: "dictation", audioId: "a1", provider: "openai", ...USAGE });
  assert.ok(Number.isInteger(latencyMs) && latencyMs >= 0);
  assert.ok(Date.parse(createdAt) >= before - 1);
  // A log line too, for troubleshooting; without the text
  const logged = events.find(({ event }) => event === "model_call");
  assert.deepEqual(
    [logged.purpose, logged.audio_id, logged.model, logged.input_tokens, logged.cost_usd],
    ["dictation", "a1", USAGE.model, 1532, 0.001],
  );
  assert.ok(!JSON.stringify(events).includes("Sounds good"));
});

test("the timestamp retry is recorded too; both belong to the same dictation", async () => {
  const { records, onCall } = recorder();
  const { refiner } = refinerWith(fakeClient(["Ship it, 00:30 migrate everything", "Ship it, migrate everything"]), {
    onCall,
  });
  await refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm", audioId: "a2" });
  assert.deepEqual(
    records.map(({ purpose, audioId }) => [purpose, audioId]),
    [
      ["dictation", "a2"],
      ["dictation", "a2"],
    ],
  );
});

test("the smallest request that checks the key is recorded too, without a dictation", async () => {
  const { records, onCall } = recorder();
  const { refiner } = refinerWith(fakeClient([]), { onCall });
  await refiner.warmUp();
  assert.deepEqual(
    records.map(({ purpose, audioId, model }) => [purpose, audioId, model]),
    [["check", null, USAGE.model]],
  );
});

test("a reply that can not be used (truncated) is billed first, then reported: that call was paid for", async () => {
  const { records, onCall } = recorder();
  const cut = { text: null, problem: msg("model.unfinished", { provider: "OpenAI", reason: "length" }), usage: USAGE };
  const { refiner } = refinerWith(fakeClient([cut]), { audioTypes: ["audio/webm"], onCall });
  const error = await refiner
    .refine(Buffer.from("rec"), { mimeType: "audio/webm", audioId: "a3" })
    .catch((thrown) => thrown);
  assert.ok(error instanceof ModelError);
  assert.equal(en.text(error.problem), "OpenAI didn't finish normally: length");
  assert.equal(records.length, 1);
});

test("a call with no reply can not be billed: there is no usage", async () => {
  const { records, onCall } = recorder();
  const { refiner } = refinerWith(fakeClient([new TypeError("fetch failed")]), { audioTypes: ["audio/webm"], onCall });
  await assert.rejects(refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm", audioId: "a4" }));
  assert.deepEqual(records, []);
});

test("a request sent but cut off before the reply (timeout, dropped connection) may still be charged: a warning is logged, the ledger misses it", async () => {
  const { records, events, log, onCall } = recorder();
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const { refiner } = refinerWith(fakeClient([timeout]), { audioTypes: ["audio/webm"], log, onCall });
  await assert.rejects(refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm", audioId: "a7" }));
  assert.deepEqual(records, []);
  const unmetered = events.find(({ event }) => event === "model_call_unmetered");
  assert.equal(unmetered?.level, "warn");
  assert.deepEqual([unmetered.purpose, unmetered.audio_id, unmetered.reason], ["dictation", "a7", "TimeoutError"]);
  assert.ok(Number.isInteger(unmetered.latency_ms));

  // A request that never went out (unreachable) needs no warning
  const offline = recorder();
  const { refiner: unreachable } = refinerWith(fakeClient([new TypeError("fetch failed")]), {
    audioTypes: ["audio/webm"],
    log: offline.log,
  });
  await assert.rejects(unreachable.refine(Buffer.from("rec"), { mimeType: "audio/webm", audioId: "a8" }));
  assert.equal(
    offline.events.find(({ event }) => event === "model_call_unmetered"),
    undefined,
  );
});

test("a billing failure does not affect the dictation: the text is delivered and the error is logged", async () => {
  const { events, log } = recorder();
  const onCall = () => {
    throw new Error("database is locked");
  };
  const { refiner } = refinerWith(fakeClient(["Sounds good"]), { audioTypes: ["audio/webm"], log, onCall });
  assert.equal(await refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm", audioId: "a5" }), "Sounds good");
  const failed = events.find(({ event }) => event === "model_call_not_recorded");
  assert.equal(failed.level, "error");
  assert.equal(failed.audio_id, "a5");
  assert.match(failed.error, /database is locked/);
});

test("an adapter that returns no usage (its own bug): the text is delivered, a warning is logged, no fake zero is recorded", async () => {
  const { records, events, log, onCall } = recorder();
  const { refiner } = refinerWith(fakeClient([{ text: "Sounds good", problem: null }]), {
    audioTypes: ["audio/webm"],
    log,
    onCall,
  });
  assert.equal(await refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm", audioId: "a6" }), "Sounds good");
  assert.deepEqual(records, []);
  assert.equal(events.find(({ event }) => event === "usage_missing")?.level, "warn");
});

// ---------- Preparing when speech starts: Gemini builds a prompt cache, billed separately ----------

test("prepare: the adapter builds the prompt cache and its cost is recorded as cache, not as a dictation", async () => {
  const { records, onCall } = recorder();
  const prepared = [];
  const client = fakeClient([]);
  client.prepare = async (request) => {
    prepared.push(request);
    return { usage: { ...USAGE, model: "gemini-3.6-flash", inputTokens: 1350, outputTokens: 0, costUsd: 0.0012 } };
  };
  const { refiner } = refinerWith(client, { onCall });
  await refiner.prepare();
  assert.deepEqual(prepared, [{ systemPrompt: SYSTEM_PROMPT }]);
  assert.deepEqual(
    records.map(({ purpose, audioId, inputTokens, costUsd }) => [purpose, audioId, inputTokens, costUsd]),
    [["cache", null, 1350, 0.0012]],
  );
});

test("prepare: nothing is recorded when nothing was spent (already building, unsupported model); adapters without it (OpenAI) do nothing", async () => {
  const { records, onCall } = recorder();
  const client = fakeClient([]);
  client.prepare = async () => null;
  await refinerWith(client, { onCall }).refiner.prepare();
  await refinerWith(fakeClient([]), { onCall }).refiner.prepare();
  assert.deepEqual(records, []);
});

test("prepare: a failure only logs a warning, never throws, and never includes the key", async () => {
  const { events, log } = recorder();
  const client = fakeClient([]);
  client.prepare = async () => {
    throw new Error("fetch failed for key sk-secret");
  };
  await refinerWith(client, { log, apiKey: "sk-secret" }).refiner.prepare();
  const failed = events.find(({ event }) => event === "prompt_cache_failed");
  assert.equal(failed.level, "warn");
  assert.doesNotMatch(JSON.stringify(failed), /sk-secret/);
});
