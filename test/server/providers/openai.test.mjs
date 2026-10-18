import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import { AUDIO_TYPES, classifyError, createClient } from "../../../src/server/providers/openai.mjs";

const en = createTranslator("en");

/** Fake fetch: records requests and answers with the given status and body */
function fakeFetch(status, body) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetch, requests };
}

/** Measured usage (gpt-audio-mini, 1 s of audio plus the system prompt) */
const USAGE = {
  prompt_tokens: 1532,
  completion_tokens: 4,
  total_tokens: 1536,
  prompt_tokens_details: { cached_tokens: 0, audio_tokens: 10, text_tokens: 1522, image_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, text_tokens: 4 },
};

const completion = (content, finish_reason = "stop", extra = {}) => ({
  model: "gpt-audio-mini-2025-12-15",
  choices: [{ finish_reason, message: { role: "assistant", content, refusal: null, ...extra } }],
  usage: USAGE,
});

/** The usage above as billed */
const BILLED = {
  model: "gpt-audio-mini-2025-12-15",
  inputTokens: 1532,
  audioTokens: 10,
  cachedTokens: 0,
  outputTokens: 4,
  thinkingTokens: 0,
  costUsd: (1522 * 0.6 + 10 * 10 + 4 * 2.4) / 1e6,
};

const WAV = Buffer.from("RIFF fake wav");

test("OpenAI only takes wav (measured: webm and ogg return 400), so recordings are converted first", () => {
  assert.deepEqual(AUDIO_TYPES, ["audio/wav"]);
});

test("cleanup: the system prompt, the recording, and the line after it go together; text only, no spoken reply", async () => {
  const { fetch, requests } = fakeFetch(200, completion("Finished text"));
  const client = createClient({ apiKey: "sk-test", model: "gpt-audio-1.5", fetch });
  const signal = new AbortController().signal;
  const reply = await client.generate({
    audio: WAV,
    mimeType: "audio/wav",
    systemPrompt: "system prompt",
    reminder: "Output only the finished text.",
    signal,
  });
  assert.deepEqual(reply, { text: "Finished text", problem: null, usage: BILLED });

  const [{ url, init, body }] = requests;
  assert.equal(url, "https://api.openai.com/v1/chat/completions");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer sk-test");
  assert.equal(init.signal, signal);
  assert.deepEqual(body, {
    model: "gpt-audio-1.5",
    modalities: ["text"],
    messages: [
      { role: "system", content: "system prompt" },
      {
        role: "user",
        content: [
          { type: "input_audio", input_audio: { data: WAV.toString("base64"), format: "wav" } },
          { type: "text", text: "Output only the finished text." },
        ],
      },
    ],
  });
});

test("truncated or blocked partial text is never the result: it says why; the call was paid for, so usage comes back", async () => {
  for (const [completed, problem] of [
    [completion("halfway through", "length"), "OpenAI didn't finish normally: length"],
    [completion("", "content_filter"), "OpenAI didn't finish normally: content_filter"],
    [
      completion(null, "stop", { refusal: "I can't help with that." }),
      "OpenAI didn't process this dictation: I can't help with that",
    ],
  ]) {
    const { fetch } = fakeFetch(200, completed);
    const client = createClient({ apiKey: "k", model: "m", fetch });
    const reply = await client.generate({ audio: WAV, mimeType: "audio/wav", systemPrompt: "", reminder: "" });
    assert.deepEqual({ ...reply, problem: en.text(reply.problem) }, { text: null, problem, usage: BILLED });
  }
});

test("usage is priced by the model in the reply, else the requested one; models missing from the price list have no cost, tokens are still recorded", async () => {
  const { model: _reported, ...unnamed } = completion("OK");
  const { fetch } = fakeFetch(200, unnamed);
  const { usage } = await createClient({ apiKey: "k", model: "gpt-audio-1.5", fetch }).generate({
    audio: WAV,
    mimeType: "audio/wav",
    systemPrompt: "",
    reminder: "",
  });
  assert.equal(usage.model, "gpt-audio-1.5");
  assert.ok(Math.abs(usage.costUsd - (1522 * 2.5 + 10 * 32 + 4 * 10) / 1e6) < 1e-12);

  const { fetch: unknown } = fakeFetch(200, { ...completion("OK"), model: "gpt-9-audio" });
  const priced = await createClient({ apiKey: "k", model: "gpt-9-audio", fetch: unknown }).ping({});
  assert.equal(priced.usage.costUsd, null);
  assert.equal(priced.usage.inputTokens, 1532);
});

test("audio output and thinking tokens each have their own price; missing usage fields count as 0", async () => {
  const usage = {
    prompt_tokens: 100,
    completion_tokens: 30,
    prompt_tokens_details: { audio_tokens: 40 },
    completion_tokens_details: { reasoning_tokens: 8, audio_tokens: 10 },
  };
  const { fetch } = fakeFetch(200, { ...completion("OK"), usage });
  const reply = await createClient({ apiKey: "k", model: "gpt-audio-mini", fetch }).generate({
    audio: WAV,
    mimeType: "audio/wav",
    systemPrompt: "",
    reminder: "",
  });
  assert.equal(reply.usage.cachedTokens, 0);
  assert.equal(reply.usage.thinkingTokens, 8);
  assert.ok(Math.abs(reply.usage.costUsd - (60 * 0.6 + 40 * 10 + 20 * 2.4 + 10 * 20) / 1e6) < 1e-12);
});

test("the key check sends the smallest request: 0.1 s of silence, 1 token. A text-only request fails, these models require audio (measured: 400)", async () => {
  // With 1 token the finish_reason is length: not a failure
  const { fetch, requests } = fakeFetch(200, completion("", "length"));
  const { usage } = await createClient({ apiKey: "k", model: "gpt-audio-mini", fetch }).ping({});
  assert.deepEqual(usage, BILLED);
  const [{ body }] = requests;
  assert.equal(body.model, "gpt-audio-mini");
  assert.equal(body.max_completion_tokens, 1);
  const [part] = body.messages[0].content;
  assert.equal(part.type, "input_audio");
  assert.equal(part.input_audio.format, "wav");
  const wav = Buffer.from(part.input_audio.data, "base64");
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.ok(wav.length < 10_000);
});

/** OpenAI errors as measured: HTTP status + { error: { message, type, code } } */
async function failWith(status, error) {
  const { fetch } = fakeFetch(status, { error });
  const client = createClient({ apiKey: "k", model: "m", fetch });
  try {
    await client.ping({});
  } catch (thrown) {
    const classified = classifyError(thrown);
    // Compared with the wording translated
    return { thrown, classified: classified && { ...classified, problem: en.text(classified.problem) } };
  }
  throw new Error("should have failed");
}

test("a bad key (401) or an account out of credit: both fixed by another key", async () => {
  const invalid = await failWith(401, {
    message:
      "Incorrect API key provided: sk-proj-***0000. You can find your API key at https://platform.openai.com/account/api-keys.",
    type: "invalid_request_error",
    code: "invalid_api_key",
  });
  assert.deepEqual(invalid.classified, { kind: "key", problem: "This key is invalid. Check it was copied in full" });

  const broke = await failWith(429, {
    message: "You exceeded your current quota, please check your plan and billing details.",
    type: "insufficient_quota",
    code: "insufficient_quota",
  });
  assert.equal(broke.classified.kind, "key");
  assert.match(broke.classified.problem, /out of credit/);
});

test("rate limits and outages on their side: temporarily unavailable, try again later", async () => {
  const limited = await failWith(429, { message: "Rate limit reached for requests.", code: "rate_limit_exceeded" });
  assert.deepEqual(limited.classified, {
    kind: "unavailable",
    problem: "OpenAI is unavailable right now (Rate limit reached for requests). Try again later",
  });
  assert.equal((await failWith(503, { message: "Service unavailable." })).classified.kind, "unavailable");
});

test("a misspelled model (404) and other request problems say OpenAI rejected it and what it said", async () => {
  const missing = await failWith(404, {
    message: "The model `gpt-audio-9` does not exist or you do not have access to it.",
    type: "invalid_request_error",
    code: "model_not_found",
  });
  assert.equal(missing.classified.kind, "other");
  assert.match(
    missing.classified.problem,
    /^OpenAI doesn't have this model, or this key can't use it: The model `gpt-audio-9`/,
  );

  const bad = await failWith(400, {
    message: "This model does not support the format you provided.",
    code: "unsupported_format",
  });
  assert.deepEqual(bad.classified, {
    kind: "other",
    problem: "OpenAI rejected the request: This model does not support the format you provided",
  });
});

test("a non-JSON reply (a gateway's HTML page) still gives the status code", async () => {
  const fetch = async () => new Response("<html>Bad Gateway</html>", { status: 502 });
  const client = createClient({ apiKey: "k", model: "m", fetch });
  const error = await client.ping({}).catch((thrown) => thrown);
  assert.match(error.message, /502/);
  assert.equal(classifyError(error).kind, "unavailable");
});

test("errors not from OpenAI are left to the generic classification", () => {
  assert.equal(classifyError(new TypeError("fetch failed")), null);
});

test("an unsupported region (403 unsupported_country_region_territory) is a network exit problem; it does not ask for another key", async () => {
  const region = await failWith(403, {
    message: "Country, region, or territory not supported",
    type: "request_forbidden",
    code: "unsupported_country_region_territory",
  });
  assert.equal(region.classified.kind, "unavailable");
  assert.match(region.classified.problem, /region/);
  assert.match(region.classified.problem, /proxy/);
});

test("a non-JSON 4xx (a gateway's 413) still includes the status code, not an empty sentence", async () => {
  for (const status of [400, 413]) {
    const fetch = async () => new Response("<html>nope</html>", { status });
    const error = await createClient({ apiKey: "k", model: "m", fetch })
      .ping({})
      .catch((thrown) => thrown);
    assert.match(en.text(classifyError(error).problem), new RegExp(`HTTP ${status}$`));
  }
});
