import { msg, problemOf } from "../../i18n/index.mjs";
import { SPEECH_SAMPLE_RATE } from "../audio/pcm.mjs";
import { toSpeech } from "../audio/transcode.mjs";
import { ModelError } from "../providers/errors.mjs";

// Local transcription path: recording, then 16 kHz mono, then transcription (step one, an on-device or cloud model), then a text model cleans it up (step two), then the result.
// A sibling of the native path (refiner.mjs) with the same interface (warmUp, prepare, refine), so the server needn't know which path runs.
// Each step is a strategy: the model catalog and the transcriber process (asr/) decide the transcriber, the polisher (polisher.mjs) decides who cleans up;
// this file only chains them in order.
// Each step is billed separately: the polisher records cleanup (cost, tokens), on-device transcription is recorded here (provider local, no cost),
// so usage shows which step each dictation's time went to and where the money went.
// When cleanup fails (Ollama not running, a timeout, a rejected key), what was heard is still delivered, with a notice saying cleanup was skipped:
// a dictation is never lost to step two.

/**
 * @param {object} options
 * @param {{ transcribe(samples: Float32Array, o: { signal?: AbortSignal, audioId?: string }): Promise<{ text: string }> }} options.transcriber
 *   step one: an on-device model (asr/host.mjs) or a cloud model (asr/cloud/transcriber.mjs)
 * @param {{ warmUp(): Promise<void>, polish(text: string, o: object): Promise<string> } | null} options.polisher
 *   step two (polisher.mjs). Private mode has none (null): the transcript is trimmed and returned as is, and nothing leaves the computer
 * @param {{ info: Function, error: Function }} options.log
 * @param {string | null} [options.model] which on-device model runs step one (an id from models/catalog.mjs), for billing.
 *   Left out when step one is a cloud model: it records its own billing (cost by duration or tokens)
 * @param {(record: object) => void} [options.onCall] billing, same shape as onCall in meter.mjs
 * @param {typeof toSpeech} [options.decode] replaced by a fake in tests
 * @returns refine resolves to the text, or { text, notice } when cleanup was skipped (notice is a msg for the user)
 */
export function createLocalRefiner({ transcriber, polisher, log, model, onCall = () => {}, decode = toSpeech }) {
  /** Failures outside the two steps (undecodable recording, local transcription error) are ModelErrors too, so the server tells the user the same way */
  const failed = (problem, error) =>
    new ModelError({ kind: "other", problem, detail: String(error?.message ?? error), origin: error?.stack });

  /** Records the on-device transcription step: no tokens, no cost, just how long it took. A failed record only loses one statistic and never holds up the dictation */
  function record(audioId, latencyMs) {
    try {
      onCall({
        purpose: "dictation",
        audioId,
        provider: "local",
        model,
        inputTokens: 0,
        audioTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        costUsd: 0,
        latencyMs,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      log.error("model_call_not_recorded", { audio_id: audioId, error: String(error?.stack ?? error) });
    }
  }

  return {
    /** Verifies the cleanup vendor's key, address, and model name, and makes the first cleanup fast. The transcriber was verified when installed; with no cleanup there is nothing to verify */
    warmUp: async () => {
      await polisher?.warmUp();
    },

    /** Nothing to prepare when speaking starts: the model stays loaded in the transcriber process */
    async prepare() {},

    async refine(audio, { mimeType, signal, audioId = null, app = null }) {
      const startedAt = performance.now();
      let samples;
      try {
        samples = await decode(audio, mimeType);
      } catch (error) {
        throw failed(error?.problem ?? msg("local.undecodable", { reason: problemOf(error) }), error);
      }
      const decodedAt = performance.now();
      let transcript;
      try {
        ({ text: transcript } = await transcriber.transcribe(samples, { signal, audioId }));
      } catch (error) {
        // Cloud transcription errors are already classified (bad key, temporarily unreachable, ...): pass them up unchanged
        if (error instanceof ModelError) throw error;
        // Errors that explain themselves (model still downloading, not installed) are shown as is; anything else came from the transcriber process or runtime
        const problem =
          error?.problem ?? msg("local.transcribeFailed", { reason: String(error?.message ?? error).slice(0, 200) });
        throw failed(problem, error);
      }
      const transcribedAt = performance.now();
      if (model) record(audioId, Math.round(transcribedAt - decodedAt));
      if (!polisher) {
        // Log only lengths and timings: the transcript is what the user said
        log.info("local_transcribed", {
          audio_id: audioId,
          seconds: Math.round((samples.length / SPEECH_SAMPLE_RATE) * 10) / 10,
          decode_ms: Math.round(decodedAt - startedAt),
          transcribe_ms: Math.round(transcribedAt - decodedAt),
          transcript_length: transcript.length,
        });
        return transcript.trim();
      }
      // The user disconnected during transcription: cleanup costs money, so don't send it
      signal?.throwIfAborted();
      let refined;
      let notice = null;
      try {
        refined = await polisher.polish(transcript, { signal, audioId, app });
      } catch (error) {
        if (signal?.aborted) throw error;
        log.warn("polish_skipped", {
          audio_id: audioId,
          kind: error?.kind,
          error: String(error?.detail ?? error).slice(0, 300),
        });
        refined = transcript.trim();
        notice = msg("local.cleanupSkipped", { reason: error?.problem ?? String(error?.message ?? error) });
      }
      // Log only lengths and timings: the transcript and result are what the user said
      log.info("local_refined", {
        audio_id: audioId,
        seconds: Math.round((samples.length / SPEECH_SAMPLE_RATE) * 10) / 10,
        decode_ms: Math.round(decodedAt - startedAt),
        transcribe_ms: Math.round(transcribedAt - decodedAt),
        polish_ms: Math.round(performance.now() - transcribedAt),
        transcript_length: transcript.length,
      });
      return notice ? { text: refined, notice } : refined;
    },
  };
}
