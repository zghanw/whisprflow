import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// The user's dictionary: names and jargon spelled the way the user wants. A plain text file, one term per line, so it can be edited by hand.
// Cleanup prompts list it as preferred spellings (server/refine/prompt.mjs), and after each local cleanup new terms are learned into it
// (server/refine/learner.mjs). Settings has an editor for it.

/** Learning stops adding once the dictionary holds this many terms: past it, prune the list by hand. Terms entered by hand are never capped */
export const MAX_LEARNED_TERMS = 300;

/** Trimmed, blank lines dropped, each term once (case doesn't matter; the first spelling wins) */
export function normalizeTerms(terms) {
  const seen = new Set();
  const kept = [];
  for (const raw of terms) {
    const term = String(raw).trim();
    if (term === "" || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    kept.push(term);
  }
  return kept;
}

/**
 * @param {string} file where the dictionary lives (dictionaryFile in storage/paths.mjs)
 * @returns {{ terms(): string[], replace(terms: string[]): string[], learn(terms: string[]): string[] }}
 */
export function openDictionary(file) {
  const read = () => (existsSync(file) ? normalizeTerms(readFileSync(file, "utf8").split(/\r?\n/)) : []);
  const write = (terms) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, terms.length > 0 ? `${terms.join("\n")}\n` : "");
  };
  return {
    /** The terms now. Read each time: the file may have been edited by hand */
    terms: read,

    /** Replaces the whole list (the Settings editor). @returns the terms as saved */
    replace(terms) {
      const kept = normalizeTerms(terms);
      write(kept);
      return kept;
    },

    /** Adds terms learned from a dictation, skipping known ones and stopping at the cap. @returns the terms actually added */
    learn(terms) {
      const known = read();
      if (known.length >= MAX_LEARNED_TERMS) return [];
      const lower = new Set(known.map((term) => term.toLowerCase()));
      const added = normalizeTerms(terms)
        .filter((term) => !lower.has(term.toLowerCase()))
        .slice(0, MAX_LEARNED_TERMS - known.length);
      if (added.length > 0) write([...known, ...added]);
      return added;
    },
  };
}
