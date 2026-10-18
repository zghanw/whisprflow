import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SPEECH_SAMPLE_RATE } from "../audio/pcm.mjs";

// The transcriber process: the on-device model runs in its own child process (worker.mjs on the other end), with the same interface loadTranscriber returns.
// Why not in this process:
// - A resident model takes a GB or two of memory (Qwen3 Q8 with Metal measured about 2 GB). Ending the process on a model change or the native path gives it all back.
// - Runtimes are native code, and a crash takes the whole process down. In a child process a crash loses only one transcription, and the next one restarts it.
// - Runtime differences between systems (Metal, Vulkan, CUDA) stay in the child; the main process only knows these few messages.
// The child uses this process's own executable: inside the app that is the bundled Electron, running as Node (ELECTRON_RUN_AS_NODE).

const WORKER = fileURLToPath(new URL("./worker.mjs", import.meta.url));
/** The last few stderr lines of a crashed child go into the log, enough to see what happened */
const STDERR_LINES = 20;
/** The longest one transcription may take: the recording length plus 30 s. Even CPU-only is over ten times real time, so a longer wait means it hung */
const defaultTimeout = (samples) => 30_000 + Math.round((samples.length / SPEECH_SAMPLE_RATE) * 1000);

/** Starts a child running the worker. Advanced serialization passes a Float32Array as is, without converting to an array */
function forkWorker(workerPath) {
  return fork(workerPath, [], {
    serialization: "advanced",
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    // Inside Electron the forked process is Electron itself; tell it to run as Node
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
}

/**
 * @param {object} request
 * @param {object} request.model a catalog entry (models/catalog.mjs)
 * @param {string} request.dir where the model was downloaded
 * @param {object} [request.options] runtime parameters (backend, threads, ...)
 * @param {{ info: Function, warn: Function, error: Function }} request.log
 * @param {string} [request.workerPath] replaced by a fake worker in tests
 * @param {(samples: Float32Array) => number} [request.timeoutFor] the longest one transcription may take in ms; shortened in tests
 * @returns {Promise<{ backend: string, transcribe(samples: Float32Array): Promise<{ text: string }>, dispose(): void }>}
 *   returns once loaded; throws if it can't load (corrupt model files, a runtime that won't load)
 */
export async function spawnTranscriber({
  model,
  dir,
  options = {},
  log,
  workerPath = WORKER,
  start = forkWorker,
  timeoutFor = defaultTimeout,
}) {
  /** The running child and its loaded model; null after a crash, restarted on the next transcription */
  let current = null;
  let disposed = false;
  let nextId = 1;

  function launch() {
    const child = start(workerPath);
    const stderr = [];
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr.push(...chunk.split("\n").filter(Boolean));
      stderr.splice(0, Math.max(0, stderr.length - STDERR_LINES));
    });
    /** Transcriptions waiting for a reply: id to { resolve, reject, timer } */
    const pending = new Map();
    const state = { child, pending, backend: null };

    const loaded = new Promise((resolve, reject) => {
      child.on("message", (message) => {
        if (message.type === "loaded") {
          state.backend = message.backend;
          log.info("transcriber_loaded", {
            model: model.id,
            backend: message.backend,
            load_ms: message.loadMs,
            warmup_ms: message.warmupMs ?? null,
          });
          resolve(state);
        } else if (message.type === "failed") {
          reject(new Error(`Couldn't load model ${model.id}: ${message.message}`));
          child.kill();
        } else {
          const waiting = pending.get(message.id);
          if (!waiting) return;
          pending.delete(message.id);
          clearTimeout(waiting.timer);
          if (message.type === "result") waiting.resolve({ text: message.text });
          else waiting.reject(new Error(`Local transcription failed: ${message.message}`));
        }
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (current === state) current = null;
        const reason = `The transcriber process exited (code ${code}, signal ${signal})`;
        reject(new Error(reason));
        for (const { reject: fail, timer } of pending.values()) {
          clearTimeout(timer);
          fail(new Error(reason));
        }
        pending.clear();
        if (!disposed) log.error("transcriber_exited", { model: model.id, code, signal, stderr: stderr.join("\n") });
      });
    });
    child.send({ type: "load", model, dir, options });
    current = state;
    return loaded;
  }

  /** The running child; after a crash, a new one with the model loaded again */
  const ready = () => (current ? Promise.resolve(current) : launch());

  const first = await ready();
  return {
    backend: first.backend,

    async transcribe(samples) {
      if (disposed) throw new Error("The transcriber process is closed");
      const state = await ready();
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          state.pending.delete(id);
          reject(new Error(`Local transcription gave no reply for ${Math.round(timeoutFor(samples) / 1000)} s`));
          // A hung runtime can't be saved, so end it. Detach it first: transcriptions arriving before it exits go to the new one
          log.error("transcriber_timeout", { model: model.id, seconds: samples.length / SPEECH_SAMPLE_RATE });
          if (current === state) current = null;
          state.child.kill();
        }, timeoutFor(samples));
        state.pending.set(id, { resolve, reject, timer });
        // If it crashed at this very moment the channel is already closed, and the exit handler reports this as failed
        if (state.child.connected) state.child.send({ type: "transcribe", id, samples });
      });
    },

    /** Unloads the model and ends the child. Unusable afterwards */
    dispose() {
      disposed = true;
      if (!current) return;
      const { child } = current;
      current = null;
      // Ask it to clean up first (release GPU resources); force it after two seconds
      if (child.connected) child.send({ type: "dispose" });
      setTimeout(() => child.kill(), 2_000).unref();
    },
  };
}
