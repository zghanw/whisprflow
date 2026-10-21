import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TRANSCRIBER } from "../../src/models/catalog.mjs";
import { loadConfig } from "../../src/server/config.mjs";

test("native mode with only a Gemini key: everything else uses defaults, listening on this computer only", () => {
  assert.deepEqual(loadConfig({ WHISPRFLOW_MODE: "native", GEMINI_API_KEY: "k" }), {
    host: "127.0.0.1",
    port: 8790,
    route: { mode: "native", model: { provider: "gemini", model: "gemini-3.6-flash" }, thinkingLevel: "MINIMAL" },
    apiKey: "k",
    keys: { gemini: "k" },
    modelSource: "original",
  });
});

test("cleanup by Ollama needs no key: no key variables are required, and apiKey is null", () => {
  const config = loadConfig({ WHISPRFLOW_MODE: "local" });
  assert.deepEqual(config.keys, {});
  assert.equal(config.apiKey, null);
  assert.deepEqual(config.route.polish, { vendor: "ollama", model: "qwen3:4b-instruct" });
});

test("WHISPRFLOW_MODEL picks the vendor and model; the key comes from that vendor's variable", () => {
  const config = loadConfig({
    WHISPRFLOW_MODE: "native",
    WHISPRFLOW_MODEL: "openai/gpt-audio-1.5",
    OPENAI_API_KEY: "sk-test",
  });
  assert.deepEqual(config.route.model, { provider: "openai", model: "gpt-audio-1.5" });
  assert.equal(config.apiKey, "sk-test");
  // OpenAI chosen but only a Gemini key given: it names the missing one
  assert.throws(
    () => loadConfig({ WHISPRFLOW_MODE: "native", WHISPRFLOW_MODEL: "openai", GEMINI_API_KEY: "k" }),
    /OPENAI_API_KEY/,
  );
});

test("variables can change the port and thinking level; the older GEMINI_MODEL still works and WHISPRFLOW_MODEL wins", () => {
  const config = loadConfig({
    WHISPRFLOW_MODE: "native",
    GEMINI_API_KEY: "k",
    PORT: "9001",
    GEMINI_MODEL: "gemini-3.8-flash",
    GEMINI_THINKING_LEVEL: "low",
  });
  assert.equal(config.port, 9001);
  assert.deepEqual(config.route.model, { provider: "gemini", model: "gemini-3.8-flash" });
  assert.equal(config.route.thinkingLevel, "LOW");
  const both = loadConfig({
    WHISPRFLOW_MODE: "native",
    WHISPRFLOW_MODEL: "openai",
    GEMINI_MODEL: "gemini-3.8-flash",
    OPENAI_API_KEY: "k",
  });
  assert.equal(both.route.model.provider, "openai");
});

test("native mode without a key is an error that says how to provide it", () => {
  assert.throws(() => loadConfig({ WHISPRFLOW_MODE: "native" }), /GEMINI_API_KEY/);
  assert.throws(() => loadConfig({ WHISPRFLOW_MODE: "native", GEMINI_API_KEY: "  " }), /GEMINI_API_KEY/);
});

test("a wrong port, model, or thinking level is an error naming the variable, never a quiet default", () => {
  for (const PORT of ["abc", "0", "70000", "80.5"]) {
    assert.throws(() => loadConfig({ WHISPRFLOW_MODE: "native", GEMINI_API_KEY: "k", PORT }), /PORT/);
  }
  assert.throws(
    () => loadConfig({ WHISPRFLOW_MODE: "native", GEMINI_API_KEY: "k", GEMINI_THINKING_LEVEL: "none" }),
    /GEMINI_THINKING_LEVEL/,
  );
  assert.throws(
    () => loadConfig({ WHISPRFLOW_MODE: "native", GEMINI_API_KEY: "k", WHISPRFLOW_MODEL: "deepseek/x" }),
    /WHISPRFLOW_MODEL.*deepseek/,
  );
});

test("a malformed key is rejected before reaching the SDK, which would echo the whole input in its error", () => {
  assert.throws(
    () => loadConfig({ WHISPRFLOW_MODE: "native", GEMINI_API_KEY: "line-one-SECRET\nline-two-SECRET" }),
    (error) => /GEMINI_API_KEY/.test(error.message) && !/SECRET/.test(error.message),
  );
});

test("an empty model variable counts as unset and the default is used", () => {
  assert.deepEqual(loadConfig({ WHISPRFLOW_MODE: "native", GEMINI_API_KEY: "k", GEMINI_MODEL: "" }).route.model, {
    provider: "gemini",
    model: "gemini-3.6-flash",
  });
  assert.equal(
    loadConfig({ WHISPRFLOW_MODE: "native", GEMINI_API_KEY: "k", WHISPRFLOW_MODEL: " " }).route.model.provider,
    "gemini",
  );
});

test("with nothing set it is local mode: the default on-device model and Ollama cleanup, with no key", () => {
  assert.deepEqual(loadConfig({}), loadConfig({ WHISPRFLOW_MODE: "local" }));
  assert.deepEqual(loadConfig({}), {
    host: "127.0.0.1",
    port: 8790,
    route: {
      mode: "local",
      transcriber: DEFAULT_TRANSCRIBER,
      polish: { vendor: "ollama", model: "qwen3:4b-instruct" },
      customUrl: null,
    },
    apiKey: null,
    keys: {},
    modelSource: "original",
  });
});

test("local path: change the model and the cleanup vendor; a custom service needs an address", () => {
  const config = loadConfig({
    WHISPRFLOW_MODE: "local",
    WHISPRFLOW_TRANSCRIBER: "qwen3-asr-0.6b-int8",
    WHISPRFLOW_POLISH: "custom/qwen3:8b",
    WHISPRFLOW_CUSTOM_URL: "http://127.0.0.1:11434/v1/",
    WHISPRFLOW_CUSTOM_API_KEY: "ollama",
  });
  assert.deepEqual(config.route, {
    mode: "local",
    transcriber: "qwen3-asr-0.6b-int8",
    polish: { vendor: "custom", model: "qwen3:8b" },
    customUrl: "http://127.0.0.1:11434/v1",
  });
  assert.equal(config.apiKey, "ollama");
  assert.throws(
    () => loadConfig({ WHISPRFLOW_MODE: "local", WHISPRFLOW_POLISH: "custom/m", WHISPRFLOW_CUSTOM_API_KEY: "k" }),
    /WHISPRFLOW_CUSTOM_URL/,
  );
});

test("a wrong mode, on-device model, or cleanup choice names the variable", () => {
  assert.throws(() => loadConfig({ WHISPRFLOW_MODE: "cloud", GEMINI_API_KEY: "k" }), /WHISPRFLOW_MODE.*native/);
  assert.throws(
    () => loadConfig({ WHISPRFLOW_MODE: "local", WHISPRFLOW_TRANSCRIBER: "whisper-9" }),
    /WHISPRFLOW_TRANSCRIBER.*qwen3-asr-0\.6b-q8/,
  );
  assert.throws(() => loadConfig({ WHISPRFLOW_MODE: "local", WHISPRFLOW_POLISH: "nobody/x" }), /WHISPRFLOW_POLISH/);
});

test("download source: WHISPRFLOW_MODEL_SOURCE picks where to download first; a wrong one lists the choices", () => {
  const env = { WHISPRFLOW_MODE: "local" };
  assert.equal(loadConfig({ ...env, WHISPRFLOW_MODEL_SOURCE: "mirror" }).modelSource, "mirror");
  assert.throws(
    () => loadConfig({ ...env, WHISPRFLOW_MODEL_SOURCE: "s3" }),
    /WHISPRFLOW_MODEL_SOURCE.*original \/ mirror/,
  );
});
