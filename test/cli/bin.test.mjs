import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { openHistory } from "../../src/storage/history.mjs";
import { resolvePaths } from "../../src/storage/paths.mjs";

const BIN = resolve(import.meta.dirname, "..", "..", "bin", "whisprflow.mjs");

// When the reading end of a pipe closes, Windows doesn't report the EPIPE family, and it has no head or bash: checked on macOS only
const posixPipes = { skip: process.platform === "win32" && "Windows has no bash or head" };

test(
  "output piped into something like head, which closes after reading the start: it ends quietly, without a screen of errors",
  posixPipes,
  (t) => {
    const dir = mkdtempSync(join(tmpdir(), "wf-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    // Enough history that one write can't finish: still writing when the other end closes
    const history = openHistory(resolvePaths({ WHISPRFLOW_HOME: dir }).historyDb);
    for (let index = 0; index < 400; index++) {
      history.add({
        id: `id-${index}`,
        status: "completed",
        refinedText: "A sentence that is not short. ".repeat(60),
        error: null,
        duration: 3,
        audioLocalPath: null,
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
      });
    }
    history.close();

    const result = spawnSync(
      "/bin/bash",
      ["-c", 'set -o pipefail; "$0" "$1" history -n 400 --json | head -c 10 >/dev/null', process.execPath, BIN],
      { encoding: "utf8", env: { ...process.env, WHISPRFLOW_HOME: dir } },
    );
    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
  },
);

test("the CLI speaks English whatever the terminal language, the settings, or a corrupt settings file", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { LC_ALL: _all, LC_MESSAGES: _messages, LANG: _lang, ...base } = process.env;
  const helpIn = (env) =>
    spawnSync(process.execPath, [BIN, "help"], {
      encoding: "utf8",
      env: { ...base, WHISPRFLOW_HOME: dir, ...env },
    }).stdout.split("\n")[0];

  for (const LANG of ["en_US.UTF-8", "zh_CN.UTF-8", "ja_JP.UTF-8", "C"]) {
    assert.match(helpIn({ LANG }), /^WhisprFlow: press a hotkey/, LANG);
  }
  if (process.platform !== "win32") assert.match(helpIn({}), /^WhisprFlow: press/);

  writeFileSync(resolvePaths({ WHISPRFLOW_HOME: dir }).settingsFile, JSON.stringify({ language: "en" }));
  assert.match(helpIn({ LANG: "fr_FR.UTF-8", WHISPRFLOW_LANGUAGE: "system" }), /^WhisprFlow: press/);
  // A corrupt settings file: help still works; the commands that read settings report what is wrong
  writeFileSync(resolvePaths({ WHISPRFLOW_HOME: dir }).settingsFile, "{ broken");
  assert.match(helpIn({ LANG: "en_US.UTF-8" }), /^WhisprFlow: press/);
});

test("a too-old Node says which version is needed, even when it is too old to load the messages layer, without a stack trace", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  /** Pretends to be a Node version; ancient also removes features Node 16.9 lacked */
  const runAs = (version, { ancient = false } = {}) => {
    const preload = join(dir, `${version}.mjs`);
    writeFileSync(
      preload,
      `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });\n` +
        (ancient ? "delete String.prototype.replaceAll;\ndelete Object.hasOwn;\n" : ""),
    );
    const { LC_ALL: _all, LC_MESSAGES: _messages, ...base } = process.env;
    // --import takes a URL: Windows drive paths become file:// first
    return spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, BIN, "help"], {
      encoding: "utf8",
      env: { ...base, WHISPRFLOW_HOME: dir, LANG: "en_US.UTF-8" },
    });
  };

  const old = runAs("20.18.1");
  assert.equal(old.status, 1);
  assert.equal(old.stderr, "WhisprFlow needs Node 22.13 or newer (23.4 or newer on the 23 line); this is 20.18.1.\n");

  const ancient = runAs("14.21.3", { ancient: true });
  assert.equal(ancient.status, 1);
  assert.equal(
    ancient.stderr,
    "WhisprFlow needs Node 22.13 or newer (23.4 or newer on the 23 line); this is 14.21.3.\n",
  );
});
