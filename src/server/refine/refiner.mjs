import { LocalizedError, msg } from "../../i18n/index.mjs";
import { toWav } from "../audio/transcode.mjs";
import { toModelError } from "../providers/errors.mjs";
import { findProvider } from "../providers/index.mjs";
import { createMeter } from "./meter.mjs";
import { textFromModelOutput } from "./output.mjs";
import { SYSTEM_PROMPT, TASK_REMINDER } from "./prompt.mjs";

// The native path: the recording goes straight to an audio model, one request returns the finished text.

/** Models that hear audio track "minutes:seconds" positions and sometimes write one into the text (like "Ship it, 00:30 migrate everything"). A leading zero tells it apart from a clock time like 3:30 */
const STRAY_TIMESTAMP = /(?<!\d)0\d:\d{2}(?!\d)/;

/** The longest one request may take. Gemini answers in a second or two, OpenAI in seven or eight for a 90 s recording; plenty of headroom */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The "audio in, finished text out" step. One flow for every vendor: convert the recording if this vendor doesn't take its format, get the text from the adapter,
 * then finish it the same way; adapters only handle "how this vendor's request is built and its errors recognized".
 *
 * Every call that got a reply is billed (onCall, rules in meter.mjs).
 *
 * @param {object} options
 * @param {{ id: string, name: string }} options.provider the vendor registry entry (providers/index.mjs)
 * @param {{ ping(o: { signal: AbortSignal }): Promise<{ usage: object }>, generate(request: object): Promise<{ text: string | null | undefined, problem: object | null, usage: object }> }} options.client
 *   this vendor's adapter (createClient in providers/*.mjs)
 * @param {string[]} options.audioTypes recording formats this vendor takes directly
 * @param {(error: unknown, detail: string) => object | null} [options.classify] how this vendor's errors are recognized
 * @param {string} [options.apiKey] only used to scrub it from error text
 * @param {(audio: Buffer, mimeType: string) => Promise<{ audio: Buffer, mimeType: string }>} [options.transcode]
 * @param {(record: object) => void} [options.onCall] billing, see meter.mjs
 * @returns {{ warmUp(): Promise<void>, prepare(): Promise<void>, refine(audio: Buffer, o: { mimeType: string, signal?: AbortSignal, audioId?: string }): Promise<string> }}
 *   every error thrown is a ModelError
 */
export function createRefiner({
  provider,
  client,
  audioTypes,
  classify,
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  log,
  transcode = toWav,
  onCall = () => {},
}) {
  const described = (error) => toModelError(error, { provider, apiKey, classify });
  const withTimeout = (signal) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  };

  const metered = createMeter({ provider, log, onCall });

  return {
    /**
     * Sends the smallest request on startup. Measured: the first cleanup in a process takes 3.4 to 4.1 s, later ones a steady 1.7 to 1.9 s
     * (Gemini, even after 3 idle minutes); sending this one first keeps the slow one off the user's first sentence.
     * An invalid key or misspelled model name also shows up here instead of on the first dictation.
     */
    async warmUp() {
      try {
        await metered("check", null, () => client.ping({ signal: AbortSignal.timeout(timeoutMs) }));
      } catch (error) {
        throw described(error);
      }
    },

    /**
     * The user started speaking: let the vendor prepare what it needs so cleanup can use it. Only Gemini does anything now (builds a prompt cache,
     * see providers/gemini-cache.mjs), billed as "cache". A failure only makes this one call pricier: it logs a warning and never throws
     */
    async prepare() {
      if (!client.prepare) return;
      try {
        await metered("cache", null, () => client.prepare({ systemPrompt: SYSTEM_PROMPT }));
      } catch (error) {
        log.warn("prompt_cache_failed", { provider: provider.id, error: described(error).detail.slice(0, 300) });
      }
    },

    /**
     * @param {{ mimeType: string, signal?: AbortSignal, audioId?: string }} options audioId: which dictation this is, for billing
     * @returns {Promise<string>} the finished text; empty when there was no speech
     */
    async refine(audio, { mimeType, signal, audioId = null }) {
      try {
        // Convert once: a timestamp retry reuses the same copy
        const input = audioTypes.includes(mimeType)
          ? { audio, mimeType }
          : await timed(log, () => transcode(audio, mimeType));
        const generateOnce = async () => {
          const reply = await metered("dictation", audioId, () =>
            client.generate({
              ...input,
              systemPrompt: SYSTEM_PROMPT,
              reminder: TASK_REMINDER,
              signal: withTimeout(signal),
            }),
          );
          // Blocked or truncated: the adapter gave the reason (a msg); report it as is
          if (reply.problem) throw new LocalizedError(reply.problem);
          return textFromModelOutput(reply.text);
        };
        return await generateClean(generateOnce, log);
      } catch (error) {
        throw described(error);
      }
    },
  };
}

/** Records how long conversion took: it counts toward the user's wait for the text */
async function timed(log, transcode) {
  const startedAt = performance.now();
  const converted = await transcode();
  log.info("audio_transcoded", { to: converted.mimeType, ms: Math.round(performance.now() - startedAt) });
  return converted;
}

/**
 * Builds a refiner for the user's vendor and model: finds the vendor in the registry, loads its adapter, and hands it to the shared flow above.
 * @param {object} options
 * @param {{ provider: string, model: string }} options.choice
 * @param {string} options.apiKey
 * @param {string} [options.thinkingLevel] only Gemini uses it
 * @param {(record: object) => void} [options.onCall] billing, see createRefiner
 */
export async function createModelRefiner({ choice, apiKey, thinkingLevel, timeoutMs, log, onCall }) {
  const provider = findProvider(choice.provider);
  if (!provider) throw new LocalizedError(msg("key.unknownProvider", { id: choice.provider }));
  const adapter = await provider.load();
  return createRefiner({
    provider,
    client: adapter.createClient({ apiKey, model: choice.model, thinkingLevel, log }),
    audioTypes: adapter.AUDIO_TYPES,
    classify: adapter.classifyError,
    apiKey,
    timeoutMs,
    log,
    onCall,
  });
}

/**
 * Gets the text once; if it contains a stray timestamp, asks again and uses the second result.
 * The timestamp isn't just deleted because the speaker may really have said a time: if the retry still has it, it is theirs.
 * Stray timestamps are rare, so the extra request almost only lands on broken output.
 *
 * @param {() => Promise<string>} generateOnce
 * @param {{ warn: (event: string, fields: object) => void }} log
 */
export async function generateClean(generateOnce, log) {
  const first = await generateOnce();
  if (!STRAY_TIMESTAMP.test(first)) return first;
  log.warn("refine_retry", { reason: "stray timestamp in the text" });
  return generateOnce();
}
