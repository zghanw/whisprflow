import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { msg } from "../../i18n/index.mjs";
import { noPositionals, parse, UsageError } from "../common.mjs";

// whisprflow uninstall: stops the background app and deletes the whole WhisprFlow directory; anything outside it that can't be removed is listed.
// What the install touched outside the directory is recorded in bin\links, one per line: on macOS a link to the whisprflow command (a path),
// on Windows "path <the entry in the user Path>" and "shortcut <the Start menu shortcut>" (written by install.ps1).
// On Windows a running program can't be deleted, and this command itself runs on the installed Electron: what can't be deleted is removed after it exits (io.system).

/** The file in the cache directory where Electron (Chromium) records its encryption key */
const LOCAL_STATE = "Local State";

/** Whether this link points at our own command. Entries in the list are rechecked before uninstalling: something else may be at that location now */
function isOurLink(link, binDir) {
  try {
    if (!lstatSync(link).isSymbolicLink()) return false;
    return resolve(dirname(link), readlinkSync(link)).startsWith(binDir + sep);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function recordedLinks(io) {
  try {
    // Written by install.ps1 (Windows PowerShell 5.1): starts with a BOM and uses CRLF line endings
    return readFileSync(io.paths.linksFile, "utf8")
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function uninstall(args, io) {
  const { values, positionals } = parse(args, {
    "keep-data": { type: "boolean", default: false },
    yes: { type: "boolean", short: "y", default: false },
  });
  noPositionals(positionals, "uninstall");
  const { paths, t } = io;
  const keepData = values["keep-data"];
  const named = { home: paths.home, yours: t("cli.uninstall.yours") };

  if (!values.yes) {
    if (!io.interactive) throw new UsageError(msg("cli.uninstall.needsConfirm"));
    io.out(t(keepData ? "cli.uninstall.planKeep" : "cli.uninstall.planAll", named));
    if (!(await io.confirm(t("cli.uninstall.confirm")))) {
      io.out(t("cli.uninstall.aborted"));
      return 1;
    }
  }

  // It still has those files open. If it can't be stopped, stop here and report the error as is
  await io.daemon.stop();

  const removed = [];
  const leftovers = [];
  for (const line of recordedLinks(io)) {
    const [kind, target] =
      line.startsWith("path ") || line.startsWith("shortcut ") ? line.split(/ (.*)/s) : ["link", line];
    if (kind === "path") {
      if (io.system.removePathEntry(target)) removed.push(t("cli.uninstall.pathEntry", { entry: target }));
    } else if (kind === "shortcut") {
      if (!io.system.isOurShortcut(target, paths.home)) continue;
      rmSync(target, { force: true });
      removed.push(target);
    } else if (isOurLink(target, paths.binDir)) {
      rmSync(target);
      removed.push(target);
    }
  }
  // If launch at login was turned on in the app's settings, that entry lives in the system (the Windows registry)
  if (io.platform === "win32" && io.system.removeLoginItem(paths.home)) removed.push(t("cli.uninstall.loginItem"));

  /** What can't be deleted now and is removed after this command exits (Windows only) */
  const later = [];
  // On Windows this command is started by bin\whisprflow.cmd: cmd reads that batch file again after it exits, so deleting it now
  // makes it report "batch file not found" and exit with 1. bin is kept until after exit (tested on real hardware; an exit on the same line doesn't avoid it)
  const deferBin = io.platform === "win32";
  const remove = (dir) => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      if (io.platform !== "win32" || !["EPERM", "EBUSY", "ENOTEMPTY"].includes(error.code)) throw error;
      later.push(dir);
    }
  };

  if (keepData) {
    const logsDir = dirname(paths.logFile);
    for (const dir of [paths.appDir, paths.runtimeDir, paths.runDir, logsDir]) remove(dir);
    // On Windows saved keys are encrypted with Electron's safeStorage, and the key that unlocks them (DPAPI encrypted) is kept in
    // Local State in the cache directory: keeping the keys means keeping it, while the rest of the cache is deleted. On macOS that key is in the Keychain, so the whole cache goes
    if (io.platform === "win32" && existsSync(paths.cacheDir)) {
      for (const name of readdirSync(paths.cacheDir)) if (name !== LOCAL_STATE) remove(join(paths.cacheDir, name));
    } else remove(paths.cacheDir);
    if (deferBin) later.push(paths.binDir);
    else remove(paths.binDir);
    removed.push(t("cli.uninstall.removedKeep", named));
  } else {
    try {
      if (io.removeKeychainKey()) removed.push(t("cli.uninstall.keychainItem"));
    } catch (error) {
      leftovers.push(t("cli.uninstall.keychainFailed", { reason: error.message }));
    }
    if (deferBin && existsSync(paths.home)) {
      // Delete what can be deleted now (reporting or noting what can't), then delete the whole home with bin again after exit
      for (const name of readdirSync(paths.home)) {
        if (join(paths.home, name) !== paths.binDir) remove(join(paths.home, name));
      }
      later.splice(0, later.length, paths.home);
    } else {
      remove(paths.home);
    }
    removed.push(t("cli.uninstall.removedAll", named));
  }
  if (later.length > 0) io.system.removeAfterExit(later);

  io.out(t("cli.uninstall.done"));
  for (const item of removed) io.out(`  ${t("cli.uninstall.removed", { item })}`);
  if (later.length > 0) io.out(`  ${t("cli.uninstall.afterExit")}`);
  if (keepData) io.out(`  ${t("cli.uninstall.kept", named)}`);
  // List what can't be removed, or shouldn't be removed by us. Windows has no permissions recorded under the terminal's name
  if (io.platform !== "win32") leftovers.push(t("cli.uninstall.permissions"));
  if (io.sharedPreferencesFile && existsSync(io.sharedPreferencesFile)) {
    leftovers.push(t("cli.uninstall.sharedPrefs", { file: io.sharedPreferencesFile }));
  }
  // When run from a source checkout, the program isn't in our directory
  if (!io.packageDir.startsWith(paths.home + sep)) leftovers.push(t("cli.uninstall.sourceDir", { dir: io.packageDir }));
  if (leftovers.length > 0) {
    io.out(`  ${t("cli.uninstall.leftovers")}`);
    for (const item of leftovers) io.out(`    · ${item}`);
  }
  return 0;
}
