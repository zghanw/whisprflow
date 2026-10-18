import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ALREADY_RUNNING_EXIT_CODE, NotRunningError, requestControl, TimeoutError } from "../control.mjs";
import { LocalizedError, msg } from "../i18n/index.mjs";
import { rotateIfLarge } from "../log.mjs";
import { ensureHome } from "../storage/paths.mjs";
import { ensureHelper as defaultEnsureHelper } from "./native-helper.mjs";

// Starting and stopping the background app (src/app, running in Electron). It runs detached from the terminal and survives closing the terminal window,
// so the control channel is the only way to know whether it is running and how. Progress messages and error causes aren't in a language yet (msg); the CLI translates them.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Which Electron runs the background app.
 * An installed WhisprFlow ships its own, and this command itself runs on it as Node, so the executable running us now is it.
 * Run from a source checkout (development) it is the system Node, so look in the dependencies: the electron package exports the executable's path,
 * and downloads it at this step if it hasn't been downloaded.
 */
function resolveElectronBinary(packageDir, onProgress) {
  if (process.versions.electron) return process.execPath;
  const require = createRequire(join(packageDir, "package.json"));
  let electronDir;
  try {
    electronDir = dirname(require.resolve("electron/package.json"));
  } catch {
    throw new LocalizedError(msg("cli.daemon.noElectron", { dir: packageDir }));
  }
  if (!existsSync(join(electronDir, "dist"))) onProgress(msg("cli.daemon.downloading"));
  try {
    return require("electron");
  } catch (error) {
    throw new LocalizedError(msg("cli.daemon.downloadFailed", { reason: error.message }), { cause: error });
  }
}

/** The last lines of the log; a sentence (msg) when there is no log yet */
function logTail(file, lines = 8) {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch (error) {
    if (error.code === "ENOENT") return msg("cli.daemon.emptyLog");
    throw error;
  }
}

/**
 * The command this process id is running now; null if there is no such process (or it can't be checked).
 * Windows has no ps: ask PowerShell where its executable is (a few hundred milliseconds each, only needed when it hangs and must be ended by force)
 */
function commandOfProcess(pid) {
  try {
    if (process.platform === "win32") {
      const script = `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).Path`;
      const path = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
      });
      return path.trim() || null;
    }
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim() || null;
  } catch {
    // ps exits with 1 when the process doesn't exist. If it can't be checked, treat it as unknown: better to let the user end it than end a process nobody can identify
    return null;
  }
}

/** Which executable the background app's main process runs (see recordedPid) */
const OUR_EXECUTABLE = /\/MacOS\/(Electron|WhisprFlow)( |$)|\\electron\.exe$/i;

/** What starting is waiting for (the names in the copy). Only the two the user can see and needs to act on or wait for */
function startingHint(status) {
  if (status.permissions?.microphone === "not-determined") return "cli.daemon.micPrompt";
  if (status.key?.state === "checking") return "cli.daemon.verifying";
  return null;
}

/**
 * @param {object} options
 * @param {ReturnType<import("../storage/paths.mjs").resolvePaths>} options.paths
 * @param {string} options.packageDir where this package is: Electron starts with it as the app directory
 * @param {Record<string, string | undefined>} options.env the environment passed to the background app
 * @param {string} [options.locale] the CLI's language. Every command carries it, and the background translates text for people before replying
 *   (older CLIs don't send it, so the background uses its own language: they and status --json readers only read the text)
 */
export function createDaemon({
  paths,
  packageDir,
  env,
  locale,
  spawn = nodeSpawn,
  resolveElectron = (onProgress) => resolveElectronBinary(packageDir, onProgress),
  ensureHelper = defaultEnsureHelper,
  kill = (pid, signal) => process.kill(pid, signal),
  commandOf = commandOfProcess,
  pollMs = 150,
  statusTimeoutMs = 5_000,
  connectTimeoutMs = 30_000,
  // The first start waits for the user to answer the microphone permission prompt, so allow plenty of time
  readyTimeoutMs = 90_000,
  quitTimeoutMs = 5_000,
}) {
  const request = (cmd, params, options) =>
    requestControl(paths.controlSocket, cmd, locale ? { ...params, locale } : params, options);

  /**
   * @returns {Promise<object | null>} null when not running
   * @throws {TimeoutError} running, but hung and not answering
   */
  async function status(params = {}) {
    try {
      return await request("status", params, { timeoutMs: statusTimeoutMs });
    } catch (error) {
      if (error instanceof NotRunningError) return null;
      throw error;
    }
  }

  function isAlive(pid) {
    try {
      kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      // The process exists but isn't ours
      if (error.code === "EPERM") return true;
      throw error;
    }
  }

  /**
   * Waits until this process is really gone. Watching only the control channel isn't enough: it closes the channel first and exits fully a little later,
   * and meanwhile still holds the single-instance lock, so a new one started right away would be turned back.
   * @returns {Promise<boolean>} whether it was gone within the time limit
   */
  async function exited(pid, timeoutMs) {
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(pollMs)) {
      if (!isAlive(pid)) return true;
    }
    return !isAlive(pid);
  }

  /** The process id the background app recorded in the data directory at start. null if not recorded, not a number, or if that id no longer looks like it */
  function recordedPid() {
    let text;
    try {
      text = readFileSync(paths.pidFile, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    const pid = Number(text.trim());
    if (!Number.isInteger(pid) || pid <= 1) return null;
    // Process ids get reused by other programs, so also check it is running us: a command-started main process is .../MacOS/Electron,
    // the installed app is .../MacOS/WhisprFlow, and on Windows it is ...\\electron.exe. Just looking for "Electron" isn't enough: other apps' helper processes have it in their paths too
    return OUR_EXECUTABLE.test(commandOf(pid) ?? "") ? pid : null;
  }

  return {
    status,
    request,

    /**
     * Starts the background app and waits until it is ready (key verified, microphone permission prompt answered). Call only after making sure it isn't running.
     * @param {{ onProgress: (message: object) => void }} options what the user should know along the way (msg)
     * @returns {Promise<object>} the state after starting; starting is still true if it took too long
     */
    async start({ onProgress }) {
      ensureHelper(packageDir, { onBuild: () => onProgress(msg("cli.daemon.building")) });
      const electron = resolveElectron(onProgress);

      // The log goes into the home directory. Create that properly first: creating it along the log's path would give the directory default permissions
      ensureHome(paths);
      rotateIfLarge(paths.logFile);
      const logFd = openSync(paths.logFile, "a");
      // With ELECTRON_RUN_AS_NODE Electron treats itself as plain Node, with no windows or hotkeys
      const { ELECTRON_RUN_AS_NODE: _dropped, ...childEnv } = env;
      /** How the process we started ended; null while it is still running */
      let ended = null;
      const child = spawn(electron, [packageDir], {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...childEnv, WHISPRFLOW_CLI: "1" },
      });
      child.on("exit", (code, signal) => {
        ended = { code, reason: signal ? msg("cli.daemon.signal", { signal }) : msg("cli.daemon.exitCode", { code }) };
      });
      child.on("error", (error) => {
        ended = { code: null, reason: String(error.message) };
      });
      child.unref();
      closeSync(logFd);

      // Another whisprflow command started one first, and ours found it and exited: not a failure, so wait on the first one
      const lostRace = () => ended?.code === ALREADY_RUNNING_EXIT_CODE;
      const failed = () =>
        new LocalizedError(
          msg("cli.daemon.failed", {
            reason: ended && !lostRace() ? ended.reason : msg("cli.daemon.exitedEarly"),
            file: paths.logFile,
            tail: logTail(paths.logFile),
          }),
        );

      let current = null;
      for (const deadline = Date.now() + connectTimeoutMs; current === null; await sleep(pollMs)) {
        current = await status();
        if (current !== null) break;
        if (ended && !lostRace()) throw failed();
        if (Date.now() > deadline) {
          throw new LocalizedError(
            msg("cli.daemon.noAnswer", { seconds: connectTimeoutMs / 1000, file: paths.logFile }),
          );
        }
      }

      const said = new Set();
      for (const deadline = Date.now() + readyTimeoutMs; current.starting && Date.now() < deadline; ) {
        const hint = startingHint(current);
        if (hint && !said.has(hint)) {
          said.add(hint);
          onProgress(msg(hint));
        }
        await sleep(pollMs);
        current = await status();
        if (current === null) throw failed();
      }
      return current;
    },

    /**
     * Stops the background app and returns only once its process is really gone. First asks it to quit, and ends the process if it doesn't;
     * if it hangs and doesn't answer, ends it by the process id recorded at start.
     * @returns {Promise<"not-running" | "quit" | "killed">} wasn't running / quit by itself / was ended
     */
    async stop() {
      let pid = null;
      let answering = true;
      try {
        const current = await status();
        if (current === null) return "not-running";
        pid = current.pid;
        await request("quit");
      } catch (error) {
        if (error instanceof TimeoutError) {
          answering = false;
          pid ??= recordedPid();
          if (pid === null) {
            throw new LocalizedError(msg("cli.daemon.stuckNoPid"));
          }
          // It vanished by itself after answering "running" and before getting the quit command: not an error
        } else if (!(error instanceof NotRunningError)) throw error;
      }

      if (answering && (await exited(pid, quitTimeoutMs))) return "quit";
      for (const signal of ["SIGTERM", "SIGKILL"]) {
        try {
          kill(pid, signal);
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        if (await exited(pid, quitTimeoutMs)) return "killed";
      }
      throw new LocalizedError(msg("cli.daemon.cantStop", { pid }));
    },
  };
}
