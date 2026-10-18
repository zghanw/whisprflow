import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyManager } from "../../src/app/keys/key-manager.mjs";
import { createModeSwitch } from "../../src/app/modes.mjs";
import { startService } from "../../src/app/service.mjs";
import { keyVendorOf } from "../../src/server/modes.mjs";
import { VENDORS } from "../../src/server/vendors.mjs";
import { resolveSettings, routeOf } from "../../src/storage/settings.mjs";

// The whole core assembled: the real service, refiner, key manager, and mode switch; only the vendor APIs (the fetch below) and on-device models are fake.
// The fake service in key-manager.test.mjs and modes.test.mjs ignores how many vendors a route uses and whether they need keys, so cross-layer bugs only show here.
// Each test file using it runs in its own process (node --test), so replacing the global fetch affects no other file.

/** These keys pass, anything else gets 401 */
const GOOD = new Set(["custom-good", "oa-good"]);
/** Ollama runs on this computer and takes no key */
const OLLAMA = "http://localhost:11434/";

/** Requests sent: which address, with which key */
export const requests = [];

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init) => {
  const key = String(init.headers?.Authorization ?? "").replace(/^Bearer /, "");
  requests.push({ url: String(url), key });
  if (!GOOD.has(key) && !String(url).startsWith(OLLAMA))
    return reply({ error: { code: "invalid_api_key", message: "Incorrect API key provided" } }, 401);
  // Ollama's warm-up lists its models first: the default cleanup model is pulled
  if (init.method === "GET") return reply({ object: "list", data: [{ id: "qwen3:4b-instruct", object: "model" }] });
  const body = JSON.parse(init.body);
  return reply({
    model: body.model,
    choices: [{ message: { content: "" }, finish_reason: "length" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, seconds: 1 },
  });
};

const fakeStore = (value = null) => ({
  value,
  load() {
    return this.value;
  },
  save(next) {
    this.value = next;
  },
  clear() {
    this.value = null;
  },
  exists() {
    return this.value !== null;
  },
});
const silent = { info() {}, warn() {}, error() {} };

/**
 * Starts a set with the given settings and stored keys. The service closes when the test ends (even on failure, or the process wouldn't exit)
 * @param {import("node:test").TestContext} t
 * @param {{ settings: object, stored?: Record<string, string>, installed?: string[] }} options
 *   installed: the downloaded on-device models; all of them when left out
 */
export async function boot(t, { settings, stored = {}, installed = null }) {
  const home = mkdtempSync(join(tmpdir(), "whisprflow-routes-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const settingsFile = join(home, "settings.json");
  writeFileSync(settingsFile, JSON.stringify(settings));
  const route = routeOf(resolveSettings({ file: settingsFile, env: {} }));
  const keyStores = Object.fromEntries(VENDORS.map(({ id }) => [id, fakeStore(stored[id] ?? null)]));
  const models = {
    isInstalled: (id) => installed === null || installed.includes(id),
    status: () => ({ download: null }),
    remove: (id) => ({ ok: true, removed: id }),
  };
  const service = await startService({
    log: silent,
    route,
    modelsDir: home,
    models,
    startLocal: async () => ({ backend: "cpu", transcribe: async () => ({ text: "" }), dispose() {} }),
  });
  t.after(() => service.close());
  let modes;
  const keys = createKeyManager({
    service,
    provider: keyVendorOf(route) ?? null,
    keyStores,
    env: {},
    log: silent,
    onChange() {},
    routeFor: (id) => modes.routeForVendor(id),
  });
  modes = createModeSwitch({ service, keys, models, settingsFile, env: {}, log: silent });
  /** What the settings file holds now */
  const saved = () => JSON.parse(readFileSync(settingsFile, "utf8"));
  return { service, keys, modes, keyStores, saved };
}

/** Dictates once like the page does (protocol in src/server/server.mjs) and returns the service's last message */
export function dictateOnce(url) {
  const chunk = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60)]);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const audioId = crypto.randomUUID();
    socket.onerror = () => reject(new Error("Can't reach the built-in service"));
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "start_audio", audio_id: audioId }));
      socket.send(JSON.stringify({ type: "set_audio_chunk_info", audio_id: audioId, index: 1, size: chunk.length }));
      socket.send(chunk);
      socket.send(JSON.stringify({ type: "end_audio", audio_id: audioId }));
    };
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.K !== "audio_processing_completed" && message.K !== "audio_processing_error") return;
      socket.close();
      resolve(message);
    };
  });
}
