// The client's protocol module runs against the real server module (with the model step faked),
// so if the two ends disagree about the protocol, this fails first.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createTranslator, LocalizedError, msg } from "../../../src/i18n/index.mjs";
import { VoiceSocket } from "../../../src/renderer/bar/voice-socket.mjs";
import { startServer, WS_PATH } from "../../../src/server/server.mjs";

const en = createTranslator("en");
/** The sentence for people in an error, matched once translated */
const said = (pattern) => (error) => pattern.test(en.text(error.problem ?? error.message));

const silentLog = { info() {}, warn() {}, error() {} };
const webm = (payload) => new Blob([Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]), payload]);

let server;
let voice;
afterEach(async () => {
  voice?.close();
  await server?.close();
  server = undefined;
});

async function start(refine) {
  server = await startServer({ port: 0, refiner: { refine }, log: silentLog });
  voice = new VoiceSocket(`ws://127.0.0.1:${server.port}${WS_PATH}`);
  return voice;
}

test("start, send chunks in order, finish, get the result; the server receives the chunks joined end to end", async () => {
  let received;
  const socket = await start(async (audio, { mimeType }) => {
    received = { text: audio.toString("latin1"), mimeType };
    return "result";
  });
  await socket.begin("a1");
  // The first chunk is deliberately larger: reading its bytes is slower, so without a queue the second would jump ahead
  socket.sendChunk(webm("A".repeat(200_000)));
  socket.sendChunk(new Blob(["BBB"]));
  assert.equal(await socket.finish({ durationSeconds: 4.2 }), "result");
  assert.equal(received.mimeType, "audio/webm");
  assert.ok(received.text.endsWith(`${"A".repeat(10)}BBB`));
});

test("two in a row on the same connection", async () => {
  const socket = await start(async (audio) => `${audio.length}`);
  for (const audioId of ["a1", "a2"]) {
    await socket.begin(audioId);
    socket.sendChunk(webm("xy"));
    assert.equal(await socket.finish({ durationSeconds: 1 }), "6");
  }
});

test("when the server fails to refine, finish throws an error with the reason", async () => {
  const socket = await start(async () => {
    throw new Error("upstream 503");
  });
  await socket.begin("a1");
  socket.sendChunk(webm("x"));
  await assert.rejects(socket.finish({ durationSeconds: 1 }), said(/refine_failed.*upstream 503/));
});

test("reasons the model side can explain (problem) come through as is, for the floating bar to translate", async () => {
  const socket = await start(async () => {
    throw new LocalizedError(msg("model.unreachable", { provider: "Gemini" }));
  });
  await socket.begin("a1");
  socket.sendChunk(webm("x"));
  const error = await socket.finish({ durationSeconds: 1 }).catch((thrown) => thrown);
  assert.equal(en.text(error.problem), "Can't reach Gemini. Check your network");
});

test("a recording format the server doesn't accept is reported at finish", async () => {
  const socket = await start(async () => "should not get here");
  await socket.begin("a1");
  socket.sendChunk(new Blob(["RIFF...."]));
  await assert.rejects(socket.finish({ durationSeconds: 1 }), said(/unsupported_audio/));
});

test("timing out while waiting for the result", async () => {
  const socket = await start(() => new Promise(() => {}));
  await socket.begin("a1");
  socket.sendChunk(webm("x"));
  await assert.rejects(socket.finish({ durationSeconds: 1, timeoutMs: 50 }), said(/No result after/));
});

test("the connection drops while waiting for the result", async () => {
  const socket = await start(() => new Promise(() => {}));
  await socket.begin("a1");
  socket.sendChunk(webm("x"));
  const pending = socket.finish({ durationSeconds: 1 });
  const running = server;
  server = undefined; // closed here, so cleanup mustn't close it again
  setTimeout(() => running.close(), 20);
  await assert.rejects(pending, said(/Lost the connection/));
});

test("with the server down, begin reports it can't connect", async () => {
  const socket = await start(async () => "");
  await server.close();
  server = undefined;
  await assert.rejects(socket.begin("a1"), said(/Can't reach the server/));
});

test("after abandoning a recording, its late result isn't counted toward the next one", async () => {
  const releases = [];
  const socket = await start((audio) => new Promise((resolve) => releases.push(() => resolve(`${audio.length}`))));
  await socket.begin("a1");
  socket.sendChunk(webm("x"));
  const first = socket.finish({ durationSeconds: 1, timeoutMs: 60 });
  await assert.rejects(first, said(/No result after/));

  await socket.begin("a2");
  socket.sendChunk(webm("xyz"));
  const second = socket.finish({ durationSeconds: 1 });
  // Wait until both refines reach the server, then release the first (the late one)
  while (releases.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  releases[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  releases[1]();
  assert.equal(await second, "7");
});
