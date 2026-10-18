import assert from "node:assert/strict";
import { test } from "node:test";
import { apiRootOf, ollamaStatus, pullModel } from "../../src/app/ollama.mjs";
import { createTranslator } from "../../src/i18n/index.mjs";

const en = createTranslator("en");
const BASE = "http://localhost:11434/v1";
const MODEL = "qwen3:4b-instruct";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A streamed reply: one JSON object per line, cut into chunks at awkward places like a real stream */
const stream = (lines) => {
  const text = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  const chunks = [text.slice(0, 7), text.slice(7, 60), text.slice(60)];
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return new Response(body);
};
const refused = async () => {
  throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
};

test("Ollama's own API sits next to its OpenAI-compatible address", () => {
  assert.equal(apiRootOf(BASE), "http://localhost:11434");
  assert.equal(apiRootOf("http://localhost:11434/v1/"), "http://localhost:11434");
});

test("status: running with the model (tagged or as name:latest), running without it, or not running", async () => {
  const seen = [];
  const tags = (names) => async (url) => {
    seen.push(url);
    return json({ models: names.map((name) => ({ name })) });
  };
  assert.deepEqual(await ollamaStatus({ baseUrl: BASE, model: MODEL, fetch: tags([MODEL, "llama3:latest"]) }), {
    running: true,
    pulled: true,
  });
  assert.equal(seen[0], "http://localhost:11434/api/tags");
  assert.deepEqual(await ollamaStatus({ baseUrl: BASE, model: "llama3", fetch: tags(["llama3:latest"]) }), {
    running: true,
    pulled: true,
  });
  assert.deepEqual(await ollamaStatus({ baseUrl: BASE, model: MODEL, fetch: tags([]) }), {
    running: true,
    pulled: false,
  });
  assert.deepEqual(await ollamaStatus({ baseUrl: BASE, model: MODEL, fetch: refused }), {
    running: false,
    pulled: false,
  });
});

test("pull: progress adds up the layers seen so far, and it resolves on success", async () => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return stream([
      { status: "pulling manifest" },
      { status: "pulling a", digest: "a", total: 1000, completed: 0 },
      { status: "pulling a", digest: "a", total: 1000, completed: 600 },
      { status: "pulling b", digest: "b", total: 10, completed: 10 },
      { status: "pulling a", digest: "a", total: 1000, completed: 1000 },
      { status: "verifying sha256 digest" },
      { status: "success" },
    ]);
  };
  const progress = [];
  await pullModel({ baseUrl: BASE, model: MODEL, fetch, onProgress: (p) => progress.push(p) });
  assert.deepEqual(requests, [{ url: "http://localhost:11434/api/pull", body: { model: MODEL, stream: true } }]);
  assert.deepEqual(progress, [
    { received: 0, total: 1000 },
    { received: 600, total: 1000 },
    { received: 610, total: 1010 },
    { received: 1010, total: 1010 },
  ]);
});

test("pull failures say why: Ollama not running, an error line, or a stream that stops before success", async () => {
  const down = await pullModel({ baseUrl: BASE, model: MODEL, fetch: refused, onProgress() {} }).catch((e) => e);
  assert.equal(en.text(down.problem), "Ollama isn't running. Start it, or install it from ollama.com");

  const missing = await pullModel({
    baseUrl: BASE,
    model: "nope:1b",
    fetch: async () => stream([{ status: "pulling manifest" }, { error: "pull model manifest: file does not exist" }]),
    onProgress() {},
  }).catch((e) => e);
  assert.equal(en.text(missing.problem), "Couldn't pull nope:1b into Ollama: pull model manifest: file does not exist");

  const cut = await pullModel({
    baseUrl: BASE,
    model: MODEL,
    fetch: async () => stream([{ status: "pulling a", digest: "a", total: 10, completed: 5 }]),
    onProgress() {},
  }).catch((e) => e);
  assert.match(en.text(cut.problem), /stopped early/);
});
