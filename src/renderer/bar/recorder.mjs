// Recording: opens the microphone and emits an Opus chunk every 3 seconds. Settings:
// mono, 32 kbps, a chunk every 3 seconds, with echo cancellation, noise suppression, and auto gain all off, so the model gets the raw sound.
// The container is WebM from the browser's built-in MediaRecorder, so no bundled encoder is needed.

import { LocalizedError, msg } from "../../i18n/index.mjs";
import { meterLevels, openMicrophone } from "../shared/level-meter.mjs";

const CHUNK_MS = 3_000;
const MIME_TYPE = "audio/webm;codecs=opus";

/**
 * @param {object} handlers
 * @param {(chunk: Blob) => void} handlers.onChunk a chunk every 3 seconds, plus a last one at the end
 * @param {(level: number) => void} handlers.onLevel instantaneous volume from 0 to 1, every 50 ms (the floating bar's wave rises at this pace)
 * @param {(error: Error) => void} handlers.onError an error mid-recording
 */
export async function startRecording({ onChunk, onLevel, onError }) {
  const stream = await openMicrophone();
  const recorder = new MediaRecorder(stream, { mimeType: MIME_TYPE, audioBitsPerSecond: 32_000 });
  const chunks = [];
  let cancelled = false;

  recorder.addEventListener("dataavailable", (event) => {
    if (cancelled || event.data.size === 0) return;
    chunks.push(event.data);
    onChunk(event.data);
  });
  recorder.addEventListener("error", (event) => {
    if (!cancelled) {
      const reason = event.error?.message ?? msg("common.unknownReason");
      onError(new LocalizedError(msg("bar.recordError", { reason })));
    }
  });

  // Volume: some feedback for the interface, and a way to catch "no signal at all from the microphone" (device muted, wrong input chosen)
  const meter = meterLevels(stream, onLevel);
  const release = () => {
    meter.stop();
    for (const track of stream.getTracks()) track.stop();
  };

  const startedAt = performance.now();
  recorder.start(CHUNK_MS);

  return {
    /** Ends recording. The last chunk goes out through onChunk first, and only then does this return */
    stop() {
      return new Promise((resolve) => {
        recorder.addEventListener(
          "stop",
          () => {
            release();
            resolve({
              blob: new Blob(chunks, { type: MIME_TYPE }),
              durationSeconds: (performance.now() - startedAt) / 1000,
              hadSignal: meter.hadSignal(),
            });
          },
          { once: true },
        );
        recorder.stop();
      });
    },
    /** Discards this recording; what was recorded is no longer handed out */
    cancel() {
      cancelled = true;
      if (recorder.state !== "inactive") recorder.stop();
      release();
    },
  };
}
