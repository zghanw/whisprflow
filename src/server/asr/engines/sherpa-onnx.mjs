import { dirname } from "node:path";
import { SPEECH_SAMPLE_RATE } from "../../audio/pcm.mjs";

// The sherpa-onnx (k2-fsa, Apache-2.0) adapter: ONNX Runtime on the CPU, with prebuilt npm packages for both Mac chips, Windows, and Linux.
// Interface: see index.mjs.

/** Threads used when none are given */
const DEFAULT_THREADS = 4;

/**
 * Known model families. config: how the catalog files (named by role) go into sherpa-onnx's modelConfig, where file(role) is that file's full path;
 * clean: turns markers the runtime left in this family's output into clean text (unchanged when there are none).
 */
export const FAMILIES = Object.freeze({
  "qwen3-asr": Object.freeze({
    config: (file) => ({
      qwen3Asr: {
        convFrontend: file("convFrontend"),
        encoder: file("encoder"),
        decoder: file("decoder"),
        // The tokenizer is a directory holding all three files
        tokenizer: dirname(file("tokenizerVocab")),
        hotwords: "",
      },
      tokens: "",
    }),
    // Qwen3-ASR outputs "language None" when it hears no speech; sherpa-onnx strips only the prefix, leaving None (measured: 7.9 s of silence)
    clean: (text) => (text === "None" ? "" : text),
  }),
});

export async function version() {
  const { default: sherpa } = await import("sherpa-onnx-node");
  return sherpa.version;
}

/** @param {{ model: object, file: (role: string) => string, options?: { threads?: number } }} request */
export async function load({ model, file, options = {} }) {
  const { default: sherpa } = await import("sherpa-onnx-node");
  const { clean } = FAMILIES[model.family];
  const recognizer = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: SPEECH_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      ...FAMILIES[model.family].config(file),
      numThreads: options.threads ?? DEFAULT_THREADS,
      provider: "cpu",
      debug: 0,
    },
  });
  return {
    backend: "cpu",
    async transcribe(samples) {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: SPEECH_SAMPLE_RATE, samples });
      const result = await recognizer.decodeAsync(stream);
      const text = String(result.text ?? "").trim();
      return { text: clean ? clean(text) : text };
    },
    // The sherpa-onnx Node package has no explicit release; the recognizer goes with garbage collection
    dispose() {},
  };
}
