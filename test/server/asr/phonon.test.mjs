import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { load } from "../../../src/server/asr/engines/phonon.mjs";

const MODEL = { id: "phonon-2", family: "phonon-2" };
const DIR = join("models", "phonon-2");
const file = (role) => join(DIR, `${role}.bin`);

/** A fake server process: prints what it's given to stderr on request, records kills */
function fakeServer() {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = 0;
  child.kill = () => {
    child.killed += 1;
  };
  const spawned = [];
  const spawn = (command, args, options) => {
    spawned.push({ command, args, options });
    return child;
  };
  return { child, spawn, spawned };
}

/** A fake fetch for the server: health says cpu, transcriptions answer with the hotwords it got */
function fakeFetch() {
  const requests = [];
  const fetch = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith("/health")) return Response.json({ status: "ok", decode: { engine: "cpu" } });
    const hotwords = init.body.get("hotwords");
    return Response.json({ text: ` heard ${hotwords ?? "nothing"} ` });
  };
  return { fetch, requests };
}

test("Phonon-2 starts fermion's server from the runtime's Python on a port the system picks, with a random key, and is ready once it says where it listens", async () => {
  const { child, spawn, spawned } = fakeServer();
  const { fetch, requests } = fakeFetch();
  const loading = load({ model: MODEL, file, options: { threads: 4 } }, { spawn, fetch });
  child.stderr.write("[fermion] decode backend: cpu\n[fermion] serving FermionResearch/Phonon-2 (sha 12345678) on ");
  child.stderr.write("http://127.0.0.1:54321/v1\n");
  const transcriber = await loading;

  const [{ command, args, options }] = spawned;
  assert.ok(
    command.endsWith(join("runtime", process.platform === "win32" ? "venv/Scripts/python.exe" : "venv/bin/python")),
  );
  assert.equal(args[0], "-I");
  assert.deepEqual(args.slice(3, 9), [join(DIR, "profile"), "--host", "127.0.0.1", "--port", "0", "--api-key"]);
  const key = args[9];
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.deepEqual(args.slice(10), ["--threads", "4"]);
  assert.equal(options.env.HF_HUB_OFFLINE, "1");
  assert.equal(transcriber.backend, "cpu");
  assert.equal(requests[0].url, "http://127.0.0.1:54321/v1/health");
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${key}`);

  // Each recording goes over as a WAV, with the newest 25 terms as hotwords (a JSON list); the text comes back trimmed
  const terms = Array.from({ length: 30 }, (_, i) => `Term${i}`);
  const { text } = await transcriber.transcribe(new Float32Array(1600), { hotwords: terms });
  assert.equal(text, `heard ${JSON.stringify(terms.slice(5))}`);
  const sent = requests.at(-1);
  assert.equal(sent.url, "http://127.0.0.1:54321/v1/audio/transcriptions");
  assert.equal(sent.init.headers.Authorization, `Bearer ${key}`);
  assert.equal(
    sent.init.body.get("model"),
    null,
    "serving a directory, the server would refuse any model name but the path",
  );
  const wav = Buffer.from(await sent.init.body.get("file").arrayBuffer());
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.length, 44 + 1600 * 2);
  assert.deepEqual(await transcriber.transcribe(new Float32Array(1600)), { text: "heard nothing" });

  transcriber.dispose();
  assert.equal(child.killed, 1);
  child.emit("exit", null);
});

test("a server that exits before it starts is an error carrying its last output; one that dies later ends this process so the host restarts it", async () => {
  const early = fakeServer();
  const loading = load({ model: MODEL, file }, { spawn: early.spawn, fetch: fakeFetch().fetch });
  early.child.stderr.write("Traceback: no module named fermion\n");
  await new Promise((resolve) => setImmediate(resolve));
  early.child.emit("exit", 1);
  await assert.rejects(loading, /exited before it started \(code 1\):\nTraceback: no module named fermion/);

  const late = fakeServer();
  let exited = 0;
  const started = load(
    { model: MODEL, file },
    { spawn: late.spawn, fetch: fakeFetch().fetch, exit: () => (exited += 1) },
  );
  late.child.stderr.write("[fermion] serving FermionResearch/Phonon-2 (sha 1) on http://127.0.0.1:5000/v1\n");
  await started;
  late.child.emit("exit", 3);
  assert.equal(exited, 1);
});

test("an error status from the server is an error with what it said", async () => {
  const { child, spawn } = fakeServer();
  const fetch = async (url) =>
    url.endsWith("/health")
      ? Response.json({ decode: { engine: "cpu" } })
      : new Response("audio too short", { status: 400 });
  const loading = load({ model: MODEL, file }, { spawn, fetch });
  child.stderr.write("[fermion] serving FermionResearch/Phonon-2 (sha 1) on http://127.0.0.1:5000/v1\n");
  const transcriber = await loading;
  await assert.rejects(transcriber.transcribe(new Float32Array(16)), /HTTP 400: audio too short/);
  transcriber.dispose();
});
