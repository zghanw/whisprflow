import { pathToFileURL } from "node:url";
import { loadTranscriber } from "./engines/index.mjs";

// The worker end of the transcriber process: loads the model in the child process started by host.mjs and transcribes on the parent's messages.
// Messages (Node IPC, advanced serialization, Float32Array passed as is):
//   parent to child  { type: "load", model, dir, options }      load the model, sent once
//                    { type: "transcribe", id, samples, hotwords }  samples: 16 kHz mono Float32Array; hotwords: dictionary terms
//                    { type: "dispose" }                        unload the model and exit
//   child to parent  { type: "loaded", backend, loadMs, warmupMs } or { type: "failed", message }
//                    warmupMs: how long the GPU warm-up after loading took (included in loadMs), null when there is none
//                    { type: "result", id, text } or { type: "error", id, message }

/**
 * @param {{ on: Function, send: Function, exit?: Function }} channel the child process itself (process); a fake in tests
 * @param {typeof loadTranscriber} [load]
 */
export function serveTranscriber(channel, load = loadTranscriber) {
  let transcriber = null;
  channel.on("message", async (message) => {
    switch (message?.type) {
      case "load": {
        const startedAt = performance.now();
        try {
          transcriber = await load({ model: message.model, dir: message.dir, options: message.options });
          channel.send({
            type: "loaded",
            backend: transcriber.backend,
            loadMs: Math.round(performance.now() - startedAt),
            warmupMs: transcriber.warmupMs ?? null,
          });
        } catch (error) {
          channel.send({ type: "failed", message: String(error?.stack ?? error) });
        }
        break;
      }
      case "transcribe": {
        try {
          if (!transcriber) throw new Error("The model is not loaded yet");
          const { text } = await transcriber.transcribe(message.samples, { hotwords: message.hotwords ?? [] });
          channel.send({ type: "result", id: message.id, text });
        } catch (error) {
          channel.send({ type: "error", id: message.id, message: String(error?.stack ?? error) });
        }
        break;
      }
      case "dispose":
        transcriber?.dispose();
        transcriber = null;
        channel.exit?.(0);
        break;
      default:
        channel.send({ type: "error", id: message?.id ?? null, message: `Unknown message: ${message?.type}` });
    }
  });
}

// Starts listening only when host.mjs starts it as a child process; importing it in tests does nothing
if (process.send && import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  serveTranscriber({
    on: (event, handler) => process.on(event, handler),
    send: (m) => process.send(m),
    exit: process.exit,
  });
  // Exit with the parent (crash, forced kill) instead of leaving an orphan holding a GB or two of memory
  process.on("disconnect", () => process.exit(0));
}
