import { join } from "node:path";
import { SPEECH_SAMPLE_RATE } from "../../audio/pcm.mjs";
import { joinTexts, planWindows } from "../segment.mjs";

// The registry of on-device transcription runtimes. Each runtime has an adapter (sherpa-onnx.mjs, transcribe-cpp.mjs in this directory)
// that turns "a downloaded model directory" into one interface; callers only know this interface, so models and runtimes can change freely:
//
//   const transcriber = await loadTranscriber({ model, dir, options });  // dir: where the model was downloaded
//   const { text } = await transcriber.transcribe(samples);   // samples: 16 kHz mono Float32Array, any length
//   transcriber.backend                                       // where it really runs: cpu, metal, ...
//   transcriber.dispose();
//
// Recordings longer than a model accepts (maxSeconds in the catalog) are split here, and fully silent pieces skipped; adapters handle one piece.
// text is the recognized transcript: runtime markers and surrounding whitespace removed, nothing else changed (no punctuation edits); cleanup comes later.
// Adapters also export FAMILIES (the model families they know: config maps files into the config, clean removes that family's markers in this runtime)
// and version() (the runtime version).
// A runtime's package loads only in load(): cloud-only users don't pay its startup cost.
//
// Runtimes differ by system (Metal on Mac, Vulkan or CUDA on Windows); those differences stay inside each adapter.

// gpu: whether it can run on a GPU (options.backend takes auto, cpu, ...); runtimes without it run on the CPU and ignore backend
export const ENGINES = Object.freeze([
  Object.freeze({ id: "sherpa-onnx", name: "sherpa-onnx", gpu: false, load: () => import("./sherpa-onnx.mjs") }),
  Object.freeze({
    id: "transcribe-cpp",
    name: "transcribe.cpp",
    gpu: true,
    load: () => import("./transcribe-cpp.mjs"),
  }),
]);

/** @returns {(typeof ENGINES)[number] | null} */
export function findEngine(id) {
  return ENGINES.find((engine) => engine.id === id) ?? null;
}

/**
 * Builds a transcriber from a catalog entry.
 * @param {{ model: object, dir: string, options?: object }} request dir is where the model was downloaded (dirOf in models/store.mjs)
 */
export async function loadTranscriber({ model, dir, options = {} }) {
  const engine = findEngine(model.engine);
  if (!engine) throw new Error(`Model ${model.id} needs runtime ${model.engine}, which is not registered`);
  const adapter = await engine.load();
  if (!adapter.FAMILIES[model.family]) {
    throw new Error(`${engine.name} doesn't know the ${model.family} model family (${model.id})`);
  }
  /** A catalog file named by role, to its full path in the model directory */
  const file = (role) => {
    const entry = model.files[role];
    if (!entry) throw new Error(`Model ${model.id} has no ${role} file in the catalog`);
    return join(dir, entry.path);
  };
  return windowed(await adapter.load({ model, file, options }), model.maxSeconds);
}

/**
 * Wraps an adapter: long recordings are split by maxSeconds, transcribed piece by piece, and joined; fully silent pieces (or recordings) never reach the model.
 * Callers still hand over one whole recording. backend and dispose are the adapter's
 * @param {{ transcribe(samples: Float32Array): Promise<{ text: string }> }} transcriber what the adapter built
 * @param {number | null | undefined} maxSeconds the most it accepts at once; empty when unlimited
 */
export function windowed(transcriber, maxSeconds) {
  return {
    ...transcriber,
    async transcribe(samples) {
      const parts = [];
      for (const [start, end] of planWindows(samples, SPEECH_SAMPLE_RATE, maxSeconds)) {
        parts.push((await transcriber.transcribe(samples.subarray(start, end))).text);
      }
      return { text: joinTexts(parts) };
    },
  };
}
