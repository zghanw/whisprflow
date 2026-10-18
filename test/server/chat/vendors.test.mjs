import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import {
  CHAT_VENDORS,
  chatEndpoint,
  findChatVendor,
  formatChatChoice,
  normalizeBaseUrl,
  PROTOCOLS,
  parseChatChoice,
  requestFor,
} from "../../../src/server/chat/vendors.mjs";

const en = createTranslator("en");
const problem = (fn) => {
  try {
    fn();
  } catch (error) {
    return en.text(error.problem);
  }
  assert.fail("should have thrown");
};
/** What the error message mentions when the input is wrong */
const says = (fn, pattern) => assert.match(problem(fn), pattern);

test("every vendor's protocol is registered; remote addresses are https, local ones may be plain http", () => {
  for (const vendor of CHAT_VENDORS) {
    assert.ok(PROTOCOLS[vendor.protocol], `${vendor.id}: protocol ${vendor.protocol} is not registered`);
    if (vendor.baseUrl !== null) {
      const { protocol, hostname } = new URL(vendor.baseUrl);
      const local = hostname === "localhost" || hostname === "127.0.0.1";
      assert.ok(protocol === "https:" || local, `${vendor.id}: a remote address must be https`);
    }
    assert.match(vendor.id, /^[a-z0-9]+$/, "the id must work as a key file name");
  }
});

test("a bare vendor uses its default model; an explicit model is used as written, and may contain / and :", () => {
  assert.deepEqual(parseChatChoice("ollama"), { vendor: "ollama", model: "qwen3:4b-instruct" });
  assert.deepEqual(parseChatChoice(" Ollama/llama3.2:3b "), { vendor: "ollama", model: "llama3.2:3b" });
  // OpenRouter and SiliconFlow model names contain slashes, Ollama's contain colons
  assert.deepEqual(parseChatChoice("custom/Qwen/Qwen3-8B"), { vendor: "custom", model: "Qwen/Qwen3-8B" });
  assert.deepEqual(parseChatChoice("custom/qwen3:8b"), { vendor: "custom", model: "qwen3:8b" });
  assert.equal(formatChatChoice({ vendor: "custom", model: "Qwen/Qwen3-8B" }), "custom/Qwen/Qwen3-8B");
});

test("a model name outside the list is accepted too: the vendor decides whether it exists", () => {
  assert.deepEqual(parseChatChoice("ollama/gemma3:4b"), { vendor: "ollama", model: "gemma3:4b" });
});

test("a wrong choice says exactly what is wrong", () => {
  says(() => parseChatChoice(""), /empty/);
  says(() => parseChatChoice("nobody/x"), /nobody/);
  says(() => parseChatChoice("nobody/x"), /ollama/);
  // The custom service has no default model
  says(() => parseChatChoice("custom"), /model/);
  says(() => parseChatChoice("ollama/has space"), /has space/);
});

test("addresses drop a trailing slash and a pasted /chat/completions; only http(s), no credentials or query", () => {
  assert.equal(normalizeBaseUrl("https://api.example.com/v1/"), "https://api.example.com/v1");
  assert.equal(normalizeBaseUrl(" https://api.example.com/v1/chat/completions "), "https://api.example.com/v1");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1");
  says(() => normalizeBaseUrl(""), /empty/);
  says(() => normalizeBaseUrl("api.example.com"), /http/);
  says(() => normalizeBaseUrl("ftp://api.example.com"), /http/);
  says(() => normalizeBaseUrl("https://user:pass@api.example.com"), /password/);
  says(() => normalizeBaseUrl("https://api.example.com/v1?key=1"), /\?/);
});

test("endpoint: registered vendors use their address; custom uses the user's, named by its host (for error messages)", () => {
  assert.deepEqual(chatEndpoint(findChatVendor("ollama"), {}), {
    baseUrl: "http://localhost:11434/v1",
    name: "Ollama",
  });
  assert.deepEqual(chatEndpoint(findChatVendor("custom"), { customUrl: "https://api.siliconflow.cn/v1" }), {
    baseUrl: "https://api.siliconflow.cn/v1",
    name: "api.siliconflow.cn",
  });
  says(() => chatEndpoint(findChatVendor("custom"), {}), /address/);
});

test("listed models are unique, named, and attributed to a maker; the default model is in the list", () => {
  for (const vendor of CHAT_VENDORS) {
    const ids = vendor.models.map(({ id }) => id);
    assert.equal(new Set(ids).size, ids.length, `${vendor.id} has duplicate models`);
    for (const model of vendor.models) {
      assert.ok(model.name && model.maker, `${vendor.id}/${model.id} is missing a name or maker`);
      assert.ok(Object.isFrozen(model), `${vendor.id}/${model.id} is not frozen`);
    }
    if (vendor.defaultModel !== null)
      assert.ok(ids.includes(vendor.defaultModel), `${vendor.id}: default model not listed`);
  }
});

test("per-model request parameters: the vendor's plus the model's own; unlisted models get only the vendor's", () => {
  const vendor = {
    request: { enable_thinking: false, temperature: 1 },
    models: [{ id: "a", request: { temperature: 0.7 } }, { id: "b" }],
  };
  assert.deepEqual(requestFor(vendor, "a"), { enable_thinking: false, temperature: 0.7 });
  assert.deepEqual(requestFor(vendor, "b"), { enable_thinking: false, temperature: 1 });
  assert.deepEqual(requestFor(vendor, "elsewhere"), { enable_thinking: false, temperature: 1 });
});

test("Ollama runs locally: no key, no price, and its default model is the tested cleanup model", () => {
  const ollama = findChatVendor("ollama");
  assert.equal(ollama.keyEnv, null);
  assert.equal(ollama.prices, null);
  assert.equal(ollama.defaultModel, "qwen3:4b-instruct");
  assert.ok(ollama.models.find(({ id }) => id === "qwen3:4b-instruct").tested);
});

/**
 * Builds the vendor's protocol client the same way refine/polisher.mjs (createChatPolisher) does and
 * polishes once against a fake fetch. Returns the outgoing request and the parsed result.
 */
async function polishOnce(id, model, reply, { apiKey } = {}) {
  const vendor = findChatVendor(id);
  const { baseUrl, name } = chatEndpoint(vendor);
  const protocol = await PROTOCOLS[vendor.protocol].load();
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply), { status: 200 });
  };
  const client = protocol.createClient({
    baseUrl,
    apiKey,
    model,
    name,
    request: requestFor(vendor, model),
    costOf: vendor.prices ? (await vendor.prices()).costOf : null,
    fetch,
  });
  const result = await client.complete({ system: "s", user: "u" });
  return { request: requests[0], result };
}

test("Ollama: the request goes to localhost with no Authorization header; the text is in message.content", async () => {
  const { request, result } = await polishOnce("ollama", "qwen3:4b-instruct", {
    id: "chatcmpl-1",
    model: "qwen3:4b-instruct",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Meeting at 10 on Monday." } }],
    usage: { prompt_tokens: 400, completion_tokens: 8, total_tokens: 408 },
  });
  assert.equal(request.url, "http://localhost:11434/v1/chat/completions");
  assert.equal(request.body.model, "qwen3:4b-instruct");
  assert.equal("Authorization" in request.headers, false, "a keyless vendor must not send Bearer undefined");
  assert.equal(result.text, "Meeting at 10 on Monday.");
});

test("a vendor with a key sends it as a Bearer token", async () => {
  const { request } = await polishOnce(
    "ollama",
    "qwen3:4b-instruct",
    { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }] },
    { apiKey: "secret" },
  );
  assert.equal(request.headers.Authorization, "Bearer secret");
});
