import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lastLines, tailFile } from "../../src/cli/tail.mjs";

test("the last lines: a trailing newline isn't a line; fewer lines than asked means all of them", () => {
  assert.equal(lastLines("a\nb\nc\n", 2), "b\nc");
  assert.equal(lastLines("a\nb", 5), "a\nb");
  assert.equal(lastLines("", 3), "");
});

test("without following, it prints the last lines and returns", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-tail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "main.log");
  writeFileSync(file, "one\ntwo\nthree\n");
  const written = [];
  assert.equal(await tailFile(file, { lines: 2, follow: false, write: (text) => written.push(text) }), 0);
  assert.deepEqual(written, ["two\nthree\n"]);
});

test("-f keeps printing what is written next; when the log is rotated (shrinks) it reads the new one from the start", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-tail-"));
  const file = join(dir, "main.log");
  writeFileSync(file, "old\n");
  const written = [];
  const done = tailFile(file, { lines: 1, follow: true, write: (text) => written.push(text), intervalMs: 20 });
  t.after(() => {
    process.emit("SIGINT");
    rmSync(dir, { recursive: true, force: true });
  });
  const until = async (check) => {
    for (let waited = 0; !check() && waited < 3000; waited += 20) await new Promise((r) => setTimeout(r, 20));
  };
  appendFileSync(file, "a newly written line\n");
  await until(() => written.includes("a newly written line\n"));
  assert.ok(written.includes("a newly written line\n"), JSON.stringify(written));
  writeFileSync(file, "after rotation\n");
  await until(() => written.includes("after rotation\n"));
  assert.ok(written.includes("after rotation\n"), JSON.stringify(written));
  process.emit("SIGINT");
  assert.equal(await done, 0);
});
