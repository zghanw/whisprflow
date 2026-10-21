import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { createModelStore } from "../../src/models/store.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const BYTES = { "a.onnx": Buffer.from("weights ".repeat(1000)), "tokenizer/vocab.json": Buffer.from('{"a":1}') };
const fileOf = (path) => ({ path, size: BYTES[path].length, sha256: sha256(BYTES[path]) });
const MODEL = {
  id: "fake-asr",
  origin: { repo: "someone/fake-asr", revision: "a".repeat(40) },
  files: { model: fileOf("a.onnx"), vocab: fileOf("tokenizer/vocab.json") },
};

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Everything after the pinned commit in an address is the file path */
const pathOf = (url) => url.split(`/${MODEL.origin.revision}/`)[1];

/** A temporary store with a fake fetch: serves content by the trailing path and records what was fetched */
function setUp({ serve = (path) => new Response(BYTES[path]) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "whisprflow-models-"));
  dirs.push(dir);
  const fetched = [];
  const fetch = async (url) => {
    const path = pathOf(url);
    fetched.push(path);
    return serve(path);
  };
  return { dir, fetched, store: createModelStore({ dir, fetch }) };
}

test("Hugging Face first by default: if it can't connect or returns an error code the mirror takes over; only when both fail is there an error listing each address", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whisprflow-models-"));
  dirs.push(dir);
  const hosts = [];
  const fetch = async (url) => {
    const { host, pathname } = new URL(url);
    hosts.push(host);
    if (host === "huggingface.co") throw new TypeError("fetch failed");
    return new Response(BYTES[pathOf(pathname)]);
  };
  const store = createModelStore({ dir, fetch });
  await store.install(MODEL);
  assert.equal(store.isInstalled(MODEL), true);
  const tried = ["huggingface.co", "hf-mirror.com"];
  assert.deepEqual(hosts, [...tried, ...tried]);

  const failing = createModelStore({
    dir: mkdtempSync(join(tmpdir(), "whisprflow-models-")),
    fetch: async (url) =>
      new URL(url).host === "huggingface.co"
        ? Promise.reject(new TypeError("fetch failed"))
        : new Response("", { status: 503 }),
  });
  await assert.rejects(
    failing.install(MODEL),
    (error) => /huggingface\.co.*fetch failed/s.test(error.message) && /hf-mirror\.com.*HTTP 503/s.test(error.message),
  );
});

test("choosing the mirror: hf-mirror first, Hugging Face after", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whisprflow-models-"));
  dirs.push(dir);
  const hosts = [];
  const fetch = async (url) => {
    const { host, pathname } = new URL(url);
    hosts.push(host);
    return host === "huggingface.co" ? new Response(BYTES[pathOf(pathname)]) : new Response("", { status: 503 });
  };
  await createModelStore({ dir, fetch, source: "mirror" }).install(MODEL);
  assert.deepEqual(hosts.slice(0, 2), ["hf-mirror.com", "huggingface.co"]);
});

test("connected but no data arrives: give up on that address in time and try the next", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whisprflow-models-"));
  dirs.push(dir);
  const fetch = async (url, { signal }) => {
    const { host, pathname } = new URL(url);
    if (host === "huggingface.co") {
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    }
    return new Response(BYTES[pathOf(pathname)]);
  };
  const store = createModelStore({ dir, fetch, stallMs: 50 });
  await store.install(MODEL);
  assert.equal(store.isInstalled(MODEL), true);
});

test("installing a model: files land at their catalog paths, verified, with a receipt; installing again downloads nothing", async () => {
  const { dir, fetched, store } = setUp();
  const progress = [];
  assert.equal(store.isInstalled(MODEL), false);
  const modelDir = await store.install(MODEL, { onProgress: (p) => progress.push(p) });
  assert.equal(modelDir, join(dir, "fake-asr"));
  assert.deepEqual(readFileSync(join(modelDir, "tokenizer/vocab.json")), BYTES["tokenizer/vocab.json"]);
  assert.deepEqual(readFileSync(join(modelDir, "a.onnx")), BYTES["a.onnx"]);
  assert.equal(store.isInstalled(MODEL), true);
  assert.deepEqual(store.installed(), ["fake-asr"]);
  // Progress counts the whole model: finished files in full, the current one as far as it got
  const total = BYTES["a.onnx"].length + 7;
  assert.deepEqual(progress.at(-1), { received: total, total });
  assert.ok(progress.every((p) => p.total === total && p.received <= total));

  await store.install(MODEL);
  assert.deepEqual(fetched, ["a.onnx", "tokenizer/vocab.json"]);
});

test("content that fails the check names the file, leaves no partial file, and does not count as installed", async () => {
  const { dir, store } = setUp({ serve: (path) => new Response(path === "a.onnx" ? "tampered" : BYTES[path]) });
  await assert.rejects(store.install(MODEL), /a\.onnx downloaded 8 bytes/);
  assert.equal(store.isInstalled(MODEL), false);
  assert.deepEqual(readdirSync(join(dir, "fake-asr")), []);
});

test("right size but wrong content reports a sha256 mismatch", async () => {
  const forged = Buffer.alloc(BYTES["a.onnx"].length, 1);
  const { store } = setUp({ serve: (path) => new Response(path === "a.onnx" ? forged : BYTES[path]) });
  await assert.rejects(store.install(MODEL), /a\.onnx sha256 mismatch/);
});

test("an error status from the server is reported, not taken as success", async () => {
  const { store } = setUp({ serve: () => new Response("nope", { status: 404 }) });
  await assert.rejects(store.install(MODEL), /HTTP 404/);
  assert.equal(store.isInstalled(MODEL), false);
});

test("resuming: files already present with the right content are not downloaded again, only the missing ones", async () => {
  const { dir, fetched, store } = setUp();
  mkdirSync(join(dir, "fake-asr"), { recursive: true });
  writeFileSync(join(dir, "fake-asr", "a.onnx"), BYTES["a.onnx"]);
  await store.install(MODEL);
  assert.deepEqual(fetched, ["tokenizer/vocab.json"]);
  assert.equal(store.isInstalled(MODEL), true);
});

test("a file already present with the wrong content (corrupt or modified) is downloaded again, not used", async () => {
  const { dir, fetched, store } = setUp();
  mkdirSync(join(dir, "fake-asr"), { recursive: true });
  writeFileSync(join(dir, "fake-asr", "a.onnx"), "stale");
  await store.install(MODEL);
  assert.deepEqual(fetched, ["a.onnx", "tokenizer/vocab.json"]);
  assert.deepEqual(readFileSync(join(dir, "fake-asr", "a.onnx")), BYTES["a.onnx"]);
});

test("a new catalog revision voids the old receipt: files are checked again, unchanged ones are not downloaded", async () => {
  const { fetched, store } = setUp();
  await store.install(MODEL);
  const moved = { ...MODEL, origin: { ...MODEL.origin, revision: "b".repeat(40) } };
  assert.equal(store.isInstalled(moved), false);
  await createModelStore({
    dir: dirname(store.dirOf(MODEL)),
    fetch: () => assert.fail("should not download"),
  }).install(moved);
  assert.equal(store.isInstalled(moved), true);
  assert.equal(fetched.length, 2);
});

test("bytes still missing: files not yet downloaded count at catalog size, files already present do not (used for the disk check)", async () => {
  const { dir, store } = setUp();
  const total = BYTES["a.onnx"].length + 7;
  assert.equal(store.missingBytes(MODEL), total);
  mkdirSync(join(dir, "fake-asr"), { recursive: true });
  writeFileSync(join(dir, "fake-asr", "a.onnx"), BYTES["a.onnx"]);
  assert.equal(store.missingBytes(MODEL), 7);
  await store.install(MODEL);
  assert.equal(store.missingBytes(MODEL), 0);
});

test("a resumed install starts progress from what is already there, not from zero", async () => {
  const { dir, store } = setUp();
  mkdirSync(join(dir, "fake-asr"), { recursive: true });
  writeFileSync(join(dir, "fake-asr", "a.onnx"), BYTES["a.onnx"]);
  const progress = [];
  await store.install(MODEL, { onProgress: (p) => progress.push(p) });
  assert.ok(progress[0].received >= BYTES["a.onnx"].length);
});

test("delete removes the whole directory and the list entry; deleting something never installed is fine", async () => {
  const { store } = setUp();
  await store.install(MODEL);
  store.remove(MODEL);
  assert.equal(existsSync(store.dirOf(MODEL)), false);
  assert.deepEqual(store.installed(), []);
  store.remove(MODEL);
});

test("a model with a runtime: the runtime installs after the files and before the receipt, its progress continues the files', and it counts as missing until installed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whisprflow-models-"));
  dirs.push(dir);
  const withRuntime = { ...MODEL, runtime: { bytes: 1000 } };
  const installs = [];
  const installRuntime = async ({ model, dir: where, signal, onProgress }) => {
    installs.push({ model: model.id, where, files: existsSync(join(where, "a.onnx")), signal });
    assert.equal(store.isInstalled(withRuntime), false, "no receipt while the runtime installs");
    onProgress(0.5);
    onProgress(1);
  };
  const fetch = async (url) => new Response(BYTES[pathOf(url)]);
  const store = createModelStore({ dir, fetch, installRuntime });
  const files = BYTES["a.onnx"].length + 7;
  assert.equal(store.missingBytes(withRuntime), files + 1000);

  const progress = [];
  const controller = new AbortController();
  await store.install(withRuntime, { signal: controller.signal, onProgress: (p) => progress.push(p) });
  assert.deepEqual(installs, [
    { model: "fake-asr", where: join(dir, "fake-asr"), files: true, signal: controller.signal },
  ]);
  assert.deepEqual(progress.slice(-2), [
    { received: files + 500, total: files + 1000 },
    { received: files + 1000, total: files + 1000 },
  ]);
  assert.equal(store.isInstalled(withRuntime), true);
  assert.equal(store.missingBytes(withRuntime), 0);
  // The receipt names the runtime's pins: the same files without the runtime aren't this install
  assert.match(readFileSync(join(dir, "fake-asr", ".complete.json"), "utf8"), /"runtime": "fermion-research /);
  assert.equal(store.isInstalled(MODEL), false);
});

test("a runtime that fails to install leaves no receipt, so the next try installs it again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whisprflow-models-"));
  dirs.push(dir);
  const withRuntime = { ...MODEL, runtime: { bytes: 1000 } };
  const fetch = async (url) => new Response(BYTES[pathOf(url)]);
  const failing = createModelStore({
    dir,
    fetch,
    installRuntime: async () => {
      throw new Error("uv exited with code 2");
    },
  });
  await assert.rejects(failing.install(withRuntime), /uv exited with code 2/);
  assert.equal(failing.isInstalled(withRuntime), false);
});
