#!/usr/bin/env node
// Entry point of the whisprflow command. It only does what must happen before the rest of the code loads; the commands live in src/cli/main.mjs.
import { nodeVersionProblem } from "../src/cli/node-version.mjs";

// Check the Node version first: the rest of the code (the messages layer included) may use syntax older versions lack
const versionProblem = nodeVersionProblem(process.versions.node);
if (versionProblem) {
  console.error(await inTerminalLanguage(versionProblem));
  process.exit(1);
}

// This is said before settings are read, in the terminal's language. Hotkeys and pasting rely on each system's native helper, which exist for macOS and Windows
const { createTranslator, terminalLocales, matchLocale } = await import("../src/i18n/index.mjs");
if (process.platform !== "darwin" && process.platform !== "win32") {
  console.error(createTranslator(matchLocale(terminalLocales(process.env)))("cli.macOnly"));
  process.exit(1);
}

// The history database uses Node's built-in SQLite, still marked "experimental" in Node 22 and 24, which would print a warning
// on every command. Only that warning is filtered; others still show
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning?.message ?? warning).includes("SQLite")) return;
  emitWarning.call(process, warning, ...rest);
};

// When output goes to something like head, it closes the pipe once it has read enough, and further writes raise EPIPE. That is a normal end, not an error
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
}

const { main } = await import("../src/cli/main.mjs");
process.exitCode = await main(process.argv.slice(2));

/**
 * The message for a too-old Node, in the terminal's language. The messages layer uses newer Node features (replaceAll, Object.hasOwn),
 * so on a very old Node it can't load or translate: then it is said in English, still this sentence rather than that layer's stack trace
 */
async function inTerminalLanguage(problem) {
  try {
    const { createTranslator, terminalLocales, matchLocale } = await import("../src/i18n/index.mjs");
    return createTranslator(matchLocale(terminalLocales(process.env))).text(problem);
  } catch {
    return problem.english;
  }
}
