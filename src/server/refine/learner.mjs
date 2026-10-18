import { MAX_LEARNED_TERMS } from "../../storage/dictionary.mjs";

// Learning for the user's dictionary (storage/dictionary.mjs): after a cleanup, the same on-device model is asked which names and jargon the text holds.
// Only terms that really occur in the text and look like a name or an acronym are kept, a few per dictation, so the next dictation spells them right.
// Best effort: it runs after the text is delivered and never holds up or breaks a dictation.

/** Fewer words than this carry too little to learn from */
const MIN_WORDS = 4;
/** At most this many new terms per dictation */
const MAX_PER_DICTATION = 5;
const LEARN_TIMEOUT_MS = 30_000;

/** @param {string[]} known terms already in the dictionary, which the model should leave out */
export const learnPrompt = (known) =>
  `From the text the user sends, list proper nouns, acronyms, brand or product names, and technical jargon that a speech-to-text system might misspell, one per line, nothing else. If there are none, output nothing. Exclude everyday words and these already-known terms: ${known.length > 0 ? known.join(", ") : "(none)"}`;

/**
 * The model's lines as candidate terms: list marks stripped, kept only if they occur in the text and carry a capital letter.
 * A digit alone isn't enough: times and amounts ("3pm", "10km") come back as candidates, while names with digits ("Qwen3", "GPT-4o") have a capital
 */
export function termsFrom(output, text) {
  const lower = text.toLowerCase();
  return String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s\-*\u2022]+|[\s\-*\u2022]+$/g, ""))
    .filter(
      (term) => term.length > 1 && term.length <= 40 && lower.includes(term.toLowerCase()) && /\p{Lu}/u.test(term),
    );
}

/**
 * @param {object} options
 * @param {{ complete(request: object): Promise<{ text: string | null, problem: object | null }> }} options.client the cleanup model's client
 * @param {{ terms(): string[], learn(terms: string[]): string[] }} options.dictionary
 * @param {{ info: Function, warn: Function }} options.log
 * @returns {(text: string) => Promise<string[]>} learns from a finished text; resolves to the terms added, never rejects
 */
export function createLearner({ client, dictionary, log }) {
  return async (text) => {
    try {
      if (text.split(/\s+/).filter(Boolean).length < MIN_WORDS) return [];
      const known = dictionary.terms();
      if (known.length >= MAX_LEARNED_TERMS) return [];
      const reply = await client.complete({
        system: learnPrompt(known),
        user: `Text: ${text}`,
        signal: AbortSignal.timeout(LEARN_TIMEOUT_MS),
      });
      if (reply.problem) return [];
      const lower = new Set(known.map((term) => term.toLowerCase()));
      const fresh = termsFrom(reply.text, text).filter((term) => !lower.has(term.toLowerCase()));
      const added = dictionary.learn(fresh.slice(0, MAX_PER_DICTATION));
      // Only the count: the terms come from what the user said
      if (added.length > 0) log.info("dictionary_learned", { count: added.length });
      return added;
    } catch (error) {
      log.warn("dictionary_learn_failed", { error: String(error?.message ?? error).slice(0, 300) });
      return [];
    }
  };
}
