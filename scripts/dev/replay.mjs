#!/usr/bin/env node
// Sends existing Ogg/Opus files as one recording to the server over the dictation protocol, printing each reply and its timing.
// For checking the server without a client, and for comparing models and prompts.
//
// Usage: node scripts/dev/replay.mjs [--url ws://127.0.0.1:8790] <chunk1.ogg> [chunk2.ogg ...]
// Each file is sent as one chunk. The finished text is printed in the terminal.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import WebSocket from "ws";

const { values, positionals: files } = parseArgs({
  options: { url: { type: "string", default: "ws://127.0.0.1:8790" } },
  allowPositionals: true,
});
if (files.length === 0) {
  console.error("Usage: node scripts/dev/replay.mjs [--url ws://127.0.0.1:8790] <chunk1.ogg> [chunk2.ogg ...]");
  process.exit(2);
}

const chunks = files.map((file) => readFileSync(file));
const audioId = randomUUID();
const socket = new WebSocket(`${values.url}/ws/rt_voice_flow?v=replay&m=0`);
const startedAt = performance.now();
const elapsed = () => `${String(Math.round(performance.now() - startedAt)).padStart(6)} ms`;
let endSentAt = null;

const fail = (reason) => {
  console.error(`${elapsed()}  failed: ${reason}`);
  socket.terminate();
  process.exitCode = 1;
};

socket.on("error", (error) => fail(`can't reach ${values.url}: ${error.message}`));
socket.on("close", (code) => {
  if (process.exitCode === undefined && endSentAt === null) fail(`connection closed early, close code ${code}`);
});

socket.on("open", () => {
  console.log(`${elapsed()}  connected, sending start_audio and ${chunks.length} audio chunks`);
  socket.send(
    JSON.stringify({ type: "start_audio", audio_id: audioId, audio_chunk_time: 3, mode: "voice_transcript" }),
  );
  for (const [i, chunk] of chunks.entries()) {
    socket.send(JSON.stringify({ type: "set_audio_chunk_info", audio_id: audioId, index: i + 1, size: chunk.length }));
    socket.send(chunk);
  }
  socket.send(JSON.stringify({ type: "end_audio", audio_id: audioId }));
  endSentAt = performance.now();
});

socket.on("message", (data) => {
  const { K: kind, V: value } = JSON.parse(data.toString("utf8"));
  switch (kind) {
    case "audio_processing_completed":
      console.log(`${elapsed()}  ${kind} (${Math.round(performance.now() - endSentAt)} ms after end_audio)`);
      console.log(value.refined_text === "" ? "(empty: no speech heard)" : value.refined_text);
      socket.close();
      break;
    case "audio_processing_error":
    case "error":
      fail(`${kind} ${value.code}: ${value.detail}`);
      break;
    default:
      console.log(`${elapsed()}  ${kind}`);
  }
});
