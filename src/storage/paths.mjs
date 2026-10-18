import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { LocalizedError, msg } from "../i18n/index.mjs";
import { restrictToOwner } from "./owner-only.mjs";

// WhisprFlow's home: the program, its runtime, settings, keys, history, recordings, and logs all live in this one directory.
// Installing puts things in, deleting it removes everything. The CLI and the background app are two processes that find the same files through this convention.
//
//   ~/.whisprflow/
//     bin/ app/ runtime/           the program itself: put in at install, replaced whole on update
//     settings.json <vendor>-key.bin data/    your things (one key per model vendor: gemini-key.bin, openai-key.bin)
//     models/                      on-device transcription models: downloaded when needed, downloaded again if deleted
//     logs/ run/ cache/            produced while running, recreated if deleted
//
// Windows uses the same directory (%USERPROFILE%\.whisprflow); only the control channel lives elsewhere: a named pipe
// under the system's \\.\pipe\, named after the home directory, leaving nothing on disk.

/** On macOS a Unix socket path is at most 103 bytes (sockaddr_un.sun_path is 104, including the trailing 0) */
const MAX_SOCKET_PATH_BYTES = 103;

/**
 * Where the control channel is. On macOS a Unix socket under run/; Windows has no sockets in directories, so a named pipe
 * whose name carries a fingerprint of the home directory: two homes (like temporary ones in tests) get their own, and one home gives the CLI and the background the same one.
 * Windows paths are case-insensitive, so they are lowercased before fingerprinting
 */
function controlEndpoint(home, path, platform) {
  if (platform !== "win32") return path.join(home, "run", "control.sock");
  const id = createHash("sha256").update(home.toLowerCase()).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\whisprflow-${id}`;
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} userHome the user's home directory, replaced in tests
 * @param {NodeJS.Platform} platform whose path style to use, replaced in tests
 */
export function resolvePaths(env = process.env, userHome = homedir(), platform = process.platform) {
  const path = platform === "win32" ? win32 : posix;
  const join = path.join;
  // WHISPRFLOW_HOME moves the whole directory elsewhere. Tests point it at a temporary directory, away from real history
  const home = env.WHISPRFLOW_HOME || join(userHome, ".whisprflow");
  // A relative path changes with "where the command runs": from another directory the running instance isn't found and a second one starts
  if (!path.isAbsolute(home)) {
    throw new LocalizedError(msg("paths.homeNotAbsolute", { home: JSON.stringify(home) }));
  }
  const controlSocket = controlEndpoint(home, path, platform);
  if (platform !== "win32" && Buffer.byteLength(controlSocket) > MAX_SOCKET_PATH_BYTES) {
    throw new LocalizedError(msg("paths.homeTooLong", { home }));
  }
  return {
    home,

    /** The whisprflow command (a launcher script). The one on PATH links to it */
    binDir: join(home, "bin"),
    /** Links to this command created outside the home at install, one per line. Uninstall removes them */
    linksFile: join(home, "bin", "links"),
    /** The program's code and dependencies */
    appDir: join(home, "app"),
    /** The runtime: the bundled Electron that runs both the CLI and the background app */
    runtimeDir: join(home, "runtime"),

    settingsFile: join(home, "settings.json"),
    historyDb: join(home, "data", "history.db"),
    recordingsDir: join(home, "data", "Recordings"),
    /** On-device transcription models, one directory per model (models/store.mjs) */
    modelsDir: join(home, "models"),

    logFile: join(home, "logs", "main.log"),
    /** Small runtime files (process id, last update check); the macOS control socket lives here too */
    runDir: join(home, "run"),
    /** The control channel between the CLI and the background: a socket path on macOS, a named pipe name on Windows */
    controlSocket,
    /** The running background app's process id. Only needed to force-stop it when it hangs */
    pidFile: join(home, "run", "daemon.pid"),
    /** When the latest version was last checked and the result. status uses it to check at most once a day */
    updateCheckFile: join(home, "run", "update-check.json"),
    /** The runtime's (Chromium's) own cache and state, kept apart from our data. Safe to delete once stopped */
    cacheDir: join(home, "cache"),
  };
}

/**
 * The home directory of an installed copy on Windows: the program is <home>\runtime\electron.exe with app beside it.
 * Launches from the Start menu or at login have no WHISPRFLOW_HOME (only the whisprflow command sets it), so this finds the home for installs elsewhere.
 * null for other layouts (running from source, macOS)
 * @param {string} execPath the running executable
 * @param {(path: string) => boolean} exists
 */
export function installedHomeOf(execPath, exists) {
  const path = win32;
  if (path.basename(execPath).toLowerCase() !== "electron.exe") return null;
  const runtime = path.dirname(execPath);
  if (path.basename(runtime).toLowerCase() !== "runtime") return null;
  const home = path.dirname(runtime);
  return exists(path.join(home, "app", "package.json")) ? home : null;
}

/**
 * Where a model vendor's encrypted key is stored.
 * The app and a CLI-started background share this one file: the encryption key has a single keychain entry ("WhisprFlow Safe Storage") with both
 * on its access list, so each can decrypt what the other saved.
 * @param {ReturnType<typeof resolvePaths>} paths
 * @param {string} provider the vendor id (providers/index.mjs)
 */
export function keyFile(paths, provider) {
  return pathModuleOf(paths).join(paths.home, `${checkedVendorId(provider)}-key.bin`);
}

/** Which path style home paths use: the same as resolvePaths produced (a drive letter or a leading \\ means Windows) */
const pathModuleOf = (paths) => (/^([A-Za-z]:|\\\\)/.test(paths.home) ? win32 : posix);

/** Ids come from our own registry; guard anyway so no path lands outside the home */
function checkedVendorId(provider) {
  if (!/^[a-z0-9]+$/.test(provider)) throw new Error(`Invalid vendor id: ${JSON.stringify(provider)}`);
  return provider;
}

/**
 * Creates the home directory. It holds recordings and keys, so only the owner can enter.
 * @param {ReturnType<typeof resolvePaths>} paths
 */
export function ensureHome(paths, { restrict = restrictToOwner } = {}) {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  // mkdir doesn't change the permissions of an existing directory, and mode does nothing on Windows; this step does it
  restrict(paths.home);
  mkdirSync(paths.runDir, { recursive: true });
}
