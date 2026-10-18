import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { MAX_LEARNED_TERMS, normalizeTerms, openDictionary } from "../../src/storage/dictionary.mjs";

let dir;
let file;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-dictionary-"));
  file = join(dir, "dictionary.txt");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("terms are trimmed, blank lines dropped, and each kept once regardless of case (the first spelling wins)", () => {
  assert.deepEqual(normalizeTerms([" Kubernetes ", "", "kubernetes", "WhisprFlow", "  "]), [
    "Kubernetes",
    "WhisprFlow",
  ]);
});

test("no file yet means an empty dictionary; a hand-edited file (CRLF, duplicates) is read cleanly", () => {
  const dictionary = openDictionary(file);
  assert.deepEqual(dictionary.terms(), []);
  writeFileSync(file, "PostgreSQL\r\npostgresql\r\n\r\nOllama\r\n");
  assert.deepEqual(dictionary.terms(), ["PostgreSQL", "Ollama"]);
});

test("replacing writes one term per line and returns what was saved", () => {
  const dictionary = openDictionary(file);
  assert.deepEqual(dictionary.replace(["Ollama", "ollama", " Qwen3 "]), ["Ollama", "Qwen3"]);
  assert.equal(readFileSync(file, "utf8"), "Ollama\nQwen3\n");
  assert.deepEqual(dictionary.replace([]), []);
  assert.equal(readFileSync(file, "utf8"), "");
});

test("learning adds only new terms and stops at the cap; terms entered by hand are never capped", () => {
  const dictionary = openDictionary(file);
  dictionary.replace(["Ollama"]);
  assert.deepEqual(dictionary.learn(["ollama", "Kubernetes", "Kubernetes"]), ["Kubernetes"]);
  assert.deepEqual(dictionary.terms(), ["Ollama", "Kubernetes"]);

  const many = Array.from({ length: MAX_LEARNED_TERMS + 10 }, (_, i) => `Term${i}`);
  assert.equal(dictionary.replace(many).length, MAX_LEARNED_TERMS + 10);
  assert.deepEqual(dictionary.learn(["Fresh"]), []);

  dictionary.replace(many.slice(0, MAX_LEARNED_TERMS - 1));
  assert.deepEqual(dictionary.learn(["One", "Two"]), ["One"], "fills up to the cap and no further");
});
