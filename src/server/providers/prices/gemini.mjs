// Gemini's price list and pricing rules, copied from the official price list https://ai.google.dev/gemini-api/docs/pricing (2026-10-14),
// Standard tier paid prices only: our requests use none of Batch, Flex, or Priority. Free-tier use costs nothing but is still priced at paid rates here, so these are estimates.
// Rules (all from the price list):
//   - Input is priced by type: some models charge more for audio than text (images and video cost the same as text, and we send neither), some don't
//   - Output, thinking tokens included, uses the output price
//   - Input that hits the implicit cache uses the cache price, also split by audio and text
//   - Pro has two tiers by this call's prompt length: over 200K tokens, the whole call uses the higher tier
//   - Some models get pricier from a date: the price on the day of the call (UTC) applies
//   - Explicit caching adds storage: cached tokens times hours, per million tokens per hour (storage). Models with only implicit caching have none
// Prices are US dollars per million tokens (storage per million tokens per hour). Update here from the official page when prices change, and update the date above.

const PER_MILLION = 1_000_000;
/** A Pro prompt over this many tokens uses the higher tier */
const LONG_PROMPT = 200_000;

/** 3.6 Flash and 3.8 Flash cost the same and double from 2027-01-01. until is the day the new price starts */
const FLASH = [
  { until: "2027-01-01", input: 0.75, output: 3.75, cached: 0.075, storage: 0.5 },
  { input: 1.5, output: 7.5, cached: 0.15, storage: 1 },
];
const PRO_3_1 = [{ input: 2, output: 12, cached: 0.2, storage: 4.5, long: { input: 4, output: 18, cached: 0.4 } }];

/**
 * Model to its price periods, sorted by date. Without audio / cachedAudio, audio costs the same as text.
 * Retired models whose requests are redirected to a newer one (per the deprecation page) price as the target: replies report the target, so these two rows are only a fallback.
 */
export const PRICES = Object.freeze({
  // Implicit caching only, no storage price
  "gemini-4-argon": [
    { until: "2026-12-01", input: 2, output: 10, cached: 0.1 },
    { input: 4, output: 20, cached: 0.2 },
  ],
  "gemini-3.8-flash": FLASH,
  "gemini-3.7-flash": FLASH,
  "gemini-3.6-flash": FLASH,
  "gemini-3.5-flash": FLASH,
  "gemini-3.5-flash-lite": [{ input: 0.3, output: 2.5, cached: 0.03, storage: 1 }],
  "gemini-3.1-flash-lite": [{ input: 0.25, audio: 0.5, output: 1.5, cached: 0.025, cachedAudio: 0.05, storage: 1 }],
  "gemini-3.1-pro-preview": PRO_3_1,
  "gemini-3.1-pro-preview-customtools": PRO_3_1,
  "gemini-3-flash-preview": [{ input: 0.5, audio: 1, output: 3, cached: 0.05, cachedAudio: 0.1, storage: 1 }],
  "gemini-2.5-pro": [
    { input: 1.25, output: 10, cached: 0.125, storage: 4.5, long: { input: 2.5, output: 15, cached: 0.25 } },
  ],
  "gemini-2.5-flash": [{ input: 0.3, audio: 1, output: 2.5, cached: 0.03, cachedAudio: 0.1, storage: 1 }],
  "gemini-2.5-flash-lite": [{ input: 0.1, audio: 0.3, output: 0.4, cached: 0.01, cachedAudio: 0.03, storage: 1 }],
});

/**
 * The price shown on the model page: that day's audio input and output prices, US dollars per million tokens (the native path takes audio). null when not listed
 * @returns {{ currency: "USD", input: number, output: number } | null}
 */
export function listPrice(model, at = new Date()) {
  const price = priceOn(model, at);
  return price ? { currency: "USD", input: price.audio ?? price.input, output: price.output } : null;
}

/** This model's price on this day; undefined when not listed */
function priceOn(model, at) {
  const day = at.toISOString().slice(0, 10);
  return PRICES[model]?.find(({ until }) => until === undefined || day < until);
}

/**
 * What one call cost in US dollars. null when the model isn't listed.
 * @param {string} model the model that actually answered (modelVersion in the reply)
 * @param {{ text: number, audio: number, cachedText: number, cachedAudio: number, output: number }} tokens
 *   input split by type, each including its cache hits (cachedText, cachedAudio); output includes thinking
 * @param {Date} at when the call was made
 * @returns {number | null}
 */
export function costOf(model, tokens, at) {
  let price = priceOn(model, at);
  if (!price) return null;
  if (price.long && tokens.text + tokens.audio > LONG_PROMPT) price = price.long;
  const audio = price.audio ?? price.input;
  const cachedAudio = price.cachedAudio ?? price.cached;
  return (
    ((tokens.text - tokens.cachedText) * price.input +
      tokens.cachedText * price.cached +
      (tokens.audio - tokens.cachedAudio) * audio +
      tokens.cachedAudio * cachedAudio +
      tokens.output * price.output) /
    PER_MILLION
  );
}

/**
 * Explicit cache storage for that long, in US dollars. null when the model isn't listed or has no explicit caching.
 * @param {string} model
 * @param {number} tokens how many tokens were cached
 * @param {number} hours how long
 * @param {Date} at when it was stored (that day's price)
 */
export function storageCostOf(model, tokens, hours, at) {
  const price = priceOn(model, at);
  if (price?.storage === undefined) return null;
  return (tokens * hours * price.storage) / PER_MILLION;
}
