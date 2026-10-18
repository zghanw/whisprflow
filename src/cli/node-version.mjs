// This file must import no other module: it has to run before the rest of the code (node:sqlite among it) loads.

/**
 * Whether this Node version works. The history database uses Node's built-in SQLite, which needs no extra flag only from
 * 22.13 and 23.4 on (on 22.12 it reports "no such built-in module: node:sqlite").
 * @param {string} version process.versions.node
 * @returns {{ key: string, params: object, english: string } | null} when it doesn't, a message not yet in a language
 *   (shaped like msg in src/i18n, which can't be imported here). english is its English text, used when Node is too old for the messages layer to run
 */
export function nodeVersionProblem(version) {
  const [major, minor] = version.split(".").map(Number);
  const ok = major > 23 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13);
  if (ok) return null;
  return {
    key: "cli.nodeVersion",
    params: { version },
    english: `WhisprFlow needs Node 22.13 or newer (23.4 or newer on the 23 line); this is ${version}.`,
  };
}
