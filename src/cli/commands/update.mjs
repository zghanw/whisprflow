import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TimeoutError } from "../../control.mjs";
import { LocalizedError, msg } from "../../i18n/index.mjs";
import { noPositionals, parse } from "../common.mjs";

// whisprflow update: if the download address has a newer version, installs it with the installer from there. Same as running the install line again
// (stop, replace the program, start again; settings, keys, history, and recordings stay), without having to remember the address.
// If WhisprFlow.app is also installed on this computer it is replaced too: both share the same settings and data, so their versions must match.
// status also mentions a newer version (newerVersion): it asks the download address at most once a day.
// Must run from the copy installed by the installer: a source checkout uses git pull; with only the app and no CLI, download the new installer.

/** The same format the installer accepts: v0.6.0, 0.6.0-rc.1 */
const VERSION = /^v?(\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?)$/;
/** The most seconds status waits for one check: it is incidental and must not slow status down */
const STATUS_CHECK_SECONDS = 3;
const UPDATE_CHECK_SECONDS = 20;
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Compares two version numbers numerically (0.10.0 is newer than 0.9.0); a prerelease is older than the release of the same number, and prereleases compare as rc.9 < rc.10.
 * @returns {number} positive if a is newer, 0 if equal, negative if a is older
 */
export function compareVersions(a, b) {
  const split = (version) => {
    const [core, ...pre] = version.split("-");
    return { numbers: core.split(".").map(Number), pre: pre.join("-") };
  };
  const left = split(a);
  const right = split(b);
  for (let index = 0; index < 3; index++) {
    const difference = left.numbers[index] - right.numbers[index];
    if (difference !== 0) return difference;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === "") return 1;
  if (right.pre === "") return -1;
  return left.pre.localeCompare(right.pre, "en", { numeric: true });
}

/**
 * The copy installed by the installer: the program lives in app under the home directory. Compares real paths: the home directory may go through a symbolic link
 * (/tmp is really /private/tmp), and the program's own location is computed as a real path
 */
function installedCopy(io) {
  try {
    return realpathSync(io.packageDir) === realpathSync(io.paths.appDir);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** The latest version the download address reports, without the leading v. Anything that doesn't look like a version (say, an error page) is ignored */
async function latestVersion(io, timeoutSeconds) {
  const answer = await io.updater.latest(timeoutSeconds);
  const match = VERSION.exec(answer);
  if (!match) throw new LocalizedError(msg("cli.update.badVersion", { value: JSON.stringify(answer) }));
  return match[1];
}

/** The last check's result: { checkedAt, latest }, where latest is null if that check failed. Never checked, or a broken record, counts as never checked */
function lastCheck(io) {
  try {
    const record = JSON.parse(readFileSync(io.paths.updateCheckFile, "utf8"));
    return Number.isFinite(Date.parse(record?.checkedAt)) ? record : null;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function rememberCheck(io, latest) {
  mkdirSync(dirname(io.paths.updateCheckFile), { recursive: true });
  writeFileSync(io.paths.updateCheckFile, JSON.stringify({ checkedAt: io.now().toISOString(), latest }));
}

/**
 * Whether there is a newer version than this copy (for status). Asks the download address at most once a day and records the result in the home directory.
 * If it can't ask, treat it as none: this is only an incidental reminder and status must not fail offline; whisprflow update says exactly why it couldn't ask.
 * A failed check is recorded too, and retried after a day, so status doesn't wait a few seconds every time while offline
 * @returns {Promise<string | null>} the newer version, or null for none
 */
export async function newerVersion(io) {
  if (!installedCopy(io)) return null;
  let latest;
  const last = lastCheck(io);
  if (last !== null && io.now() - Date.parse(last.checkedAt) < CHECK_EVERY_MS) {
    latest = last.latest;
  } else {
    try {
      latest = await latestVersion(io, STATUS_CHECK_SECONDS);
    } catch {
      latest = null;
    }
    rememberCheck(io, latest);
  }
  return latest !== null && compareVersions(latest, io.version) > 0 ? latest : null;
}

/** Which copy is running now: the background app's status, or null if not running. Hung and not answering also counts as unknown: the installer ends it by force when stopping it */
async function runningNow(io) {
  try {
    return await io.daemon.status();
  } catch (error) {
    if (error instanceof TimeoutError) return null;
    throw error;
  }
}

export async function update(args, io) {
  noPositionals(parse(args).positionals, "update");
  const { t } = io;
  if (!installedCopy(io)) {
    io.err(t("cli.update.fromSource", { dir: io.packageDir }));
    return 1;
  }
  const latest = await latestVersion(io, UPDATE_CHECK_SECONDS);
  rememberCheck(io, latest);
  const running = await runningNow(io);
  const appRunning = running?.packaged === true;
  const app = await io.updater.findApp(appRunning ? running.pid : null);
  const cliBehind = compareVersions(latest, io.version) > 0;
  const appBehind = app !== null && compareVersions(latest, app.version) > 0;
  if (!cliBehind && !appBehind) {
    io.out(t("cli.update.upToDate", { version: io.version }));
    return 0;
  }
  // The version to install is settled: even if a newer one appears at the download address before installing, install the one just named
  const version = `v${latest}`;

  // Replace the app first: if that fails the CLI copy stays as it is, so the two never end up one new and one old
  if (appBehind) {
    io.out(t("cli.update.updatingApp", { current: app.version, latest }));
    // Make the running program quit before replacing it
    if (appRunning) await io.daemon.stop();
    try {
      await io.updater.installApp(version, app.path);
    } catch (error) {
      if (appRunning) await io.updater.openApp(app.path);
      throw error;
    }
    io.out(t("cli.update.appDone", { version: latest }));
  }

  if (cliBehind) {
    io.out(t("cli.update.updating", { current: io.version, latest }));
    // With the app installed, only reopen whichever was running: the installer only starts the CLI copy if it was running before.
    // Without the app, start after installing as before
    const start = app === null || (running !== null && !appRunning);
    // The installer replaces this copy's program entirely: from here on no more code can be loaded
    const code = await io.updater.install(version, { start });
    if (code !== 0) {
      if (appRunning) await io.updater.openApp(app.path);
      return 1;
    }
  }

  if (appRunning) {
    await io.updater.openApp(app.path);
    io.out(t("cli.update.reopened"));
  }
  return 0;
}
