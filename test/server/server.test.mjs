import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, test } from "node:test";
import WebSocket from "ws";
import { LocalizedError, msg } from "../../src/i18n/index.mjs";
import { startServer, WS_PATH } from "../../src/server/server.mjs";

const ogg = (payload) => Buffer.concat([Buffer.from("OggS"), Buffer.from(payload)]);
const silentLog = { info() {}, warn() {}, error() {} };

let server;
const sockets = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await server?.close();
  server = undefined;
});

async function start(refiner) {
  server = await startServer({ port: 0, refiner, log: silentLog });
  return server.port;
}

/** Connects to the server and returns a small client that can "send one, wait for one" */
async function connect(port, { path = WS_PATH, origin } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, origin ? { origin } : {});
  sockets.push(socket);
  const inbox = [];
  const waiters = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else inbox.push(message);
  });
  await once(socket, "open");
  return {
    sendJson: (value) => socket.send(JSON.stringify(value)),
    sendBinary: (buffer) => socket.send(buffer),
    next: () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve) => waiters.push(resolve))),
  };
}

async function sendChunk(client, audioId, index, buffer) {
  client.sendJson({ type: "set_audio_chunk_info", audio_id: audioId, index, size: buffer.length, duration: 3 });
  client.sendBinary(buffer);
  return client.next();
}

test("a complete dictation: message order and result fields as expected; refining receives which recording it is, for billing", async () => {
  const received = [];
  const port = await start({
    async refine(audio, { mimeType, audioId }) {
      received.push({ audio, mimeType, audioId });
      return "Finished text";
    },
  });
  const client = await connect(port, { path: `${WS_PATH}?v=clone_0.1.0&m=0` });
  const chunks = [ogg("first-chunk"), ogg("second")];

  client.sendJson({ type: "start_audio", audio_id: "a1", audio_chunk_time: 3, mode: "voice_transcript" });
  const started = await client.next();
  assert.equal(started.K, "audio_session_started");
  assert.equal(started.V.audio_id, "a1");
  assert.equal(typeof started.V.start_time, "number");

  for (const [i, chunk] of chunks.entries()) {
    const ack = await sendChunk(client, "a1", i + 1, chunk);
    assert.equal(ack.K, "received_audio_chunk_count");
    assert.equal(ack.V.index, i + 1);
    assert.equal(ack.V.size, chunk.length);
    assert.equal(typeof ack.V.server_t, "number");
  }

  client.sendJson({ type: "end_audio", audio_id: "a1", total_duration: 5.1 });
  const ending = await client.next();
  assert.deepEqual(ending, {
    K: "audio_session_ending",
    V: { audio_id: "a1", total_chunks: 2, completed_chunks: 2, failed_chunks: 0 },
    T: "json",
    M: false,
    S: "done",
  });
  const completed = await client.next();
  assert.deepEqual(completed.V, {
    audio_id: "a1",
    refined_text: "Finished text",
    status: true,
    run_index: 1,
    web_metadata: null,
    delivery: null,
    action: null,
    user_prompt: null,
    external_action: null,
  });
  assert.equal(completed.K, "audio_processing_completed");

  assert.equal(received.length, 1);
  assert.deepEqual(received[0], { audio: Buffer.concat(chunks), mimeType: "audio/ogg", audioId: "a1" });
});

test("a second dictation can follow on the same connection", async () => {
  const port = await start({ refine: async (audio) => `${audio.length} bytes in all` });
  const client = await connect(port);
  for (const audioId of ["a1", "a2"]) {
    client.sendJson({ type: "start_audio", audio_id: audioId });
    await client.next();
    await sendChunk(client, audioId, 1, ogg(audioId));
    client.sendJson({ type: "end_audio", audio_id: audioId });
    await client.next();
    const completed = await client.next();
    assert.equal(completed.V.audio_id, audioId);
    assert.equal(completed.V.refined_text, "6 bytes in all");
  }
});

test("a failed refine answers audio_processing_error and keeps the connection", async () => {
  let calls = 0;
  const port = await start({
    async refine() {
      calls += 1;
      if (calls === 1) throw new Error("upstream 503");
      return "second one works";
    },
  });
  const client = await connect(port);

  client.sendJson({ type: "start_audio", audio_id: "a1" });
  await client.next();
  await sendChunk(client, "a1", 1, ogg("x"));
  client.sendJson({ type: "end_audio", audio_id: "a1" });
  await client.next();
  const failed = await client.next();
  assert.equal(failed.K, "audio_processing_error");
  assert.equal(failed.V.audio_id, "a1");
  assert.equal(failed.V.code, "refine_failed");
  assert.match(failed.V.detail, /upstream 503/);
  // An unexplained error has no problem, so the bar uses detail
  assert.equal(failed.V.problem, undefined);

  client.sendJson({ type: "start_audio", audio_id: "a2" });
  await client.next();
  await sendChunk(client, "a2", 1, ogg("y"));
  client.sendJson({ type: "end_audio", audio_id: "a2" });
  await client.next();
  assert.equal((await client.next()).V.refined_text, "second one works");
});

test("ending with no audio at all never calls the model and answers no_audio", async () => {
  let calls = 0;
  const port = await start({
    async refine() {
      calls += 1;
      return "should not get here";
    },
  });
  const client = await connect(port);
  client.sendJson({ type: "start_audio", audio_id: "a1" });
  await client.next();
  client.sendJson({ type: "end_audio", audio_id: "a1" });
  const failed = await client.next();
  assert.equal(failed.K, "audio_processing_error");
  assert.equal(failed.V.code, "no_audio");
  assert.deepEqual(failed.V.problem, msg("voice.noAudio"));
  assert.equal(calls, 0);
});

test("a failed refine carries the sentence for people (problem), translated by the bar; the original stays in detail", async () => {
  const problem = msg("model.unreachable", { provider: "Gemini" });
  const port = await start({
    async refine() {
      throw new LocalizedError(problem);
    },
  });
  const client = await connect(port);
  client.sendJson({ type: "start_audio", audio_id: "a1" });
  await client.next();
  await sendChunk(client, "a1", 1, ogg("x"));
  client.sendJson({ type: "end_audio", audio_id: "a1" });
  await client.next();
  const failed = await client.next();
  assert.equal(failed.V.code, "refine_failed");
  assert.deepEqual(failed.V.problem, problem);
  assert.equal(failed.V.detail, "Can't reach Gemini. Check your network");
});

test("messages out of order answer error with the reason", async () => {
  const port = await start({ refine: async () => "" });
  const client = await connect(port);

  client.sendBinary(ogg("x"));
  assert.deepEqual((await client.next()).V.code, "no_session");

  client.sendJson({ type: "end_audio", audio_id: "a1" });
  assert.equal((await client.next()).V.code, "no_session");

  client.sendJson({ type: "start_audio", audio_id: "a1" });
  await client.next();
  client.sendJson({ type: "set_audio_chunk_info", audio_id: "another", index: 1, size: 5 });
  const mismatch = await client.next();
  assert.equal(mismatch.K, "error");
  assert.equal(mismatch.V.code, "audio_id_mismatch");

  client.sendJson({ type: "no-such-type" });
  assert.equal((await client.next()).V.code, "unknown_type");
});

test("connections from web pages and other paths are refused", async () => {
  const port = await start({ refine: async () => "" });
  for (const options of [{ origin: "https://evil.example" }, { path: "/other" }]) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${options.path ?? WS_PATH}`, {
      origin: options.origin,
    });
    sockets.push(socket);
    const [error] = await once(socket, "error");
    assert.match(error.message, /Unexpected server response: 4\d\d/);
  }
  // Electron's renderer connecting from a local file has Origin file://
  await connect(port, { origin: "file://" });
});

test("recording start lets the model side prepare (Gemini builds a prompt cache) without waiting; a failed prepare does not affect the dictation", async () => {
  let prepared = 0;
  const port = await start({
    async prepare() {
      prepared++;
      throw new Error("cache build failed");
    },
    refine: async () => "Finished text",
  });
  const client = await connect(port);
  client.sendJson({ type: "start_audio", audio_id: "p1" });
  assert.equal((await client.next()).K, "audio_session_started");
  assert.equal(prepared, 1);
  await sendChunk(client, "p1", 1, ogg("x"));
  client.sendJson({ type: "end_audio", audio_id: "p1" });
  await client.next();
  assert.equal((await client.next()).V.refined_text, "Finished text");
});

test("a refine step without prepare dictates as usual", async () => {
  const port = await start({ refine: async () => "text" });
  const client = await connect(port);
  client.sendJson({ type: "start_audio", audio_id: "p2" });
  assert.equal((await client.next()).K, "audio_session_started");
});
