import { LocalizedError, msg } from "../../i18n/index.mjs";
import { chatEndpoint, findChatVendor, PROTOCOLS, requestFor } from "../chat/vendors.mjs";
import { toModelError } from "../providers/errors.mjs";
import { createMeter } from "./meter.mjs";
import { textFromModelOutput } from "./output.mjs";
import { POLISH_PROMPT, polishInput } from "./polish-prompt.mjs";

// Cleanup: the on-device transcript in, the finished text out. Step two of the local transcription path; the user picks which text model does it (chat/vendors.mjs).
// A sibling of the native path's refiner.mjs: billing (meter.mjs) and finishing (output.mjs) are shared, each has its own prompt.

/** The longest one request may take. A small local model answers a sentence or two in about a second and a long paragraph in a few; plenty of headroom */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * @param {object} options
 * @param {{ id: string, name: string }} options.endpoint which vendor (id for billing, name for errors)
 * @param {{ ping(o: { signal: AbortSignal }): Promise<{ usage: object }>, complete(request: object): Promise<{ text: string | null, problem: object | null, usage: object }> }} options.client
 *   the protocol client (createClient in chat/openai-chat.mjs)
 * @param {(error: unknown, detail: string) => object | null} [options.classify] how this protocol's errors are recognized
 * @param {string} [options.apiKey] only used to scrub it from error text
 * @param {(record: object) => void} [options.onCall] billing, see meter.mjs
 * @param {string} [options.prompt] the system prompt; replaceable to try out a candidate prompt
 * @returns {{ warmUp(): Promise<void>, polish(transcript: string, o: { signal?: AbortSignal, audioId?: string }): Promise<string> }}
 *   every error thrown is a ModelError
 */
export function createPolisher({
  endpoint,
  client,
  classify,
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  log,
  onCall = () => {},
  prompt = POLISH_PROMPT,
}) {
  const described = (error) => toModelError(error, { provider: endpoint, apiKey, classify });
  const metered = createMeter({ provider: endpoint, log, onCall });
  const withTimeout = (signal) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  };

  return {
    /** Sends the smallest request on startup and key changes: a wrong key, address, or model name shows up here, and the first cleanup after it isn't slow */
    async warmUp() {
      try {
        await metered("check", null, () => client.ping({ signal: AbortSignal.timeout(timeoutMs) }));
      } catch (error) {
        throw described(error);
      }
    },

    /**
     * @param {string} transcript the on-device transcript
     * @returns {Promise<string>} the finished text; empty when the transcript is empty or the model finds nothing to type
     */
    async polish(transcript, { signal, audioId = null } = {}) {
      // Nothing transcribed (silence, only noise): no need to spend a request
      if (transcript.trim() === "") return "";
      try {
        const reply = await metered("dictation", audioId, () =>
          client.complete({ system: prompt, user: polishInput(transcript), signal: withTimeout(signal) }),
        );
        if (reply.problem) throw new LocalizedError(reply.problem);
        return textFromModelOutput(reply.text);
      } catch (error) {
        throw described(error);
      }
    },
  };
}

/**
 * Builds a polisher for the user's vendor and model: finds the vendor in the registry, loads its protocol, and passes its address, this model's parameters, and price.
 * @param {object} options
 * @param {{ vendor: string, model: string }} options.choice
 * @param {string | null} [options.customUrl] the custom service address (customUrl in settings)
 * @param {string} options.apiKey
 * @param {typeof fetch} [options.fetch] replaced by a fake in tests
 * @param {string} [options.prompt] see createPolisher
 */
export async function createChatPolisher({ choice, customUrl = null, apiKey, timeoutMs, log, onCall, fetch, prompt }) {
  const vendor = findChatVendor(choice.vendor);
  if (!vendor) throw new LocalizedError(msg("key.unknownProvider", { id: choice.vendor }));
  const { baseUrl, name } = chatEndpoint(vendor, { customUrl });
  const protocol = await PROTOCOLS[vendor.protocol].load();
  const costOf = vendor.prices ? (await vendor.prices()).costOf : null;
  const client = protocol.createClient({
    baseUrl,
    apiKey,
    model: choice.model,
    name,
    request: requestFor(vendor, choice.model),
    costOf,
    ...(fetch ? { fetch } : {}),
  });
  return createPolisher({
    endpoint: { id: vendor.id, name },
    client,
    classify: (error) => protocol.classifyError(error, { name }),
    apiKey,
    timeoutMs,
    log,
    onCall,
    prompt,
  });
}
