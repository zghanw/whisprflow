import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

// The type hierarchy rests entirely on the sizes and weights in shared/tokens.css. If any style writes a 14px or a 590 in passing,
// names, descriptions, and tags start looking the same size again, so a test guards it: sizes and weights may only use tokens.

const RENDERER = join(import.meta.dirname, "../../../src/renderer");
const TOKENS = join(RENDERER, "shared/tokens.css");

function cssFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

/** Hard-coded sizes and weights in a stylesheet: file:line and that line */
function hardcoded(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line, index) => ({ line: line.trim(), at: `${relative(RENDERER, path)}:${index + 1}` }))
    .filter(({ line }) => /^font-(size|weight):\s*[\d.]/.test(line) || /^font:\s*[\d.]/.test(line))
    .map(({ line, at }) => `${at}  ${line}`);
}

test("sizes and weights in styles all use the steps in tokens.css, never numbers", () => {
  const files = cssFiles(RENDERER).filter((path) => path !== TOKENS);
  assert.ok(files.length >= 5, "no stylesheets found; the path may have changed");
  assert.deepEqual(files.flatMap(hardcoded), []);
});

test("the token sizes come in seven steps and the weights in four", () => {
  const tokens = readFileSync(TOKENS, "utf8");
  assert.equal(tokens.match(/^\s*--text-[a-z]+:/gm)?.length, 7);
  assert.equal(tokens.match(/^\s*--weight-[a-z]+:/gm)?.length, 4);
});
