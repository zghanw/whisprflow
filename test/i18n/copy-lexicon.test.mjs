import assert from "node:assert/strict";
import { test } from "node:test";
import { findLocale } from "../../src/i18n/index.mjs";

// House rules for the English copy: plain punctuation only. Em and en dashes, curly quotes, and emoji
// read as machine-written, so the copy uses colons, commas, and straight quotes instead.
// Allowed symbols: the macOS key glyphs, the middle dot separator, the ellipsis, the menu path separator,
// the multiplication sign, check and cross marks, and arrows for routes and version changes (notation, not prose).

const BANNED = [
  [/[\u2014\u2013]/, "em or en dash: use a colon, comma, or hyphen"],
  [/[\u2018\u2019\u201c\u201d]/, "curly quote: use a straight quote"],
  [/\p{Extended_Pictographic}/u, "emoji"],
];
const ALLOWED_SYMBOLS = new Set([..."⌘⌥⇧⌃·…›×✓✗→"]);

function strings(node, prefix = "") {
  return Object.entries(node).flatMap(([name, value]) => {
    const key = `${prefix}${name}`;
    if (typeof value === "string") return [[key, value]];
    if (value && typeof value === "object") return strings(value, `${key}.`);
    return [];
  });
}

const copy = strings(findLocale("en").messages);

test("the English copy has no dashes, curly quotes, or emoji", () => {
  const offenders = [];
  for (const [key, text] of copy) {
    for (const [pattern, why] of BANNED) if (pattern.test(text)) offenders.push(`${key}: ${why}`);
  }
  assert.deepEqual(offenders, []);
});

test("non-ASCII characters in the copy are only the allowed symbols", () => {
  const strays = copy.flatMap(([key, text]) =>
    [...text].filter((char) => char > "\x7f" && !ALLOWED_SYMBOLS.has(char)).map((char) => `${key}: ${char}`),
  );
  assert.deepEqual(strays, []);
});

test("the rules catch what they should", () => {
  assert.ok(BANNED.some(([pattern]) => pattern.test("Ready \u2014 press the key")));
  assert.ok(BANNED.some(([pattern]) => pattern.test("click \u201cAllow\u201d")));
  assert.ok(!BANNED.some(([pattern]) => pattern.test("Press ⌘V to paste · esc to cancel")));
});
