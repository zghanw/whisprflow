import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { askSecret, Cancelled } from "../../src/cli/ask-secret.mjs";

function fakeTerminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.rawModes = [];
  input.setRawMode = (on) => input.rawModes.push(on);
  const output = new PassThrough();
  let shown = "";
  output.on("data", (chunk) => {
    shown += chunk;
  });
  return { input, output, shown: () => shown };
}

test("in a terminal, input isn't echoed, Enter ends it, and surrounding whitespace is trimmed", async () => {
  const { input, output, shown } = fakeTerminal();
  const answer = askSecret("Paste the key: ", { input, output });
  input.write("  AIza-secret_123 ");
  input.write("\r");
  assert.equal(await answer, "AIza-secret_123");
  assert.ok(shown().startsWith("Paste the key: "));
  assert.ok(!shown().includes("secret"));
  // Afterwards the terminal is restored
  assert.deepEqual(input.rawModes, [true, false]);
});

test("backspace edits, and keys like the arrows never get mixed in", async () => {
  const { input, output } = fakeTerminal();
  const answer = askSecret("", { input, output });
  input.write("abcX\x7f");
  input.write("\x1b[D\x1b[C");
  input.write("d\n");
  assert.equal(await answer, "abcd");
});

test("Ctrl-C cancels, and the terminal is restored too", async () => {
  const { input, output } = fakeTerminal();
  const answer = askSecret("", { input, output });
  input.write("abc\x03");
  await assert.rejects(answer, Cancelled);
  assert.deepEqual(input.rawModes, [true, false]);
});

test("outside a terminal (piped in) it reads until the end", async () => {
  const input = new PassThrough();
  const answer = askSecret("Paste the key: ", { input, output: new PassThrough() });
  input.end("AIza-from-pipe\n");
  assert.equal(await answer, "AIza-from-pipe");
});
