import { LocalizedError, msg } from "../../i18n/index.mjs";
import { chatEndpoint, findChatVendor, PROTOCOLS, requestFor } from "../chat/vendors.mjs";
import { toModelError } from "../providers/errors.mjs";
import { createLearner } from "./learner.mjs";
import { createMeter } from "./meter.mjs";
import { textFromModelOutput } from "./output.mjs";
import { polishInput, polishPrompt } from "./polish-prompt.mjs";

// Cleanup: the on-device transcript in, the finished text out. Step two of the local transcription path; the user picks which text model does it (chat/vendors.mjs).
// A sibling of the native path's refiner.mjs: billing (meter.mjs) and finishing (output.mjs) are shared, each has its own prompt.

/** The longest one request may take. A small local model answers a sentence or two in about a second and a long paragraph in a few; plenty of headroom */
const DEFAULT_TIMEOUT_MS = 30_000;
/** The background warm-up of an on-device model: a cold load from disk, plus the one-time GPU kernel compile after an Ollama update, can take minutes */
const PRIME_TIMEOUT_MS = 300_000;

/**
 * @param {object} options
 * @param {{ id: string, name: string }} options.endpoint which vendor (id for billing, name for errors)
 * @param {{ ping(o: { signal: AbortSignal }): Promise<{ usage: object }>, complete(request: object): Promise<{ text: string | null, problem: object | null, usage: object }> }} options.client
 *   the protocol client (createClient in chat/openai-chat.mjs)
 * @param {(error: unknown, detail: string) => object | null} [options.classify] how this protocol's errors are recognized
 * @param {string} [options.apiKey] only used to scrub it from error text
 * @param {(record: object) => void} [options.onCall] billing, see meter.mjs
 * @param {(terms: string[], app: string | null) => string} [options.prompt] builds the system prompt from the dictionary's terms and the app being typed into;
 *   replaceable to try out a candidate prompt
 * @param {{ terms(): string[], learn(terms: string[]): string[] } | null} [options.dictionary] the user's dictionary (storage/dictionary.mjs):
 *   its terms go in the prompt as preferred spellings, and on-device cleanup learns new ones after each dictation
 * @param {string | null} [options.localModel] set when the service runs on this computer (Ollama): the model it should have.
 *   Warming up then checks the service is running with that model, and loads it with one real cleanup in the background
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
  prompt = polishPrompt,
  localModel = null,
  dictionary = null,
}) {
  const described = (error) => toModelError(error, { provider: endpoint, apiKey, classify });
  const metered = createMeter({ provider: endpoint, log, onCall });
  const withTimeout = (signal) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  };
  const system = (app = null) => prompt(dictionary?.terms() ?? [], app);
  // Learning asks the model a second question per dictation: only on this computer, where it costs nothing and the text stays here
  const learn = localModel && dictionary ? createLearner({ client, dictionary, log }) : null;

  /**
   * An on-device service: listing its models shows whether it runs and has the model, without loading it. Then one real cleanup runs in the background,
   * as v1 did: it loads the model and compiles what the first run needs, so the first dictation pays for neither. Not awaited, so verifying stays quick;
   * a dictation meanwhile waits on the same load
   */
  async function warmUpLocal() {
    try {
      const listed = await client.listModels({ signal: AbortSignal.timeout(timeoutMs) });
      // Ollama lists a model pulled without a tag as name:latest
      if (!listed.some((id) => id === localModel || id === `${localModel}:latest`)) {
        throw new LocalizedError(msg("model.notPulled", { provider: endpoint.name, model: localModel }));
      }
    } catch (error) {
      const failure = described(error);
      // Not pulled yet is a setup step, not a broken route: cleanup is skipped until it is (see local.mjs)
      if (error instanceof LocalizedError) failure.kind = "unavailable";
      throw failure;
    }
    const startedAt = performance.now();
    client
      .complete({ system: system(), user: polishInput("warm up"), signal: AbortSignal.timeout(PRIME_TIMEOUT_MS) })
      .then(
        () => log.info("cleanup_primed", { provider: endpoint.id, ms: Math.round(performance.now() - startedAt) }),
        (error) => log.warn("cleanup_prime_failed", { provider: endpoint.id, error: String(error?.message ?? error) }),
      );
  }

  return {
    /** Sends the smallest request on startup and key changes: a wrong key, address, or model name shows up here, and the first cleanup after it isn't slow */
    async warmUp() {
      if (localModel) return warmUpLocal();
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
    async polish(transcript, { signal, audioId = null, app = null } = {}) {
      // Nothing transcribed (silence, only noise): no need to spend a request
      if (transcript.trim() === "") return "";
      try {
        const reply = await metered("dictation", audioId, () =>
          client.complete({ system: system(app), user: polishInput(transcript), signal: withTimeout(signal) }),
        );
        if (reply.problem) throw new LocalizedError(reply.problem);
        const text = textFromModelOutput(reply.text);
        // In the background: the text is delivered without waiting for it
        if (learn && text) learn(text);
        return text;
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
export async function createChatPolisher({
  choice,
  customUrl = null,
  apiKey,
  timeoutMs,
  log,
  onCall,
  fetch,
  prompt,
  dictionary = null,
}) {
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
  // Keyless vendors run on this computer (Ollama)
  const local = vendor.keyEnv === null;
  return createPolisher({
    endpoint: { id: vendor.id, name, local },
    client,
    classify: (error) => protocol.classifyError(error, { name }),
    apiKey,
    timeoutMs,
    log,
    onCall,
    ...(prompt ? { prompt } : {}),
    localModel: local ? choice.model : null,
    dictionary,
  });
}
