import { LocalizedError, msg } from "../../../i18n/index.mjs";
import { encodeWav, SPEECH_SAMPLE_RATE } from "../../audio/pcm.mjs";
import { toModelError } from "../../providers/errors.mjs";
import { createMeter } from "../../refine/meter.mjs";
import { joinTexts, planWindows } from "../segment.mjs";
import { cloudModelOf, findCloudTranscriber } from "./vendors.mjs";

// The cloud transcriber: wraps a vendor adapter into what step one of the local path needs, with the same interface as the on-device transcriber (../host.mjs):
//   await transcriber.warmUp()                                   // checks the key and model name, and keeps the first call fast
//   const { text } = await transcriber.transcribe(samples, { signal, audioId })   // 16 kHz mono
// Every reply is billed (rules as in ../../refine/meter.mjs): cloud transcription is charged by time or tokens, recorded apart from cleanup.
// Recordings longer than the model accepts (maxSeconds in the catalog) are split here (../segment.mjs, as for on-device models), one request and one bill per piece;
// fully silent pieces aren't sent: pressing the hotkey by mistake shouldn't cost a request, and some models invent words from silence.
// Every error thrown is a ModelError, so the server tells the user the same way.

/** The longest one request may take. Plenty of headroom over the 1.6 to 1.8 s measured for 23 to 55 s recordings */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * @param {object} options
 * @param {{ vendor: string, model: string }} options.choice
 * @param {string} options.apiKey
 * @param {{ info: Function, warn: Function, error: Function }} options.log
 * @param {(record: object) => void} [options.onCall]
 * @param {typeof fetch} [options.fetch] replaced by a fake in tests
 */
export async function createCloudTranscriber({
  choice,
  apiKey,
  log,
  onCall = () => {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetch,
}) {
  const vendor = findCloudTranscriber(choice.vendor);
  if (!vendor) throw new LocalizedError(msg("key.unknownProvider", { id: choice.vendor }));
  const adapter = await vendor.load();
  const client = adapter.createClient({ apiKey, model: choice.model, ...(fetch ? { fetch } : {}) });
  // An unlisted model has no known limit, so the whole recording goes as one piece
  const maxSeconds = cloudModelOf(vendor, choice.model)?.maxSeconds ?? null;
  const endpoint = { id: vendor.id, name: vendor.name };
  const described = (error) => toModelError(error, { provider: endpoint, apiKey, classify: adapter.classifyError });
  const metered = createMeter({ provider: endpoint, log, onCall });
  const withTimeout = (signal) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  };

  return {
    async warmUp() {
      try {
        await metered("check", null, () => client.ping({ signal: AbortSignal.timeout(timeoutMs) }));
      } catch (error) {
        throw described(error);
      }
    },

    /**
     * @param {Float32Array} samples 16 kHz mono
     * @returns {Promise<{ text: string }>} the transcript with surrounding whitespace trimmed, nothing else changed (cleanup is the next step's job)
     */
    async transcribe(samples, { signal, audioId = null } = {}) {
      const windows = planWindows(samples, SPEECH_SAMPLE_RATE, maxSeconds);
      if (windows.length === 0) return { text: "" };
      try {
        // Pieces go out together: cloud pieces are independent, and waiting one by one is only slower. Texts join in piece order, not reply order
        const replies = await Promise.all(
          windows.map(([start, end]) => {
            const wav = encodeWav(samples.subarray(start, end), SPEECH_SAMPLE_RATE);
            return metered("dictation", audioId, () => client.transcribe({ wav, signal: withTimeout(signal) }));
          }),
        );
        return { text: joinTexts(replies.map((reply) => String(reply.text ?? ""))) };
      } catch (error) {
        throw described(error);
      }
    },
  };
}
