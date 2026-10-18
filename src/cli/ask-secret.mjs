// Asks for a key in the terminal: input isn't echoed, so it never stays on screen or lands in the shell history.

/** The user pressed Ctrl-C and gave up */
export class Cancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "Cancelled";
  }
}

async function readAll(input) {
  let text = "";
  input.setEncoding("utf8");
  for await (const chunk of input) text += chunk;
  return text.trim();
}

/**
 * @param {string} prompt the prompt, written to output
 * @param {object} [streams]
 * @param {import("node:stream").Readable & { isTTY?: boolean, setRawMode?: Function }} [streams.input]
 *   in a terminal it reads key by key without echo; otherwise (piped in) it reads until the end
 * @param {import("node:stream").Writable} [streams.output] standard error by default, so standard output can still be redirected
 * @returns {Promise<string>} the input with surrounding whitespace trimmed
 * @throws {Cancelled}
 */
export function askSecret(prompt, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) return readAll(input);

  return new Promise((resolve, reject) => {
    let value = "";
    /** Skipping an escape sequence (arrow keys and the like) until the letter that ends it */
    let escaping = false;

    const finish = (settle, result) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      settle(result);
    };

    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (escaping) {
          if (/[A-Za-z~]/.test(char)) escaping = false;
        } else if (char === "\r" || char === "\n") {
          finish(resolve, value.trim());
          return;
        } else if (char === "\u0003") {
          finish(reject, new Cancelled());
          return;
        } else if (char === "\u001b") {
          escaping = true;
        } else if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
        } else if (char >= " ") {
          value += char;
        }
      }
    };

    // Turn echo off before showing the prompt: fast typists (or fast pastes) start typing as soon as the prompt appears
    input.setRawMode(true);
    output.write(prompt);
    input.resume();
    input.on("data", onData);
  });
}
