import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createDaemon } from "../../src/cli/daemon.mjs";
import { ALREADY_RUNNING_EXIT_CODE, startControlServer, TimeoutError } from "../../src/control.mjs";
import { createTranslator } from "../../src/i18n/index.mjs";
import { ensureHome, resolvePaths } from "../../src/storage/paths.mjs";
import { assertOwnerOnlyDir } from "../helpers/owner-only.mjs";

const en = createTranslator("en", "darwin");
/** The user-facing sentence in the error, as translated */
const said = (pattern) => (error) => pattern.test(en.text(error.problem ?? error.message));

const quietLog = { info() {}, warn() {}, error() {} };
const RUNNING = { pid: 4321, starting: false, permissions: { microphone: "granted" }, key: { state: "ready" } };

let dir;
let paths;
let app;
let spawned;
let progress;
let processes;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-"));
  paths = resolvePaths({ WHISPRFLOW_HOME: dir });
  // The background app creates it itself at startup; this fake app doesn't
  ensureHome(paths);
  app = null;
  spawned = [];
  progress = [];
  processes = fakeProcesses();
});
afterEach(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A fake background app: a real control channel, with the state the test gives */
async function startFakeApp(statusOf, extraHandlers = {}) {
  app = await startControlServer({
    socketPath: paths.controlSocket,
    log: quietLog,
    handlers: { status: () => statusOf(), ...extraHandlers },
  });
}

/** A fake "start a process": records how it started, then makes the app appear or exit as the test arranges */
function fakeSpawn(behave) {
  return (command, args, options) => {
    const child = Object.assign(new EventEmitter(), { pid: 4321, unref() {} });
    spawned.push({ command, args, options });
    behave(child, options);
    return child;
  };
}

/**
 * A fake process table: process ids in alive count as running; signals sent are recorded in signals, and onSignal decides how the process reacts.
 * Signal 0, like the real one, only asks "still there?".
 */
function fakeProcesses() {
  const table = {
    alive: new Set(),
    signals: [],
    onSignal: () => {},
    kill(pid, signal) {
      if (!table.alive.has(pid)) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      if (signal === 0) return;
      table.signals.push([pid, signal]);
      table.onSignal(pid, signal);
    },
  };
  return table;
}

function daemonWith(overrides = {}) {
  return createDaemon({
    paths,
    packageDir: "/pkg",
    env: { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" },
    resolveElectron: () => "/pkg/node_modules/electron/dist/Electron",
    ensureHelper: () => false,
    kill: processes.kill,
    commandOf: () => "/pkg/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /pkg",
    pollMs: 10,
    ...overrides,
  });
}

test("status is null when not running", async () => {
  assert.equal(await daemonWith().status(), null);
});

test("every command carries the CLI's language, and the background translates its replies into it", async () => {
  const seen = [];
  await startFakeApp(() => RUNNING, {
    status: (params) => {
      seen.push(["status", params]);
      return RUNNING;
    },
    "set-key": (params) => {
      seen.push(["set-key", params]);
      return { ok: true };
    },
  });
  const daemon = daemonWith({ locale: "en" });
  await daemon.status({ recheck: true });
  await daemon.request("set-key", { key: "k", provider: "gemini" });
  assert.deepEqual(seen, [
    ["status", { recheck: true, locale: "en" }],
    ["set-key", { key: "k", provider: "gemini", locale: "en" }],
  ]);
});

test("start runs this package with Electron, detached from the terminal, output to the log file, and is started once it answers", async () => {
  const spawn = fakeSpawn((_child, options) => {
    // The app's own output should land in the log file
    writeFileSync(options.stdio[1], '{"event":"started"}\n');
    setTimeout(() => startFakeApp(() => RUNNING), 30);
  });
  const status = await daemonWith({ spawn }).start({ onProgress: (message) => progress.push(zh.text(message)) });

  assert.equal(status.pid, 4321);
  assert.equal(spawned.length, 1);
  const [{ command, args, options }] = spawned;
  assert.equal(command, "/pkg/node_modules/electron/dist/Electron");
  assert.deepEqual(args, ["/pkg"]);
  assert.equal(options.detached, true);
  assert.equal(options.stdio[0], "ignore");
  assert.equal(options.env.WHISPRFLOW_CLI, "1");
  assert.equal(options.env.PATH, "/usr/bin");
  // With this variable Electron treats itself as plain Node, with no windows or hotkeys
  assert.equal("ELECTRON_RUN_AS_NODE" in options.env, false);
  assert.match(readFileSync(paths.logFile, "utf8"), /"started"/);
});

test("start creates the home directory with owner-only access (it will hold recordings and keys)", async () => {
  rmSync(dir, { recursive: true });
  const spawn = fakeSpawn(() => startFakeApp(() => RUNNING));
  await daemonWith({ spawn }).start({ onProgress() {} });
  assertOwnerOnlyDir(paths.home);
});

test("before starting it makes sure the helper is built, and says so if it built it", async () => {
  const order = [];
  const spawn = fakeSpawn(() => {
    order.push("spawn");
    startFakeApp(() => RUNNING);
  });
  const ensureHelper = (packageDir, { onBuild }) => {
    order.push(`helper:${packageDir}`);
    onBuild();
    return true;
  };
  await daemonWith({ spawn, ensureHelper }).start({ onProgress: (message) => progress.push(en.text(message)) });
  assert.deepEqual(order, ["helper:/pkg", "spawn"]);
  assert.ok(progress.some((text) => /helper/.test(text)));
});

test("while the app waits for microphone permission it says what it is waiting for, and returns once ready", async () => {
  let status = { ...RUNNING, starting: true, permissions: { microphone: "not-determined" } };
  const spawn = fakeSpawn(() => {
    startFakeApp(() => status);
    setTimeout(() => {
      status = RUNNING;
    }, 60);
  });
  const result = await daemonWith({ spawn }).start({ onProgress: (message) => progress.push(en.text(message)) });
  assert.equal(result.starting, false);
  assert.equal(progress.filter((text) => /microphone/.test(text)).length, 1);
});

test("an app that never gets ready is not waited on forever; the state at that point is returned", async () => {
  const spawn = fakeSpawn(() => startFakeApp(() => ({ ...RUNNING, starting: true })));
  const result = await daemonWith({ spawn, readyTimeoutMs: 80 }).start({ onProgress() {} });
  assert.equal(result.starting, true);
});

test("an app exiting right after start is an error with the last lines of the log", async () => {
  const spawn = fakeSpawn((child, options) => {
    writeFileSync(options.stdio[1], "first line\nsettings file is wrong: hotkey\n");
    setTimeout(() => child.emit("exit", 2, null), 20);
  });
  await assert.rejects(
    daemonWith({ spawn }).start({ onProgress() {} }),
    (error) =>
      /failed to start/.test(en.text(error.problem)) && /settings file is wrong: hotkey/.test(en.text(error.problem)),
  );
});

test("an app that never answers is given up on in time, with where to find the log", async () => {
  const spawn = fakeSpawn(() => {});
  await assert.rejects(
    daemonWith({ spawn, connectTimeoutMs: 60 }).start({ onProgress() {} }),
    said(/logs[\\/]main\.log/),
  );
});

test("two started at once: the later one finds the first and exits, which is not a failure, and the earlier one is waited on", async () => {
  const spawn = fakeSpawn((child) => {
    setTimeout(() => child.emit("exit", ALREADY_RUNNING_EXIT_CODE, null), 10);
    setTimeout(() => startFakeApp(() => RUNNING), 50);
  });
  const status = await daemonWith({ spawn }).start({ onProgress() {} });
  assert.equal(status.pid, 4321);
});

test("stop asks it to quit and counts it stopped only once the process is really gone", async () => {
  processes.alive.add(4321);
  await startFakeApp(() => RUNNING, {
    quit: () => {
      // The control channel closes first and the process exits a little later: a new one can't start meanwhile
      setTimeout(() => app.close(), 20);
      setTimeout(() => processes.alive.delete(4321), 90);
    },
  });
  assert.equal(await daemonWith().stop(), "quit");
  assert.equal(processes.alive.has(4321), false);
  assert.deepEqual(processes.signals, []);
});

test("stop does nothing when it wasn't running", async () => {
  assert.equal(await daemonWith().stop(), "not-running");
});

test("told to quit but never quitting: it is asked to end, then forced", async () => {
  processes.alive.add(4321);
  await startFakeApp(() => RUNNING, { quit: () => {} });
  processes.onSignal = (pid, signal) => {
    if (signal === "SIGKILL") processes.alive.delete(pid);
  };
  assert.equal(await daemonWith({ quitTimeoutMs: 40 }).stop(), "killed");
  assert.deepEqual(processes.signals, [
    [4321, "SIGTERM"],
    [4321, "SIGKILL"],
  ]);
});

/** A hung background app: reachable, but answers nothing */
const startHungApp = () => startFakeApp(() => new Promise(() => {}));

test("a hung app can still be stopped by the process id recorded at start; command-started and packaged ones are both recognized", async () => {
  for (const command of [
    "/pkg/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /pkg",
    "/Applications/WhisprFlow.app/Contents/MacOS/WhisprFlow",
    // Windows: the installed copy and one run from source are both electron.exe
    "C:\\Users\\someone\\.whisprflow\\runtime\\electron.exe",
    "C:\\dev\\whisprflow\\node_modules\\electron\\dist\\electron.exe",
  ]) {
    processes = fakeProcesses();
    processes.alive.add(4321);
    processes.onSignal = (pid) => processes.alive.delete(pid);
    writeFileSync(paths.pidFile, "4321\n");
    await startHungApp();
    assert.equal(await daemonWith({ statusTimeoutMs: 60, commandOf: () => command }).stop(), "killed");
    assert.deepEqual(processes.signals, [[4321, "SIGTERM"]]);
    await app.close();
  }
});

test("hung with a process id that doesn't match (not recorded, or now another program): no killing someone else's process; it says what to do", async () => {
  processes.alive.add(4321);
  await startHungApp();
  const stuck = (overrides) => daemonWith({ statusTimeoutMs: 60, ...overrides }).stop();

  await assert.rejects(stuck(), said(/Activity Monitor/));
  writeFileSync(paths.pidFile, "4321\n");
  await assert.rejects(stuck({ commandOf: () => "/usr/bin/vim notes.txt" }), said(/Activity Monitor/));
  // Helper processes of other Electron apps carry Electron in their path too
  const otherApp =
    "/Applications/Other.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler";
  await assert.rejects(stuck({ commandOf: () => otherApp }), said(/Activity Monitor/));
  // Other Electron apps on Windows (not named electron.exe) aren't recognized either
  await assert.rejects(stuck({ commandOf: () => "C:\\Program Files\\Slack\\slack.exe" }), said(/Activity Monitor/));
  await assert.rejects(stuck({ commandOf: () => null }), said(/Activity Monitor/));
  writeFileSync(paths.pidFile, "not a number");
  await assert.rejects(stuck(), said(/Activity Monitor/));
  assert.deepEqual(processes.signals, []);
});

test("checking status while hung reports 'not answering', not 'not running'", async () => {
  await startHungApp();
  await assert.rejects(daemonWith({ statusTimeoutMs: 60 }).status(), TimeoutError);
});
