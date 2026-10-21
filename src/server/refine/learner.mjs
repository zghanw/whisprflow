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

/** Where a sentence or a list item starts: everyday words are capitalized there too, so a capital proves nothing */
const SENTENCE_START = /(?:^|[.!?:]\s+|\n[\s\-*\u2022]*)$/;

/**
 * Whether a term reads as a name in the text, which cleanup has already capitalized. It must appear there exactly as written, and either carry
 * a capital or a digit past its first letter (API, PostgreSQL, Qwen3, iPhone), or appear at least once mid-sentence, where a capital means a name (Heroku).
 * Words capitalized only because they start a sentence or a list item ("Tickets") don't count, nor do times and amounts ("3pm")
 */
function readsAsName(term, text) {
  if (!/\p{Lu}/u.test(term) || !text.includes(term)) return false;
  if (/[\p{Lu}\p{N}]/u.test(term.slice(1))) return true;
  for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + 1)) {
    if (!SENTENCE_START.test(text.slice(0, at))) return true;
  }
  return false;
}

/** The model's lines as candidate terms: list marks stripped, kept only if they read as a name in the text */
export function termsFrom(output, text) {
  return String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s\-*\u2022]+|[\s\-*\u2022]+$/g, ""))
    .filter((term) => term.length > 1 && term.length <= 40 && readsAsName(term, text));
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
