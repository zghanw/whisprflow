import { spawn as spawnProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { FERMION_VERSION, runtimePaths } from "../../../models/runtime.mjs";
import { encodeWav, SPEECH_SAMPLE_RATE } from "../../audio/pcm.mjs";

// The Phonon-2 adapter (Fermion Research, CC-BY-4.0, built from NVIDIA's Parakeet TDT 0.6B v3). English only. The model runs in Python
// (fermion-research), in the runtime models/runtime.mjs installed into the model directory: this adapter starts fermion's own OpenAI-style server
// on a free local port and sends it each recording as a WAV. The model handles long recordings itself, so the catalog sets no maxSeconds.
// Interface: see index.mjs; transcribe also takes hotwords, the user's dictionary terms, which nudge decoding toward those spellings.
//
// The server needs a random key, so other programs on this computer can't use it. It ends with this process: a small launcher waits on its parent
// and exits when the parent is gone, even when it was killed outright. (Not by reading stdin to its end: on Windows a thread blocked reading a pipe
// makes the model load hang, measured.) If the server dies on its own this process exits too, and the transcriber host (host.mjs) starts a fresh
// one on the next dictation.

/** The most hotwords the server takes per request */
const MAX_HOTWORDS = 25;
/** How long the server may take to load the model: a few seconds measured on Windows; Apple silicon compiles its GPU programs on the first run */
const START_TIMEOUT_MS = 180_000;
/** The last few lines of the server's output go into errors */
const OUTPUT_LINES = 20;
/** The line the server prints once the model is loaded and it listens: its address, with the port the system picked */
const SERVING = /serving .* on (http:\/\/127\.0\.0\.1:\d+\/v1)/;

const LAUNCHER = [
  "import os, sys, threading",
  "def watch(parent=os.getppid()):",
  "    if os.name == 'nt':",
  "        import ctypes",
  "        kernel32 = ctypes.windll.kernel32",
  "        kernel32.OpenProcess.restype = ctypes.c_void_p",
  "        kernel32.WaitForSingleObject.argtypes = (ctypes.c_void_p, ctypes.c_uint32)",
  "        handle = kernel32.OpenProcess(0x00100000, False, parent)",
  "        if not handle:",
  "            return",
  "        kernel32.WaitForSingleObject(handle, 0xFFFFFFFF)",
  "    else:",
  "        import time",
  "        while os.getppid() == parent:",
  "            time.sleep(1)",
  "    os._exit(0)",
  "threading.Thread(target=watch, daemon=True).start()",
  "from fermion.cli import main",
  "sys.argv = ['fermion', 'serve', *sys.argv[1:]]",
  "main()",
].join("\n");

/** One family; its archive locates the model directory (the runtime and the unpacked model are beside it) */
export const FAMILIES = Object.freeze({
  "phonon-2": Object.freeze({ config: (file) => file("archive") }),
});

export async function version() {
  return FERMION_VERSION;
}

/**
 * @param {{ model: object, file: (role: string) => string, options?: { threads?: number } }} request threads: CPU threads, fermion's default when not given
 * @param {{ spawn?: typeof spawnProcess, fetch?: typeof globalThis.fetch, exit?: () => void }} [deps] replaced in tests
 */
export async function load(
  { model, file, options = {} },
  { spawn = spawnProcess, fetch = globalThis.fetch, exit = () => process.exit(1) } = {},
) {
  const { python, profile } = runtimePaths(dirname(FAMILIES[model.family].config(file)));
  const key = randomBytes(16).toString("hex");
  const args = ["-I", "-c", LAUNCHER, profile, "--host", "127.0.0.1", "--port", "0", "--api-key", key];
  if (options.threads) args.push("--threads", String(options.threads));
  const child = spawn(python, args, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    env: { ...process.env, HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
  });
  let disposed = false;
  const base = await new Promise((resolve, reject) => {
    const last = [];
    let rest = "";
    let started = false;
    const fail = (error) => {
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new Error(`Phonon-2 didn't start within ${START_TIMEOUT_MS / 1000} s:\n${last.join("\n")}`)),
      START_TIMEOUT_MS,
    );
    // Read to the end even once started: the server logs each request, and a full pipe would block it
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop();
      for (const line of lines) {
        last.push(line);
        last.splice(0, Math.max(0, last.length - OUTPUT_LINES));
        const serving = !started && SERVING.exec(line);
        if (serving) {
          started = true;
          clearTimeout(timer);
          resolve(serving[1]);
        }
      }
    });
    child.on("error", fail);
    child.on("exit", (code) => {
      if (!started) return fail(new Error(`Phonon-2 exited before it started (code ${code}):\n${last.join("\n")}`));
      if (disposed) return;
      process.stderr.write(`Phonon-2 exited (code ${code}):\n${last.join("\n")}\n`);
      exit();
    });
  });

  const headers = { Authorization: `Bearer ${key}` };
  const health = await (await fetch(`${base}/health`, { headers })).json();
  return {
    // cpu, or mlx on Apple silicon
    backend: String(health?.decode?.engine ?? "cpu"),
    async transcribe(samples, { hotwords = [] } = {}) {
      const form = new FormData();
      form.append("file", new Blob([encodeWav(samples, SPEECH_SAMPLE_RATE)], { type: "audio/wav" }), "speech.wav");
      // No model field: the server checks it only when sent, and serving a directory it answers only to that directory's path
      // The newest terms: learning appends, so the end of the dictionary is what the user talks about lately. JSON keeps a comma inside a term whole
      if (hotwords.length > 0) form.append("hotwords", JSON.stringify(hotwords.slice(-MAX_HOTWORDS)));
      const response = await fetch(`${base}/audio/transcriptions`, { method: "POST", headers, body: form });
      if (!response.ok) {
        throw new Error(`Phonon-2 answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      }
      const { text } = await response.json();
      return { text: String(text ?? "").trim() };
    },
    dispose() {
      disposed = true;
      child.kill();
    },
  };
}
