import { costOf, storageCostOf } from "./prices/gemini.mjs";

// Gemini's prompt cache (explicit caching). Every cleanup sends the same 1350-token prompt, over 80% of a dictation's cost;
// cached, the prompt part costs a tenth, at the price of one standard-input charge to build it and hourly storage while it lives.
// Implicit caching doesn't help: 3.6 Flash needs a prompt prefix of at least 4096 tokens to hit (per the caching docs), and ours is under half that.
//
// It follows the rhythm of speech: built when speech starts (extended if it exists), used when cleaning up; after 30 quiet minutes it expires on its own
// and storage stops. The cache only saves money: any step that goes wrong falls back to a request without it, never delaying the sentence.

/**
 * How long the cache lives: each speech start extends it this far from then. Simulated on 126 days of real dictation timing (3169 dictations)
 * for the prompt part's cost: 5 minutes saves 45%, 15 minutes 57%, 30 minutes 61%, 60 minutes 62%. Longer barely saves more,
 * while idle storage grows
 */
export const CACHE_TTL_SECONDS = 30 * 60;
/** With less than this left it isn't used: a request may wait up to 30 s, and expiring midway is an error */
const MARGIN_MS = 60_000;
/** The longest a build or extension may take (measured 0.4 to 0.7 s). A hung one would hold "building" forever and nothing could be built again */
const REQUEST_TIMEOUT_MS = 15_000;
const HOUR_MS = 3_600_000;

/** The cache is already gone on Google's side (expired earlier than computed, or deleted). Measured: 403 "CachedContent not found (or permission denied)" */
export const cacheMissing = (error) => /CachedContent not found/i.test(String(error?.message ?? ""));

/**
 * @param {object} options
 * @param {{ create(params: object): Promise<object>, update(params: object): Promise<object> }} options.caches the SDK's caches
 * @param {string} options.model
 * @param {() => Date} options.now
 * @param {{ info: Function, warn: Function }} options.log
 */
export function createPromptCache({ caches, model, now, log }) {
  /** The built cache: { name, systemPrompt, model, tokens, expiresAt }; null when there is none */
  let cache = null;
  /** This model can't build explicit caches (from 4 Argon on, only implicit ones): don't try again */
  let unsupported = false;
  /** Building or extending in progress: two speech starts at once build one */
  let preparing = null;

  const usable = (systemPrompt) =>
    cache !== null && cache.systemPrompt === systemPrompt && cache.expiresAt - now().getTime() > MARGIN_MS;

  /** The expiry time in the reply; computed locally when it can't be read */
  const expiryOf = (reply, at) => {
    const parsed = Date.parse(reply?.expireTime ?? "");
    return Number.isNaN(parsed) ? at.getTime() + CACHE_TTL_SECONDS * 1000 : parsed;
  };

  /** An entry with cost but no token usage */
  const charge = (billed, inputTokens, costUsd) => ({
    model: billed,
    inputTokens,
    audioTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    costUsd,
  });

  async function create(systemPrompt) {
    let created;
    try {
      created = await caches.create({
        model,
        config: {
          systemInstruction: systemPrompt,
          ttl: `${CACHE_TTL_SECONDS}s`,
          abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      });
    } catch (error) {
      // 4xx (except rate limits): this model can't build one, or won't take this prompt, and retrying is the same. Offline or outages: try again on the next speech
      if (error?.status >= 400 && error.status < 500 && error.status !== 429) {
        unsupported = true;
        log.warn("prompt_cache_unsupported", { model, status: error.status });
      }
      throw error;
    }
    const at = now();
    const billed = created.model?.replace(/^models\//, "") || model;
    const tokens = created.usageMetadata?.totalTokenCount ?? 0;
    cache = { name: created.name, systemPrompt, model: billed, tokens, expiresAt: expiryOf(created, at) };
    log.info("prompt_cache_created", { model: billed, tokens, expires_at: new Date(cache.expiresAt).toISOString() });
    // Building costs one standard-input charge (per the Vertex AI caching docs; the Gemini API docs don't say, so the same is assumed),
    // plus the storage time bought now. Storage is charged for the time set (reportedly not refunded on early deletion, unverified), so the bought stretch is recorded
    const input = costOf(billed, { text: tokens, audio: 0, cachedText: 0, cachedAudio: 0, output: 0 }, at);
    const storage = storageCostOf(billed, tokens, (cache.expiresAt - at.getTime()) / HOUR_MS, at);
    return { usage: charge(billed, tokens, input === null || storage === null ? null : input + storage) };
  }

  async function extend(systemPrompt) {
    const current = cache;
    let updated;
    try {
      updated = await caches.update({
        name: current.name,
        config: { ttl: `${CACHE_TTL_SECONDS}s`, abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      });
    } catch (error) {
      if (!cacheMissing(error)) throw error;
      log.warn("prompt_cache_missing", { when: "extend" });
      cache = null;
      return create(systemPrompt);
    }
    const at = now();
    const expiresAt = expiryOf(updated, at);
    // Record the extra stretch bought: from the old expiry to the new one
    const hours = Math.max(0, expiresAt - current.expiresAt) / HOUR_MS;
    current.expiresAt = expiresAt;
    return { usage: charge(current.model, 0, storageCostOf(current.model, current.tokens, hours, at)) };
  }

  return {
    /**
     * Called when speech starts: builds the cache if there is none, extends it if there is.
     * @returns {Promise<{ usage: object } | null>} what this call cost (a build or the extra storage); null when nothing was done
     *   (the model can't build one, or a build is in progress). Throws on errors; the caller logs a warning and the dictation goes on
     */
    prepare(systemPrompt) {
      if (unsupported || preparing) return Promise.resolve(null);
      preparing = (usable(systemPrompt) ? extend(systemPrompt) : create(systemPrompt)).finally(() => {
        preparing = null;
      });
      return preparing;
    },

    /** The cache name usable for cleanup; null when the prompt differs, it is about to expire, or it isn't built yet */
    nameFor(systemPrompt) {
      return usable(systemPrompt) ? cache.name : null;
    },

    /** Found gone when used: drop it, the next speech builds a new one */
    forget(name) {
      if (cache?.name === name) cache = null;
      log.warn("prompt_cache_missing", { when: "generate" });
    },
  };
}
