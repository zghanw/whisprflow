import assert from "node:assert/strict";
import { test } from "node:test";
import { ProtocolError } from "../../../src/server/protocol/protocol.mjs";
import { RecordingSession } from "../../../src/server/protocol/session.mjs";

const ogg = (payload) => Buffer.concat([Buffer.from("OggS"), Buffer.from(payload)]);
const newSession = (maxTotalBytes = 1024) => new RecordingSession("audio-1", { maxTotalBytes });
const fails = (action, code) => assert.throws(action, (error) => error instanceof ProtocolError && error.code === code);

test("chunks are taken in order and joined back to back", () => {
  const session = newSession();
  const first = ogg("aaaa");
  const second = ogg("bb");
  session.announceChunk({ index: 1, size: first.length });
  assert.deepEqual(session.addChunk(first), { index: 1, size: first.length });
  session.announceChunk({ index: 2, size: second.length });
  session.addChunk(second);

  assert.equal(session.chunkCount, 2);
  assert.equal(session.totalBytes, first.length + second.length);
  assert.deepEqual(session.merge(), Buffer.concat([first, second]));
});

test("an audio frame with no announcement", () => {
  fails(() => newSession().addChunk(ogg("a")), "chunk_without_info");
});

test("indexes start at 1 and never skip or repeat", () => {
  fails(() => newSession().announceChunk({ index: 0, size: 5 }), "chunk_out_of_order");
  fails(() => newSession().announceChunk({ index: 2, size: 5 }), "chunk_out_of_order");

  const session = newSession();
  session.announceChunk({ index: 1, size: 5 });
  session.addChunk(ogg("a"));
  fails(() => session.announceChunk({ index: 1, size: 5 }), "chunk_out_of_order");
});

test("two announcements in a row with no audio frame between", () => {
  const session = newSession();
  session.announceChunk({ index: 1, size: 5 });
  fails(() => session.announceChunk({ index: 2, size: 5 }), "chunk_missing");
});

test("the actual byte count differs from the announced one", () => {
  const session = newSession();
  session.announceChunk({ index: 1, size: 99 });
  fails(() => session.addChunk(ogg("a")), "chunk_size_mismatch");
  // That frame is consumed; the same index must be announced again before resending
  fails(() => session.addChunk(ogg("a")), "chunk_without_info");
  assert.equal(session.chunkCount, 0);
});

test("the first chunk decides the container: Ogg or WebM, nothing else", () => {
  const oggSession = newSession();
  oggSession.announceChunk({ index: 1, size: 5 });
  oggSession.addChunk(ogg("a"));
  assert.equal(oggSession.mimeType, "audio/ogg");

  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f]);
  const webmSession = newSession();
  webmSession.announceChunk({ index: 1, size: webm.length });
  webmSession.addChunk(webm);
  assert.equal(webmSession.mimeType, "audio/webm");
  // Browser-recorded WebM has a header only in the first chunk; later chunks continue the data
  webmSession.announceChunk({ index: 2, size: 3 });
  webmSession.addChunk(Buffer.from([1, 2, 3]));
  assert.equal(webmSession.chunkCount, 2);

  const wavSession = newSession();
  wavSession.announceChunk({ index: 1, size: 5 });
  fails(() => wavSession.addChunk(Buffer.from("RIFFx")), "unsupported_audio");
  assert.equal(wavSession.mimeType, null);
});

test("the total goes over the limit", () => {
  const session = newSession(8);
  session.announceChunk({ index: 1, size: 5 });
  session.addChunk(ogg("a"));
  session.announceChunk({ index: 2, size: 5 });
  fails(() => session.addChunk(ogg("b")), "audio_too_large");
  assert.equal(session.totalBytes, 5);
});
