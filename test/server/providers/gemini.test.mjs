import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import { AUDIO_TYPES, classifyError, createClient, replyOf } from "../../../src/server/providers/gemini.mjs";

const en = createTranslator("en");

/** Like what the SDK throws: message is Gemini's whole JSON reply, status is the HTTP status */
function apiError(code, message, status) {
  return Object.assign(new Error(JSON.stringify({ error: { code, message, status } })), {
    name: "ApiError",
    status: code,
  });
}
/** The classification, with the wording translated */
const classify = (error) => {
  const classified = classifyError(error, String(error.message));
  return classified && { ...classified, problem: en.text(classified.problem) };
};

test("Gemini takes the bar's WebM, Ogg, and the common WAV format directly, with no conversion", () => {
  assert.deepEqual(AUDIO_TYPES, ["audio/ogg", "audio/webm", "audio/wav"]);
});

test("a bad key says the key is invalid", () => {
  // The error measured for a fake key
  const invalid = new Error(
    '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}',
  );
  assert.deepEqual(classify(invalid), { kind: "key", problem: "This key is invalid. Check it was copied in full" });
});

test("Gemini outages or rate limits have nothing to do with the key or settings and pass on their own", () => {
  assert.deepEqual(classify(apiError(503, "The service is currently unavailable.", "UNAVAILABLE")), {
    kind: "unavailable",
    problem: "Gemini is unavailable right now (The service is currently unavailable). Try again later",
  });
  assert.equal(classify(apiError(500, "Internal error.", "INTERNAL")).kind, "unavailable");
  assert.equal(classify(apiError(429, "Resource exhausted.", "RESOURCE_EXHAUSTED")).kind, "unavailable");
});

test("Gemini rejected the request (usually the model name or level): only its own sentence, not the whole JSON", () => {
  const other = classify(
    apiError(
      404,
      "models/gemini-no-such-model is not found for API version v1beta, or is not supported for generateContent.",
      "NOT_FOUND",
    ),
  );
  assert.equal(other.kind, "other");
  // The trailing period is dropped since more text follows
  assert.match(
    other.problem,
    /^Gemini rejected the request: models\/gemini-no-such-model is not found.*generateContent$/,
  );
  assert.doesNotMatch(other.problem, /"code"/);
});

test("errors not from Gemini are left to the generic classification", () => {
  assert.equal(classify(new TypeError("fetch failed")), null);
  assert.equal(classify(new Error("Gemini didn't finish normally: MAX_TOKENS")), null);
});

// ---------- Usage in the reply: tokens, which model, the cost ----------

const OCT = new Date("2026-10-14T08:00:00Z");

/** A real dictation reply (measured 2026-10-14; gemini-3.5-flash was requested and redirected to 3.6 Flash) */
const dictation = (overrides = {}) => ({
  text: "<no speech>",
  modelVersion: "gemini-3.6-flash",
  candidates: [{ finishReason: "STOP" }],
  usageMetadata: {
    promptTokenCount: 1390,
    candidatesTokenCount: 4,
    totalTokenCount: 1394,
    promptTokensDetails: [
      { modality: "AUDIO", tokenCount: 25 },
      { modality: "TEXT", tokenCount: 1365 },
    ],
    serviceTier: "standard",
  },
  ...overrides,
});

test("usage in the reply is priced by the model that actually answered (3.5 Flash requested, 3.6 Flash answered)", () => {
  assert.deepEqual(replyOf(dictation(), { model: "gemini-3.5-flash", at: OCT }), {
    text: "<no speech>",
    problem: null,
    usage: {
      model: "gemini-3.6-flash",
      inputTokens: 1390,
      audioTokens: 25,
      cachedTokens: 0,
      outputTokens: 4,
      thinkingTokens: 0,
      costUsd: (1390 * 0.75 + 4 * 3.75) / 1e6,
    },
  });
});

test("thinking tokens count as output; cache hits are reported and priced at the cache price", () => {
  const { usage } = replyOf(
    dictation({
      modelVersion: "gemini-2.5-flash",
      usageMetadata: {
        promptTokenCount: 1390,
        cachedContentTokenCount: 1024,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 30,
        promptTokensDetails: [
          { modality: "TEXT", tokenCount: 1365 },
          { modality: "AUDIO", tokenCount: 25 },
        ],
        cacheTokensDetails: [{ modality: "TEXT", tokenCount: 1024 }],
      },
    }),
    { model: "gemini-2.5-flash", at: OCT },
  );
  assert.equal(usage.outputTokens, 80);
  assert.equal(usage.thinkingTokens, 30);
  assert.equal(usage.cachedTokens, 1024);
  assert.ok(Math.abs(usage.costUsd - (341 * 0.3 + 1024 * 0.03 + 25 * 1 + 80 * 2.5) / 1e6) < 1e-12);
});

test("with no model in the reply, the requested one is priced; a model missing from the price list has no cost, tokens are still recorded", () => {
  assert.equal(
    replyOf(dictation({ modelVersion: undefined }), { model: "gemini-2.5-flash", at: OCT }).usage.model,
    "gemini-2.5-flash",
  );
  const { usage } = replyOf(dictation({ modelVersion: "gemini-9-ultra" }), { model: "gemini-9-ultra", at: OCT });
  assert.equal(usage.costUsd, null);
  assert.equal(usage.inputTokens, 1390);
});

test("when the reply's model has no price (a suffixed variant name), the requested model is priced instead", () => {
  const { usage } = replyOf(dictation({ modelVersion: "gemini-3.6-flash-preview-0915" }), {
    model: "gemini-3.6-flash",
    at: OCT,
  });
  assert.equal(usage.model, "gemini-3.6-flash-preview-0915");
  assert.equal(usage.costUsd, (1390 * 0.75 + 4 * 3.75) / 1e6);
});

test("blocked or unfinished replies are never the result, but usage still comes back: that call was paid for", () => {
  const blocked = replyOf(dictation({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, candidates: [] }), {
    model: "gemini-3.6-flash",
    at: OCT,
  });
  assert.equal(en.text(blocked.problem), "Gemini didn't process this dictation: PROHIBITED_CONTENT");
  assert.equal(blocked.text, null);
  assert.equal(blocked.usage.inputTokens, 1390);

  const cut = replyOf(dictation({ candidates: [{ finishReason: "MAX_TOKENS" }] }), {
    model: "gemini-3.6-flash",
    at: OCT,
  });
  assert.equal(en.text(cut.problem), "Gemini didn't finish normally: MAX_TOKENS");
  assert.equal(cut.text, null);
});

test("missing usage fields count as 0 (the smallest key check reports only input, measured)", () => {
  const ping = { modelVersion: "gemini-3.6-flash", usageMetadata: { promptTokenCount: 2, totalTokenCount: 2 } };
  assert.deepEqual(replyOf(ping, { model: "gemini-3.6-flash", at: OCT }).usage, {
    model: "gemini-3.6-flash",
    inputTokens: 2,
    audioTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    costUsd: (2 * 0.75) / 1e6,
  });
});

// ---------- Prompt cache: built (or extended) when speech starts, used when cleaning up, so the prompt costs a tenth ----------

const MINUTE = 60_000;
const SYSTEM = "system prompt";

/**
 * Fake SDK: building, extending, and using the cache answer like the real thing (measured 2026-10-14: a built cache reports totalTokenCount,
 * a cached request reports cachedContentTokenCount, and a missing cache returns 403 "CachedContent not found")
 */
function fakeSdk({ createError, updateError, cachedError } = {}) {
  let clock = Date.parse("2026-10-14T08:00:00Z");
  const calls = { create: [], update: [], generate: [] };
  const expiry = (ttl) => new Date(clock + Number.parseInt(ttl, 10) * 1000).toISOString();
  const response = (cachedContent) => ({
    text: "Sounds good",
    modelVersion: "gemini-3.6-flash",
    candidates: [{ finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 1484,
      candidatesTokenCount: 18,
      promptTokensDetails: [
        { modality: "TEXT", tokenCount: 1365 },
        { modality: "AUDIO", tokenCount: 119 },
      ],
      ...(cachedContent
        ? { cachedContentTokenCount: 1350, cacheTokensDetails: [{ modality: "TEXT", tokenCount: 1350 }] }
        : {}),
    },
  });
  const sdk = {
    caches: {
      async create(params) {
        calls.create.push(params);
        if (createError) throw createError();
        return {
          name: `cachedContents/c${calls.create.length}`,
          model: "models/gemini-3.6-flash",
          expireTime: expiry(params.config.ttl),
          usageMetadata: { totalTokenCount: 1350 },
        };
      },
      async update(params) {
        calls.update.push(params);
        if (updateError) throw updateError();
        return { name: params.name, expireTime: expiry(params.config.ttl) };
      },
    },
    models: {
      async generateContent(params) {
        calls.generate.push(params);
        if (params.config.cachedContent && cachedError) throw cachedError();
        return response(params.config.cachedContent);
      },
    },
  };
  return {
    sdk,
    calls,
    now: () => new Date(clock),
    advance: (ms) => {
      clock += ms;
    },
  };
}

const NOT_FOUND = () =>
  Object.assign(
    new Error(
      '{"error":{"code":403,"message":"CachedContent not found (or permission denied)","status":"PERMISSION_DENIED"}}',
    ),
    { status: 403 },
  );

function cachingClient(options = {}) {
  const fake = fakeSdk(options);
  const client = createClient({
    apiKey: "k",
    model: "gemini-3.6-flash",
    thinkingLevel: "MINIMAL",
    now: fake.now,
    sdk: fake.sdk,
    log: quietLog,
  });
  const dictate = () =>
    client.generate({
      audio: Buffer.from("rec"),
      mimeType: "audio/webm",
      systemPrompt: SYSTEM,
      reminder: "Output only the finished text.",
    });
  return { ...fake, client, dictate };
}

const quietLog = { info() {}, warn() {}, error() {} };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≠ ${expected}`);

test("speech starting builds a prompt cache for 30 minutes: billed once at the standard input price, plus 30 minutes of storage", async () => {
  const { client, calls } = cachingClient();
  const { usage } = await client.prepare({ systemPrompt: SYSTEM });
  const [{ model, config }] = calls.create;
  assert.deepEqual([model, config.systemInstruction, config.ttl], ["gemini-3.6-flash", SYSTEM, "1800s"]);
  // Building has a time limit too: a hung build would hold "building" forever and nothing could be built again
  assert.ok(config.abortSignal instanceof AbortSignal);
  assert.deepEqual(
    { ...usage, costUsd: 0 },
    {
      model: "gemini-3.6-flash",
      inputTokens: 1350,
      audioTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      costUsd: 0,
    },
  );
  close(usage.costUsd, (1350 * 0.75 + 1350 * 0.5 * 0.5) / 1e6);
});

test("cleanup uses the cache and does not send the prompt again; the prompt part is priced at the cache price", async () => {
  const { client, calls, dictate } = cachingClient();
  await client.prepare({ systemPrompt: SYSTEM });
  const reply = await dictate();
  const [request] = calls.generate;
  assert.equal(request.config.cachedContent, "cachedContents/c1");
  // With a cache, systemInstruction must not be set (measured: 400)
  assert.equal(request.config.systemInstruction, undefined);
  assert.deepEqual(request.config.thinkingConfig, { thinkingLevel: "MINIMAL" });
  assert.equal(reply.text, "Sounds good");
  assert.equal(reply.usage.cachedTokens, 1350);
  close(reply.usage.costUsd, (15 * 0.75 + 1350 * 0.075 + 119 * 0.75 + 18 * 3.75) / 1e6);
});

test("without a cache the prompt goes in systemInstruction as usual", async () => {
  const { calls, dictate } = cachingClient();
  await dictate();
  assert.equal(calls.generate[0].config.systemInstruction, SYSTEM);
  assert.equal(calls.generate[0].config.cachedContent, undefined);
});

test("speaking again while the cache lives only extends it by 30 minutes, billing the extra storage", async () => {
  const { client, calls, advance } = cachingClient();
  await client.prepare({ systemPrompt: SYSTEM });
  advance(10 * MINUTE);
  const { usage } = await client.prepare({ systemPrompt: SYSTEM });
  assert.equal(calls.create.length, 1);
  assert.deepEqual(
    calls.update.map(({ name, config }) => [name, config.ttl, config.abortSignal instanceof AbortSignal]),
    [["cachedContents/c1", "1800s", true]],
  );
  assert.equal(usage.inputTokens, 0);
  // It expired at 08:30 and now 08:40: 10 more minutes stored
  close(usage.costUsd, (1350 * 0.5 * (10 / 60)) / 1e6);
});

test("a cache about to expire or expired is not used; the next speech builds a new one", async () => {
  const { client, calls, advance, dictate } = cachingClient();
  await client.prepare({ systemPrompt: SYSTEM });
  // Under a minute left: it could vanish mid-request
  advance(29.5 * MINUTE);
  await dictate();
  assert.equal(calls.generate[0].config.cachedContent, undefined);
  advance(MINUTE);
  await client.prepare({ systemPrompt: SYSTEM });
  assert.equal(calls.create.length, 2);
  assert.equal(calls.update.length, 0);
});

test("the cache already gone on Google's side (403 CachedContent not found): this request is sent again without it, and the next speech rebuilds", async () => {
  const { client, calls, dictate } = cachingClient({ cachedError: NOT_FOUND });
  await client.prepare({ systemPrompt: SYSTEM });
  const reply = await dictate();
  assert.equal(reply.text, "Sounds good");
  assert.deepEqual(
    calls.generate.map(({ config }) => [config.cachedContent, config.systemInstruction]),
    [
      ["cachedContents/c1", undefined],
      [undefined, SYSTEM],
    ],
  );
  await client.prepare({ systemPrompt: SYSTEM });
  assert.equal(calls.create.length, 2);
});

test("finding the cache gone while extending builds a new one", async () => {
  const { client, calls } = cachingClient({ updateError: NOT_FOUND });
  await client.prepare({ systemPrompt: SYSTEM });
  const { usage } = await client.prepare({ systemPrompt: SYSTEM });
  assert.equal(calls.create.length, 2);
  assert.equal(usage.inputTokens, 1350);
});

test("other errors on a cached request are reported as usual, never silently resent", async () => {
  const unavailable = () => Object.assign(new Error('{"error":{"code":503,"message":"overloaded"}}'), { status: 503 });
  const { client, calls, dictate } = cachingClient({ cachedError: unavailable });
  await client.prepare({ systemPrompt: SYSTEM });
  await assert.rejects(dictate(), /overloaded/);
  assert.equal(calls.generate.length, 1);
});

test("a model that can't build explicit caches (4xx) is never tried again and requests go out as usual", async () => {
  const unsupported = () =>
    Object.assign(new Error('{"error":{"code":400,"message":"Explicit caching is not supported"}}'), { status: 400 });
  const { client, calls, dictate } = cachingClient({ createError: unsupported });
  await assert.rejects(client.prepare({ systemPrompt: SYSTEM }), /not supported/);
  assert.equal(await client.prepare({ systemPrompt: SYSTEM }), null);
  assert.equal(calls.create.length, 1);
  await dictate();
  assert.equal(calls.generate[0].config.systemInstruction, SYSTEM);
});

test("a temporary failure to build (offline, a 503 on their side) is retried on the next speech", async () => {
  const offline = () => Object.assign(new TypeError("fetch failed"), {});
  const { client, calls } = cachingClient({ createError: offline });
  await assert.rejects(client.prepare({ systemPrompt: SYSTEM }));
  await assert.rejects(client.prepare({ systemPrompt: SYSTEM }));
  assert.equal(calls.create.length, 2);
});

test("two speech starts at once build one cache; a cache for a changed prompt is not used", async () => {
  const { client, calls } = cachingClient();
  const [first, second] = await Promise.all([
    client.prepare({ systemPrompt: SYSTEM }),
    client.prepare({ systemPrompt: SYSTEM }),
  ]);
  assert.equal(calls.create.length, 1);
  assert.ok(first.usage);
  assert.equal(second, null);
  await client.generate({
    audio: Buffer.from("rec"),
    mimeType: "audio/webm",
    systemPrompt: "edited prompt",
    reminder: "",
  });
  assert.equal(calls.generate[0].config.cachedContent, undefined);
});
