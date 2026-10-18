import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTranslator } from "../../src/i18n/index.mjs";
import { ensureHome, installedHomeOf, keyFile, resolvePaths } from "../../src/storage/paths.mjs";
import { assertOwnerOnlyDir } from "../helpers/owner-only.mjs";

const en = createTranslator("en");
/** The user-facing sentence in the error, as translated */
const said = (pattern) => (error) => pattern.test(en.text(error.problem ?? error.message));

test("everything lives in one directory, .whisprflow in the home directory", () => {
  const paths = resolvePaths({}, "/Users/someone", "darwin");
  assert.equal(paths.home, "/Users/someone/.whisprflow");
  for (const [name, path] of Object.entries(paths)) {
    assert.ok(path === paths.home || path.startsWith("/Users/someone/.whisprflow/"), `${name}: ${path}`);
  }
});

test("the program, your things, and runtime files each have their place", () => {
  const paths = resolvePaths({}, "/Users/someone", "darwin");
  const inHome = Object.fromEntries(
    Object.entries(paths).map(([name, path]) => [name, path.slice(paths.home.length + 1)]),
  );
  assert.deepEqual(inHome, {
    home: "",
    // The program itself: put in at install, replaced whole on update
    binDir: "bin",
    linksFile: "bin/links",
    appDir: "app",
    runtimeDir: "runtime",
    // Your things
    settingsFile: "settings.json",
    historyDb: "data/history.db",
    recordingsDir: "data/Recordings",
    // On-device models, downloaded when needed
    modelsDir: "models",
    // Produced while running, recreated if deleted
    logFile: "logs/main.log",
    runDir: "run",
    controlSocket: "run/control.sock",
    pidFile: "run/daemon.pid",
    updateCheckFile: "run/update-check.json",
    cacheDir: "cache",
  });
});

test("one key per model vendor, in a file the app and the CLI share", () => {
  const paths = resolvePaths({}, "/Users/someone", "darwin");
  assert.equal(keyFile(paths, "gemini"), "/Users/someone/.whisprflow/gemini-key.bin");
  assert.equal(keyFile(paths, "openai"), "/Users/someone/.whisprflow/openai-key.bin");
  // The custom cleanup service gets one too
  assert.equal(keyFile(paths, "custom"), "/Users/someone/.whisprflow/custom-key.bin");
  assert.throws(() => keyFile(paths, "../x"), /id/);
});

test("WHISPRFLOW_HOME moves the whole directory elsewhere", () => {
  const paths = resolvePaths({ WHISPRFLOW_HOME: "/tmp/elsewhere" }, "/Users/someone", "darwin");
  for (const path of Object.values(paths)) assert.ok(path.startsWith("/tmp/elsewhere"), path);
});

test("an empty WHISPRFLOW_HOME counts as unset and never writes into the current directory", () => {
  assert.equal(resolvePaths({ WHISPRFLOW_HOME: "" }, "/Users/someone", "darwin").home, "/Users/someone/.whisprflow");
});

test("a control channel path that is too long is an error saying what to do, before listening fails", () => {
  const long = `/tmp/${"x".repeat(100)}`;
  assert.throws(() => resolvePaths({ WHISPRFLOW_HOME: long }, "/Users/someone", "darwin"), said(/WHISPRFLOW_HOME/));
});

test("WHISPRFLOW_HOME must be absolute: a relative path changes with the directory a command runs in, missing the running background app", () => {
  for (const relative of ["data", "./data", "../data"]) {
    assert.throws(() => resolvePaths({ WHISPRFLOW_HOME: relative }, "/Users/someone", "darwin"), said(/absolute path/));
    assert.throws(
      () => resolvePaths({ WHISPRFLOW_HOME: relative }, "C:\\Users\\someone", "win32"),
      said(/absolute path/),
    );
  }
});

test("ensureHome creates the directory with owner-only access (it holds recordings and keys)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = resolvePaths({ WHISPRFLOW_HOME: join(dir, "home") });
  ensureHome(paths);
  assertOwnerOnlyDir(paths.home);
  assert.ok(statSync(join(paths.home, "run")).isDirectory());
  // A second run is fine and gives the same result
  ensureHome(paths);
  assertOwnerOnlyDir(paths.home);
});

test("Windows also uses .whisprflow in the user directory; the control channel is a named pipe named after the home, not on disk", () => {
  const paths = resolvePaths({}, "C:\\Users\\someone", "win32");
  assert.equal(paths.home, "C:\\Users\\someone\\.whisprflow");
  for (const [name, path] of Object.entries(paths)) {
    if (name === "controlSocket") continue;
    assert.ok(path === paths.home || path.startsWith("C:\\Users\\someone\\.whisprflow\\"), `${name}: ${path}`);
  }
  assert.equal(paths.historyDb, "C:\\Users\\someone\\.whisprflow\\data\\history.db");
  assert.match(paths.controlSocket, /^\\\\\.\\pipe\\whisprflow-[0-9a-f]{16}$/);
  // The same home (in any case) gives the same pipe; another home gives another
  assert.equal(resolvePaths({}, "c:\\users\\SOMEONE", "win32").controlSocket, paths.controlSocket);
  assert.notEqual(
    resolvePaths({ WHISPRFLOW_HOME: "D:\\whisprflow" }, "C:\\Users\\someone", "win32").controlSocket,
    paths.controlSocket,
  );
  // The socket path limit is a macOS matter; a pipe name doesn't depend on the home's length
  assert.doesNotThrow(() => resolvePaths({ WHISPRFLOW_HOME: `D:\\${"x".repeat(100)}` }, "C:\\Users\\someone", "win32"));
});

test("an installed copy on Windows: the home is found from the program location (<home>\\runtime\\electron.exe with app beside it); other layouts are null", () => {
  const exists = (path) => path === "D:\\WhisprFlow\\app\\package.json";
  assert.equal(installedHomeOf("D:\\WhisprFlow\\runtime\\electron.exe", exists), "D:\\WhisprFlow");
  assert.equal(installedHomeOf("D:\\WhisprFlow\\runtime\\Electron.EXE", exists), "D:\\WhisprFlow");
  // Running from source: electron.exe inside node_modules
  assert.equal(installedHomeOf("C:\\dev\\whisprflow\\node_modules\\electron\\dist\\electron.exe", exists), null);
  // No app beside it
  assert.equal(installedHomeOf("E:\\other\\runtime\\electron.exe", exists), null);
  assert.equal(
    installedHomeOf("/Users/someone/.whisprflow/runtime/Electron.app/Contents/MacOS/Electron", exists),
    null,
  );
});
