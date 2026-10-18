// OpenAI's price list and pricing rules, copied from the official price list https://developers.openai.com/api/docs/pricing,
// the "Realtime and audio generation models" table (2026-10-14), only the gpt-audio series we use.
// Rules: text and audio each have a price, input and output apart; thinking tokens count as text output. These models list the cache price as "-",
// so cache hits cost the full price. Prices are US dollars per million tokens. Update here from the official page when prices change, and update the date above.

const PER_MILLION = 1_000_000;

export const PRICES = Object.freeze({
  "gpt-audio-mini": { text: { input: 0.6, output: 2.4 }, audio: { input: 10, output: 20 } },
  "gpt-audio-1.5": { text: { input: 2.5, output: 10 }, audio: { input: 32, output: 64 } },
  "gpt-audio": { text: { input: 2.5, output: 10 }, audio: { input: 32, output: 64 } },
});

/** Replies report a dated snapshot name (measured: gpt-audio-mini answers as gpt-audio-mini-2025-12-15); the date is dropped to look up the price */
const SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;

/**
 * The price shown on the model page: audio input and text output, US dollars per million tokens (dictation sends audio and gets text). null when not listed
 * @returns {{ currency: "USD", input: number, output: number } | null}
 */
export function listPrice(model) {
  const price = PRICES[model] ?? PRICES[model.replace(SNAPSHOT, "")];
  return price ? { currency: "USD", input: price.audio.input, output: price.text.output } : null;
}

/**
 * What one call cost in US dollars. null when the model isn't listed.
 * @param {string} model the model that actually answered (model in the reply)
 * @param {{ text: number, audio: number, textOutput: number, audioOutput: number }} tokens
 * @returns {number | null}
 */
export function costOf(model, tokens) {
  const price = PRICES[model] ?? PRICES[model.replace(SNAPSHOT, "")];
  if (!price) return null;
  return (
    (tokens.text * price.text.input +
      tokens.audio * price.audio.input +
      tokens.textOutput * price.text.output +
      tokens.audioOutput * price.audio.output) /
    PER_MILLION
  );
}
