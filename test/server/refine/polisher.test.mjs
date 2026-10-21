import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator, msg } from "../../../src/i18n/index.mjs";
import { ModelError } from "../../../src/server/providers/errors.mjs";
import { POLISH_EXAMPLES, POLISH_PROMPT, polishInput } from "../../../src/server/refine/polish-prompt.mjs";
import { createChatPolisher, createPolisher } from "../../../src/server/refine/polisher.mjs";
import { NO_SPEECH_MARK } from "../../../src/server/refine/prompt.mjs";

const en = createTranslator("en");
const quiet = { info() {}, warn() {}, error() {} };
const USAGE = {
  model: "qwen3:4b-instruct",
  inputTokens: 1043,
  audioTokens: 0,
  cachedTokens: 1000,
  outputTokens: 14,
  thinkingTokens: 0,
  costUsd: 0,
};

/** Fake protocol client: records requests and answers with the given replies in order (throws an Error reply) */
function fakeClient(...replies) {
  const requests = [];
  const client = {
    async ping(request) {
      requests.push({ ping: request });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply ?? { usage: USAGE };
    },
    async complete(request) {
      requests.push(request);
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { client, requests };
}

const polisherWith = (client, extra = {}) =>
  createPolisher({ endpoint: { id: "ollama", name: "Ollama" }, client, log: quiet, ...extra });

test("the no-speech marker in the prompt is the one the finishing step checks; the transcript goes in tags", () => {
  assert.ok(POLISH_PROMPT.includes(`output only ${NO_SPEECH_MARK} and nothing else`));
  assert.equal(polishInput("raw text"), "<transcript>raw text</transcript>");
});

test("the transcript goes to the model and the result goes through the finishing step", async () => {
  const { client, requests } = fakeClient({ text: '"I looked at this bug."', problem: null, usage: USAGE });
  const polisher = polisherWith(client);
  assert.equal(await polisher.polish("um I I looked at this bug", { audioId: "a1" }), "I looked at this bug.");
  assert.equal(requests[0].system, POLISH_PROMPT);
  assert.equal(requests[0].user, polishInput("um I I looked at this bug"));
});

test("an empty transcript (nothing transcribed) never calls the model and gives empty text", async () => {
  const { client, requests } = fakeClient();
  const polisher = polisherWith(client);
  assert.equal(await polisher.polish("  \n", {}), "");
  assert.equal(requests.length, 0);
});

test("when the model finds nothing to type (outputs the marker) the result is empty", async () => {
  const { client } = fakeClient({ text: NO_SPEECH_MARK, problem: null, usage: USAGE });
  assert.equal(await polisherWith(client).polish("Um.", {}), "");
});

test("a client disconnect cancels the request: the signal given to the protocol client follows it", async () => {
  const { client, requests } = fakeClient({ text: "OK", problem: null, usage: USAGE });
  const abort = new AbortController();
  await polisherWith(client).polish("OK", { signal: abort.signal });
  assert.equal(requests[0].signal.aborted, false);
  abort.abort();
  assert.equal(requests[0].signal.aborted, true);
});

test("a reply that can't be used (truncated) is billed first, then reported as a classified error", async () => {
  const calls = [];
  const problem = msg("model.unfinished", { provider: "Ollama", reason: "length" });
  const { client } = fakeClient({ text: null, problem, usage: USAGE });
  const polisher = polisherWith(client, { onCall: (call) => calls.push(call) });
  const error = await polisher.polish("raw text", { audioId: "a1" }).catch((e) => e);
  assert.ok(error instanceof ModelError);
  assert.equal(en.text(error.problem), "Ollama didn't finish normally: length");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].purpose, "dictation");
  assert.equal(calls[0].audioId, "a1");
  assert.equal(calls[0].provider, "ollama");
});

test("every cleanup is recorded: which dictation, which vendor, tokens, cost, and time", async () => {
  const calls = [];
  const { client } = fakeClient({ text: "Sounds good", problem: null, usage: USAGE });
  await polisherWith(client, { onCall: (call) => calls.push(call) }).polish("sounds good", { audioId: "a9" });
  assert.equal(calls.length, 1);
  const { latencyMs, createdAt, ...call } = calls[0];
  assert.ok(Number.isInteger(latencyMs));
  assert.ok(!Number.isNaN(Date.parse(createdAt)));
  assert.deepEqual(call, { purpose: "dictation", audioId: "a9", provider: "ollama", ...USAGE });
});

test("warmUp sends the protocol client's smallest request and records a check; failures are classified too, without the key", async () => {
  const calls = [];
  const { client } = fakeClient({ usage: USAGE });
  await polisherWith(client, { onCall: (call) => calls.push(call) }).warmUp();
  assert.equal(calls[0].purpose, "check");

  const failing = fakeClient(new Error("connect ECONNREFUSED sk-secret"));
  failing.client.ping = async () => {
    const error = new Error("fetch failed");
    error.cause = { code: "ECONNREFUSED" };
    throw error;
  };
  const error = await polisherWith(failing.client, { apiKey: "sk-secret" })
    .warmUp()
    .catch((e) => e);
  assert.ok(error instanceof ModelError);
  assert.equal(error.kind, "unavailable");
  assert.match(en.text(error.problem), /Can't reach Ollama/);
});

test("createChatPolisher: sets up the chosen vendor's protocol, address, and parameters; the request really goes to that address", async () => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return Response.json({
      model: "qwen3:4b-instruct",
      choices: [{ finish_reason: "stop", message: { content: "Sounds good." } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
  };
  const polisher = await createChatPolisher({
    choice: { vendor: "ollama", model: "qwen3:4b-instruct" },
    log: quiet,
    fetch,
  });
  assert.equal(await polisher.polish("sounds good", {}), "Sounds good.");
  assert.equal(requests[0].url, "http://localhost:11434/v1/chat/completions");
  assert.equal(requests[0].body.model, "qwen3:4b-instruct");
  assert.equal("Authorization" in requests[0].headers, false);
});

test("createChatPolisher: custom uses the address from settings and names its host in errors; no address fails right away", async () => {
  const fetch = async () => new Response("<html>nope</html>", { status: 404 });
  const polisher = await createChatPolisher({
    choice: { vendor: "custom", model: "qwen3:8b" },
    customUrl: "http://127.0.0.1:11434/v1/",
    apiKey: "ollama",
    log: quiet,
    fetch,
  });
  const error = await polisher.polish("sounds good", {}).catch((e) => e);
  assert.ok(error instanceof ModelError);
  assert.match(en.text(error.problem), /127\.0\.0\.1:11434 has no chat API at this address/);

  await assert.rejects(createChatPolisher({ choice: { vendor: "custom", model: "m" }, apiKey: "k", log: quiet }), (e) =>
    /address/.test(en.text(e.problem)),
  );
});

/** A fake on-device service: lists models, records cleanups, and can refuse connections */
function fakeLocalService({ models = ["qwen3:4b-instruct"], down = false } = {}) {
  const requests = [];
  const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const client = {
    async listModels(request) {
      requests.push({ list: request });
      if (down) throw refused();
      return models;
    },
    async complete(request) {
      requests.push(request);
      return { text: "Warm up.", problem: null, usage: USAGE };
    },
  };
  return { client, requests };
}

const localPolisher = (client, events = []) =>
  createPolisher({
    endpoint: { id: "ollama", name: "Ollama", local: true },
    client,
    log: { ...quiet, info: (event) => events.push(event), warn: (event) => events.push(event) },
    localModel: "qwen3:4b-instruct",
  });

test("on-device warm-up: checks the service runs with the model, then loads it with one real cleanup in the background", async () => {
  const events = [];
  const { client, requests } = fakeLocalService();
  await localPolisher(client, events).warmUp();
  assert.ok(requests[0].list, "lists models first, which doesn't load anything");
  // The real cleanup goes out without being awaited
  assert.equal(requests[1].user, polishInput("warm up"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.includes("cleanup_primed"));
});

test("on-device warm-up: a model pulled without a tag counts (Ollama lists it as name:latest)", async () => {
  const { client } = fakeLocalService({ models: ["qwen3:4b-instruct:latest"] });
  await localPolisher(client).warmUp();
});

test("on-device warm-up: a model not pulled yet, or the service not running, is unavailable (cleanup is skipped), with a clear reason", async () => {
  const notPulled = await localPolisher(fakeLocalService({ models: ["llama3:latest"] }).client)
    .warmUp()
    .catch((error) => error);
  assert.ok(notPulled instanceof ModelError);
  assert.equal(notPulled.kind, "unavailable");
  assert.equal(en.text(notPulled.problem), "qwen3:4b-instruct isn't downloaded in Ollama yet");

  const down = await localPolisher(fakeLocalService({ down: true }).client)
    .warmUp()
    .catch((error) => error);
  assert.equal(down.kind, "unavailable");
  assert.equal(en.text(down.problem), "Ollama isn't running. Start it, or install it from ollama.com");
});

test("the dictionary's terms go in the prompt as preferred spellings, read fresh for each dictation", async () => {
  const terms = ["Kubernetes"];
  const dictionary = { terms: () => [...terms], learn: () => [] };
  const { client, requests } = fakeClient(
    { text: "We use Kubernetes.", problem: null, usage: USAGE },
    { text: "We use WhisprFlow.", problem: null, usage: USAGE },
  );
  const polisher = polisherWith(client, { dictionary });
  await polisher.polish("we use kubernetes", {});
  assert.match(requests[0].system, /Prefer these spellings for names and jargon: Kubernetes\./);
  terms.push("WhisprFlow");
  await polisher.polish("we use whisper flow", {});
  assert.match(requests[1].system, /Prefer these spellings for names and jargon: Kubernetes, WhisprFlow\./);
});

test("on-device cleanup learns from the finished text in the background; a cloud service never does", async () => {
  const learned = [];
  const dictionary = {
    terms: () => [],
    learn(terms) {
      learned.push(...terms);
      return terms;
    },
  };
  const replies = [
    { text: "We moved to Kubernetes last week.", problem: null, usage: USAGE },
    { text: "Kubernetes", problem: null, usage: USAGE },
  ];
  const client = { complete: async () => replies.shift() };
  const local = createPolisher({
    endpoint: { id: "ollama", name: "Ollama", local: true },
    client,
    log: quiet,
    localModel: "qwen3:4b-instruct",
    dictionary,
  });
  assert.equal(await local.polish("we moved to kubernetes last week", {}), "We moved to Kubernetes last week.");
  for (let i = 0; i < 5 && learned.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(learned, ["Kubernetes"]);

  const cloud = fakeClient({ text: "We moved to Kubernetes last week.", problem: null, usage: USAGE });
  await polisherWith(cloud.client, { dictionary }).polish("we moved to kubernetes last week", {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cloud.requests.length, 1, "no second request to learn");
});

test("the app being typed into goes in the prompt with the light tone rule; without it, neither does", async () => {
  const { client, requests } = fakeClient(
    { text: "Can't make it today.", problem: null, usage: USAGE },
    { text: "Cannot make it today.", problem: null, usage: USAGE },
  );
  const polisher = polisherWith(client);
  await polisher.polish("cant make it today", { app: "slack" });
  assert.match(requests[0].system, /The user is typing into: slack\./);
  assert.match(requests[0].system, /- Tone: in chat apps/);
  assert.match(requests[0].system, /reword \(beyond contractions\)/);
  await polisher.polish("cant make it today", {});
  assert.equal(requests[1].system, POLISH_PROMPT);
});

test("cleanup on this computer (Ollama) is billed as free, not as an unknown price", async () => {
  const calls = [];
  const fetch = async () =>
    new Response(
      JSON.stringify({
        model: "qwen3:4b-instruct",
        choices: [{ message: { content: "Done." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 300, completion_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const polisher = await createChatPolisher({
    choice: { vendor: "ollama", model: "qwen3:4b-instruct" },
    apiKey: null,
    log: quiet,
    onCall: (call) => calls.push(call),
    fetch,
  });
  await polisher.polish("done", { audioId: "a1" });
  assert.equal(calls[0].costUsd, 0);
});

test("the two examples go with every cleanup, as earlier chat turns: a question stays a question, a request stays a request", async () => {
  const { client, requests } = fakeClient({ text: "Ship it.", problem: null, usage: USAGE });
  await polisherWith(client).polish("ship it", {});
  assert.equal(requests[0].examples, POLISH_EXAMPLES);
  assert.deepEqual(
    POLISH_EXAMPLES.map(({ assistant }) => assistant),
    ["What time does the meeting start?", "Can you write up a summary of the Q4 numbers?"],
  );
});
