// A fake transcriber process: the real protocol (serveTranscriber in worker.mjs) with a fake model.
// The sample count decides what it does: 1 crashes the process, 2 never replies, 3 is a runtime error, anything else replies "model id:sample count"
import { serveTranscriber } from "../../../src/server/asr/worker.mjs";

serveTranscriber(
  { on: (event, handler) => process.on(event, handler), send: (m) => process.send(m), exit: process.exit },
  async ({ model, options }) => {
    if (options.failLoad) throw new Error("corrupt model file");
    return {
      backend: "fake",
      async transcribe(samples) {
        if (samples.length === 1) process.exit(3);
        if (samples.length === 2) return new Promise(() => {});
        if (samples.length === 3) throw new Error("runtime error");
        if (!(samples instanceof Float32Array)) throw new Error("samples are not a Float32Array");
        return { text: `${model.id}:${samples.length}` };
      },
      dispose() {},
    };
  },
);
process.on("disconnect", () => process.exit(0));
