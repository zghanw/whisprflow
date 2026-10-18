import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeVersionProblem } from "../../src/cli/node-version.mjs";
import { createTranslator } from "../../src/i18n/index.mjs";

const zh = createTranslator("zh-CN");
const en = createTranslator("en");

test("only versions whose built-in SQLite needs no flag work: 22.13 on, and 23.4 on for the 23 line", () => {
  for (const ok of ["22.13.0", "22.20.1", "23.4.0", "23.11.0", "24.0.0", "26.0.0"]) {
    assert.equal(nodeVersionProblem(ok), null, ok);
  }
  for (const old of ["18.20.0", "20.18.1", "22.12.0", "23.0.0", "23.3.0"]) {
    const problem = zh.text(nodeVersionProblem(old));
    assert.match(problem, /22\.13/, old);
    assert.ok(problem.includes(old), old);
  }
  assert.equal(
    en.text(nodeVersionProblem("20.18.1")),
    "WhisprFlow needs Node 22.13 or newer (23.4 or newer on the 23 line); this is 20.18.1.",
  );
  // The English used when the messages layer can't run matches en.mjs word for word
  for (const old of ["14.21.3", "22.12.0"])
    assert.equal(nodeVersionProblem(old).english, en.text(nodeVersionProblem(old)));
});
