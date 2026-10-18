#!/usr/bin/env node
// End-to-end test: real Electron, real recording and encoding, real server and models; only the two ends are fake:
// the microphone is a WAV file, and pasting just records the text. Never touches the real keyboard, clipboard, or history.
//
// Usage: the environment needs the chosen provider's key (the background app uses it for the built-in server). Gemini by default; WHISPRFLOW_MODEL switches:
//   GEMINI_API_KEY=... node scripts/dev/e2e.mjs <a 16-bit PCM WAV>
//   WHISPRFLOW_MODEL=openai OPENAI_API_KEY=... node scripts/dev/e2e.mjs <a 16-bit PCM WAV>
// Recording lasts 7.5 seconds by default (crossing two 3-second chunk boundaries); WHISPRFLOW_E2E_RECORD_MS changes it.
// The on-device route (local mode): the data directory is fresh, so the on-device model really downloads (WHISPRFLOW_MODEL_SOURCE switches the source), and recording starts once loaded:
//   WHISPRFLOW_MODE=local node scripts/dev/e2e.mjs <WAV>   (polish goes to Ollama, which must be running)
// The private route (private mode) needs no key and also downloads the model first: WHISPRFLOW_MODE=private node scripts/dev/e2e.mjs <WAV>
// To run the staged copy used for packaging (runtime dependencies only, to catch missing packages): WHISPRFLOW_E2E_APP=<staged directory>
// To run the packaged app (signed, hardened runtime, to check the on-device native libraries load):
//   WHISPRFLOW_E2E_ELECTRON=<WhisprFlow.app>/Contents/MacOS/WhisprFlow

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const wav = process.argv[2] && resolve(process.argv[2]);
if (!wav || !existsSync(wav)) {
  console.error("Usage: node scripts/dev/e2e.mjs <a 16-bit PCM WAV>");
  process.exit(2);
}

const electron = createRequire(import.meta.url)("electron");
// A short name: the home directory holds the control channel socket, and its path has a length limit
const workDir = mkdtempSync(join(tmpdir(), "wf-e2e-"));
const outPath = join(workDir, "result.json");

// The packaged app knows where its program is, so none is given
const packaged = process.env.WHISPRFLOW_E2E_ELECTRON;
const child = spawn(
  packaged ?? electron,
  [
    ...(packaged ? [] : ["."]),
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    // %noloop: silence after the file ends instead of starting over
    `--use-file-for-fake-audio-capture=${wav}%noloop`,
    // The audio service is sandboxed by default and can't read this WAV. Only this service's sandbox is lifted, only in tests
    "--disable-features=AudioServiceSandbox",
  ],
  {
    cwd: process.env.WHISPRFLOW_E2E_APP ?? resolve(import.meta.dirname, "../.."),
    env: { ...process.env, WHISPRFLOW_E2E_OUT: outPath, WHISPRFLOW_HOME: join(workDir, "home") },
    stdio: ["ignore", "inherit", "inherit"],
  },
);

// If Electron hangs (say, an error at startup), it is killed when time is up, so the test fails rather than hanging forever.
// Routes needing an on-device model (local, private) get extra time to download and load it
const recordMs = Number(process.env.WHISPRFLOW_E2E_RECORD_MS ?? 7_500);
const setupMs = ["local", "private"].includes(process.env.WHISPRFLOW_MODE) ? 20 * 60_000 : 0;
const watchdog = setTimeout(() => child.kill("SIGKILL"), setupMs + recordMs + 60_000);

child.on("exit", (code) => {
  clearTimeout(watchdog);
  const problems = [];
  let result = null;
  if (!existsSync(outPath)) {
    problems.push(`Electron exited with ${code} and left no result file`);
  } else {
    result = JSON.parse(readFileSync(outPath, "utf8"));
    if (result.failed) problems.push(`dictation failed: ${result.failed}`);
    if (!result.delivered) problems.push("no finished text");
    if (result.pasted.length !== 1 || result.pasted[0] !== result.delivered)
      problems.push("the pasted text doesn't match the finished text");
    const [row] = result.history;
    if (result.history.length !== 1 || row?.status !== "completed" || row?.refinedText !== result.delivered) {
      problems.push("history should hold exactly one finished entry equal to the finished text");
    } else if (!existsSync(row.audioLocalPath) || statSync(row.audioLocalPath).size === 0) {
      problems.push("the recording file wasn't saved");
    } else {
      console.log(`Recording ${row.duration.toFixed(1)} s, file ${statSync(row.audioLocalPath).size} bytes`);
    }
    // Cost records: this dictation's model calls match this history entry. Private mode has only the on-device transcription record: no tokens, no cost
    const { usage } = row ?? {};
    const local = process.env.WHISPRFLOW_MODE === "private";
    const counted = local ? usage?.calls === 1 && usage.costUsd === 0 : usage?.inputTokens > 0;
    if (!usage || usage.calls < 1 || !counted || !(usage.latencyMs > 0)) {
      problems.push(`this history entry has no matching cost record: ${JSON.stringify(usage)}`);
    } else {
      const cost = usage.costUsd === null ? "price unknown" : `$${usage.costUsd.toPrecision(2)}`;
      console.log(
        `${usage.calls} model calls: ${usage.inputTokens} input tokens, ${usage.outputTokens} output tokens, ${cost}, model ${usage.latencyMs} ms`,
      );
    }
  }
  if (result?.localModel) {
    const { downloadMs, loadMs, backend } = result.localModel;
    console.log(
      `On-device model: downloaded in ${(downloadMs / 1000).toFixed(1)} s, loaded in ${loadMs} ms, running on ${backend}`,
    );
  }
  if (result?.delivered) console.log(`Finished text: ${result.delivered}`);
  rmSync(workDir, { recursive: true, force: true });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAIL: ${problem}`);
    process.exit(1);
  }
  console.log("OK: recording, chunked upload, refining, pasting, history, and cost records all worked");
});
