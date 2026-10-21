import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import { classifyError, createClient } from "../../../src/server/chat/openai-chat.mjs";
import { toModelError } from "../../../src/server/providers/errors.mjs";

const en = createTranslator("en");

/** Fake fetch: records requests and answers with the given status and body (a string body is sent as is, like a gateway's HTML) */
function fakeFetch(status, body) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetch, requests };
}

/** Usage from a service that lists cache hits separately: prompt_tokens is the sum of both */
const CACHED_USAGE = {
  prompt_tokens: 1043,
  completion_tokens: 14,
  total_tokens: 1057,
  prompt_tokens_details: { cached_tokens: 1000 },
  prompt_cache_hit_tokens: 1000,
  prompt_cache_miss_tokens: 43,
};

const completion = (content, finish_reason = "stop", { usage = CACHED_USAGE, ...message } = {}) => ({
  model: "example-chat",
  choices: [{ index: 0, finish_reason, message: { role: "assistant", content, ...message } }],
  usage,
});

const BASE = "https://api.example.com/v1";
const AT = new Date("2026-10-17T12:00:00Z");

test("cleanup: the system prompt and the transcript go as two messages with the vendor's extra parameters; the reply is text, usage, and cost", async () => {
  const { fetch, requests } = fakeFetch(200, completion("We meet on Friday afternoon."));
  const costOf = (model, tokens, at) => {
    assert.equal(model, "example-chat");
    assert.deepEqual(tokens, { input: 43, cached: 1000, output: 14 });
    assert.equal(at, AT);
    return 0.0001;
  };
  const client = createClient({
    baseUrl: BASE,
    apiKey: "sk-test",
    model: "example-chat",
    request: { thinking: { type: "disabled" } },
    costOf,
    now: () => AT,
    fetch,
  });
  const signal = new AbortController().signal;
  const reply = await client.complete({ system: "system prompt", user: "transcript", signal });
  assert.deepEqual(reply, {
    text: "We meet on Friday afternoon.",
    problem: null,
    usage: {
      model: "example-chat",
      inputTokens: 1043,
      audioTokens: 0,
      cachedTokens: 1000,
      outputTokens: 14,
      thinkingTokens: 0,
      costUsd: 0.0001,
    },
  });
  const [{ url, init, body }] = requests;
  assert.equal(url, "https://api.example.com/v1/chat/completions");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer sk-test");
  assert.equal(init.signal, signal);
  assert.deepEqual(body, {
    model: "example-chat",
    thinking: { type: "disabled" },
    messages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: "transcript" },
    ],
  });
});

test("cache hits are also read from prompt_tokens_details.cached_tokens alone; with no known price the cost is empty", async () => {
  const usage = { prompt_tokens: 500, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 128 } };
  const { fetch } = fakeFetch(200, completion("OK", "stop", { usage }));
  const client = createClient({ baseUrl: "https://x.example/v1", apiKey: "k", model: "m", fetch });
  const { usage: billed } = await client.complete({ system: "s", user: "u" });
  assert.equal(billed.cachedTokens, 128);
  assert.equal(billed.inputTokens, 500);
  assert.equal(billed.costUsd, null);
});

test("thinking tokens are recorded; the thinking itself is never the result", async () => {
  const usage = { ...CACHED_USAGE, completion_tokens: 348, completion_tokens_details: { reasoning_tokens: 334 } };
  const { fetch } = fakeFetch(200, completion("Result", "stop", { usage, reasoning_content: "thought a lot" }));
  const client = createClient({ baseUrl: BASE, apiKey: "k", model: "example-chat", fetch });
  const reply = await client.complete({ system: "s", user: "u" });
  assert.equal(reply.text, "Result");
  assert.equal(reply.usage.thinkingTokens, 334);
  assert.equal(reply.usage.outputTokens, 348);
});

test("truncated, filtered, or refused replies give no partial text, say why, and still return usage for billing", async () => {
  for (const [finish, extra, pattern] of [
    ["length", {}, /didn't finish normally: length/],
    ["content_filter", {}, /didn't process.*content_filter/],
    ["insufficient_system_resource", {}, /didn't finish normally: insufficient_system_resource/],
    ["stop", { refusal: "I can't help with that" }, /didn't process.*I can't help with that/],
  ]) {
    const { fetch } = fakeFetch(200, completion("partial", finish, extra));
    const client = createClient({ baseUrl: BASE, apiKey: "k", model: "example-chat", name: "Example", fetch });
    const reply = await client.complete({ system: "s", user: "u" });
    assert.equal(reply.text, null, finish);
    assert.match(en.text(reply.problem), pattern);
    assert.match(en.text(reply.problem), /Example/);
    assert.equal(reply.usage.inputTokens, 1043);
  }
});

test("the check asks for 1 token; a length finish is not a failure", async () => {
  const { fetch, requests } = fakeFetch(200, completion("H", "length"));
  const client = createClient({
    baseUrl: BASE,
    apiKey: "k",
    model: "example-chat",
    request: { thinking: { type: "disabled" } },
    fetch,
  });
  const { usage } = await client.ping({});
  assert.equal(usage.model, "example-chat");
  assert.equal(requests[0].body.max_tokens, 1);
  assert.deepEqual(requests[0].body.thinking, { type: "disabled" });
});

test("listing models: GET /models returns the ids", async () => {
  const { fetch, requests } = fakeFetch(200, {
    object: "list",
    data: [
      { id: "example-chat", object: "model" },
      { id: "example-pro", object: "model" },
    ],
  });
  const client = createClient({ baseUrl: BASE, apiKey: "k", model: "example-chat", fetch });
  assert.deepEqual(await client.listModels({}), ["example-chat", "example-pro"]);
  assert.equal(requests[0].url, "https://api.example.com/v1/models");
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.headers.Authorization, "Bearer k");
});

/** Lets the adapter make a real request, takes the error it throws, and classifies it by the rules in errors.mjs */
async function failure(status, body, name = "Example") {
  const { fetch } = fakeFetch(status, body);
  const client = createClient({ baseUrl: BASE, apiKey: "sk-secret", model: "example-chat", name, fetch });
  try {
    await client.complete({ system: "s", user: "u" });
  } catch (error) {
    const modelError = toModelError(error, {
      provider: { name },
      apiKey: "sk-secret",
      classify: (e) => classifyError(e, { name }),
    });
    return { kind: modelError.kind, problem: en.text(modelError.problem) };
  }
  assert.fail("should have thrown");
}

const said = (message, code = "invalid_request_error") => ({ error: { message, type: code, code } });

test("errors are classified by status: 401 bad key, 402 no credit, 429 and 5xx temporarily unavailable", async () => {
  assert.deepEqual(await failure(401, said("Authentication Fails")), {
    kind: "key",
    problem: "This key is invalid. Check it was copied in full",
  });
  assert.equal((await failure(402, said("Insufficient Balance"))).kind, "key");
  assert.match((await failure(402, said("Insufficient Balance"))).problem, /out of credit/);
  for (const status of [429, 500, 503]) {
    const { kind, problem } = await failure(status, said("Server Overloaded"));
    assert.equal(kind, "unavailable", String(status));
    assert.match(problem, /Example is unavailable right now \(Server Overloaded\)/);
  }
});

test("no-credit error codes are recognized too: Zhipu's 429 with 1113 (by status alone it would look temporary), Alibaba Cloud's 400 with Arrearage", async () => {
  const zhipu = await failure(429, { error: { code: "1113", message: "Insufficient balance" } }, "Zhipu");
  assert.equal(zhipu.kind, "key");
  assert.match(zhipu.problem, /out of credit/);
  const alibaba = await failure(
    400,
    said("Access denied, please make sure your account is in good standing.", "Arrearage"),
    "Alibaba Cloud",
  );
  assert.equal(alibaba.kind, "key");
  assert.match(alibaba.problem, /out of credit/);
  // Real rate limiting (1302) is still temporarily unavailable
  assert.equal(
    (await failure(429, { error: { code: "1302", message: "Too many requests" } }, "Zhipu")).kind,
    "unavailable",
  );
});

test("a misspelled model name (the service answers 400 listing valid names): its own message is shown", async () => {
  const { kind, problem } = await failure(
    400,
    said("The supported API model names are example-chat, example-pro, but you passed example-nope."),
  );
  assert.equal(kind, "other");
  assert.match(problem, /Example rejected the request: The supported API model names are/);
});

test("a 404 that isn't JSON usually means a wrong address: it says to check the address, not the model", async () => {
  const { kind, problem } = await failure(404, "<html>Not Found</html>", "api.example.com");
  assert.equal(kind, "other");
  assert.match(problem, /api\.example\.com/);
  assert.match(problem, /address/);
});

test("a 404 about the model says the model was not found", async () => {
  const { problem } = await failure(404, said("The model `x` does not exist", "model_not_found"));
  assert.match(problem, /doesn't have this model/);
});

test("an error written as a plain string (as Ollama does) still yields its message", async () => {
  const { problem } = await failure(400, { error: "model 'qwen3' not found" }, "127.0.0.1:11434");
  assert.match(problem, /model 'qwen3' not found/);
});

test("errors this adapter didn't throw are not recognized", () => {
  assert.equal(classifyError(new Error("something else"), { name: "Example" }), null);
});

test("examples go before the real message as earlier turns of the conversation", async () => {
  const { fetch, requests } = fakeFetch(200, completion("Done."));
  const client = createClient({ baseUrl: BASE, apiKey: "sk-test", model: "example-chat", fetch });
  await client.complete({
    system: "rules",
    examples: [
      { user: "<transcript>uh hi</transcript>", assistant: "Hi." },
      { user: "<transcript>ok bye</transcript>", assistant: "OK, bye." },
    ],
    user: "<transcript>real one</transcript>",
  });
  assert.deepEqual(
    requests[0].body.messages.map(({ role, content }) => `${role}: ${content}`),
    [
      "system: rules",
      "user: <transcript>uh hi</transcript>",
      "assistant: Hi.",
      "user: <transcript>ok bye</transcript>",
      "assistant: OK, bye.",
      "user: <transcript>real one</transcript>",
    ],
  );
});
