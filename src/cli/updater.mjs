import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { LocalizedError, msg } from "../i18n/index.mjs";
import { removeAfterExit } from "./windows-system.mjs";

// Talking to the download address: asks which version is latest and installs it with the installer from there; if WhisprFlow.app is installed, downloads the new package to replace it.
// curl rather than Node's own fetch: the installer uses it too, so proxies set in the terminal (https_proxy and the like) apply the same on both sides.
// Windows 10 and later ship curl.exe. On Windows the installer is install.ps1, and there is no separate app to replace.

const WINDOWS = process.platform === "win32";

/** Releases live here, the same as DOWNLOAD_URL in install.sh */
export const DOWNLOAD_URL = "https://github.com/zghanw/whisprflow/releases";

/** The bundle id written into the app when packaging (scripts/build/mac-app.mjs): something named WhisprFlow.app isn't necessarily ours */
const APP_BUNDLE_ID = "com.zghanw.whisprflow";
const APP_NAME = "WhisprFlow.app";

/** Where to download from. Like the installer, accepts WHISPRFLOW_INSTALL_BASE: a URL prefix, or a local directory (made by npm run release) */
export function downloadBase(env) {
  const base = env.WHISPRFLOW_INSTALL_BASE || DOWNLOAD_URL;
  if (base.startsWith("/")) return `file://${base}`;
  // Windows drive paths: C:\dist\release becomes file:///C:/dist/release
  if (/^[A-Za-z]:[\\/]/.test(base)) return `file:///${base.replaceAll("\\", "/")}`;
  return base;
}

/**
 * Runs a downloaded install.ps1 on Windows. Reads it as UTF-8 and runs it as a script block: saved to a file and run with -File,
 * 5.1 reads a script without a BOM in the system code page; this also sidesteps the execution policy (which only governs running files)
 */
const RUN_INSTALL_PS1 =
  "& ([scriptblock]::Create([IO.File]::ReadAllText($env:WHISPRFLOW_INSTALL_SCRIPT, [Text.Encoding]::UTF8))); exit $LASTEXITCODE";

/** The previous program, renamed aside because it was still in use (app.old.* and runtime.old.*, moved by install.ps1) */
function oldCopies(home) {
  try {
    return readdirSync(home)
      .filter((name) => /^(app|runtime)\.old\./.test(name))
      .map((name) => join(home, name));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

/** Runs a command and returns its standard output. On failure, throws along with what it said on standard error */
function run(command, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", env }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      error.said = stderr.trim() || error.message;
      reject(error);
    });
  });
}

/** Fetches an address with curl. On failure, reports the address and curl's own reason */
async function curl(url, args) {
  try {
    return await run("curl", ["-fsSL", ...args, url]);
  } catch (error) {
    throw new LocalizedError(msg("cli.update.unreachable", { url, reason: error.said }), { cause: error });
  }
}

/** Downloads a large file. In a terminal, curl's progress bar goes to the terminal: the package is over a hundred MB, too long to wait in silence */
function download(url, file, { progress }) {
  return new Promise((resolve, reject) => {
    const args = ["-fL", progress ? "--progress-bar" : "-sS", "--max-time", "1800", "-o", file, url];
    const child = spawn("curl", args, { stdio: ["ignore", "ignore", progress ? "inherit" : "pipe"] });
    let said = "";
    child.stderr?.on("data", (chunk) => {
      said += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) return resolve();
      const reason = said.trim() || `curl exit ${code}`;
      reject(new LocalizedError(msg("cli.update.unreachable", { url, reason })));
    });
  });
}

function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** An app bundle's bundle id and version; null if it isn't an app bundle (missing, or no Info.plist) */
async function bundleInfo(app) {
  const plist = join(app, "Contents", "Info.plist");
  if (!existsSync(plist)) return null;
  const read = async (key) => (await run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist])).trim();
  try {
    return { id: await read("CFBundleIdentifier"), version: await read("CFBundleShortVersionString") };
  } catch {
    return null;
  }
}

/** Which app bundle the running process's program is in (.../WhisprFlow.app/Contents/MacOS/WhisprFlow -> .../WhisprFlow.app) */
async function bundleOfProcess(pid) {
  let executable;
  try {
    executable = (await run("ps", ["-o", "comm=", "-p", String(pid)])).trim();
  } catch {
    // The process just exited: treat it as not running
    return null;
  }
  const at = executable.indexOf(".app/Contents/MacOS/");
  return at === -1 ? null : executable.slice(0, at + ".app".length);
}

/** The downloaded app bundle's signature is intact: every file matches the signature */
async function verifySignature(app) {
  try {
    await run("codesign", ["--verify", "--deep", "--strict", app]);
  } catch (error) {
    throw new LocalizedError(msg("cli.update.appUnsigned", { reason: error.said }), { cause: error });
  }
}

/** The signing developer's team id. "not set" for an ad-hoc signature, null if unsigned */
async function teamOf(app) {
  // codesign -d writes its details to standard error; when unsigned it exits with an error and the details lack this line
  const described = await new Promise((resolve) => {
    execFile("codesign", ["-dv", app], { encoding: "utf8" }, (_error, _stdout, stderr) => resolve(stderr));
  });
  return /^TeamIdentifier=(.*)$/m.exec(described)?.[1] ?? null;
}

/**
 * @param {object} options
 * @param {Record<string, string | undefined>} options.env the installer runs in this environment too (proxies and WHISPRFLOW_INSTALL_BASE are passed on)
 * @param {string} options.home where to install: the home directory of the current copy
 * @param {boolean} [options.progress] show a progress bar while downloading the package
 */
export function createUpdater({ env, home, progress = false }) {
  const base = downloadBase(env);
  return {
    /** The version marked latest at the download address (as is, like v0.6.0). @param {number} timeoutSeconds the longest to wait */
    async latest(timeoutSeconds) {
      const text = await curl(`${base}/latest`, ["--max-time", String(timeoutSeconds)]);
      return text.split("\n")[0].trim();
    },

    /**
     * Installs this version with the installer at the download address. It stops the running app and replaces the program, talking straight to the terminal.
     * Uses that installer rather than the one bundled here: the new version decides how it is installed
     * @param {{ start?: boolean }} [options] start false only installs without starting (--no-start)
     * @returns {Promise<number>} the installer's exit code
     */
    async install(version, { start = true } = {}) {
      const dir = mkdtempSync(join(tmpdir(), "whisprflow-update-"));
      try {
        const script = join(dir, WINDOWS ? "install.ps1" : "install.sh");
        await curl(`${base}/${WINDOWS ? "install.ps1" : "install.sh"}`, ["--max-time", "60", "-o", script]);
        const installerEnv = { ...env, WHISPRFLOW_HOME: home, WHISPRFLOW_VERSION: version };
        const [command, args] = WINDOWS
          ? ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", RUN_INSTALL_PS1]]
          : ["/bin/bash", [script, ...(start ? [] : ["--no-start"])]];
        if (WINDOWS) {
          installerEnv.WHISPRFLOW_INSTALL_SCRIPT = script;
          // install.ps1 run through irm | iex can't take arguments, only environment variables
          if (!start) installerEnv.WHISPRFLOW_NO_START = "1";
          // It runs commands with the installed Electron as Node itself; don't pass ours along
          delete installerEnv.ELECTRON_RUN_AS_NODE;
        }
        const code = await new Promise((resolve, reject) => {
          const child = spawn(command, args, { stdio: "inherit", env: installerEnv });
          child.on("error", reject);
          // Interrupted by a signal there is no exit code: counts as not installed
          child.on("exit", (exitCode) => resolve(exitCode ?? 1));
        });
        // On Windows this command runs on the program being replaced, which install.ps1 can't delete: delete it after this command exits
        if (WINDOWS && code === 0) {
          const old = oldCopies(home);
          if (old.length > 0) removeAfterExit(old);
        }
        return code;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },

    /**
     * Where the installed WhisprFlow.app is and its version. First the one WHISPRFLOW_APP points at; then the running one (the user may not keep it in Applications);
     * then the two Applications folders
     * @param {number | null} pid the running app's process id; null when what is running isn't the app
     * @returns {Promise<{ path: string, version: string } | null>}
     */
    async findApp(pid) {
      // Windows has no separate app: the Start menu launches the copy the CLI installed
      if (WINDOWS) return null;
      const candidates = env.WHISPRFLOW_APP
        ? [env.WHISPRFLOW_APP]
        : [
            pid === null ? null : await bundleOfProcess(pid),
            join("/Applications", APP_NAME),
            join(env.HOME || homedir(), "Applications", APP_NAME),
          ];
      for (const path of candidates) {
        if (path === null) continue;
        const info = await bundleInfo(path);
        if (info?.id === APP_BUNDLE_ID) return { path, version: info.version };
      }
      return null;
    },

    /**
     * Downloads this version's package and replaces the WhisprFlow.app at app with the one inside.
     * Checks first: the checksum matches the release, it really is WhisprFlow at this version, the signature is intact, and it comes from the same developer as the installed one
     * (the checksum sits next to the package, so it only guards against corruption in transit; the same developer guards against a swapped package).
     * The new one is copied alongside first, then swapped with two renames: an error midway leaves the installed one as it was. Quit the app before calling
     */
    async installApp(version, app) {
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      const name = `WhisprFlow-${arch}.dmg`;
      const url = `${base}/${version}/${name}`;
      const dir = mkdtempSync(join(tmpdir(), "whisprflow-app-update-"));
      const mountpoint = join(dir, "mnt");
      let mounted = false;
      // Both new and old sit next to the app: a rename on the same disk is atomic. Names start with a dot, hidden in Finder
      const staged = join(dirname(app), `.${basename(app)}.new`);
      const old = join(dirname(app), `.${basename(app)}.old`);
      const cannotReplace = (error, reason = error.message) =>
        new LocalizedError(msg("cli.update.appReplace", { path: app, reason, url }), { cause: error });
      try {
        const dmg = join(dir, name);
        await download(url, dmg, { progress });
        await download(`${url}.sha256`, `${dmg}.sha256`, { progress: false });
        const expected = readFileSync(`${dmg}.sha256`, "utf8").split(/\s/)[0];
        if (expected !== (await sha256Of(dmg))) throw new LocalizedError(msg("cli.update.appChecksum", { file: name }));

        mkdirSync(mountpoint);
        try {
          await run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mountpoint, dmg]);
        } catch (error) {
          throw new LocalizedError(msg("cli.update.appMount", { file: name, reason: error.said }), { cause: error });
        }
        mounted = true;
        const source = join(mountpoint, APP_NAME);
        const wanted = version.replace(/^v/, "");
        const info = await bundleInfo(source);
        if (info?.id !== APP_BUNDLE_ID || info.version !== wanted) {
          throw new LocalizedError(msg("cli.update.appWrongPackage", { file: name, version: wanted }));
        }
        await verifySignature(source);
        const [incoming, current] = [await teamOf(source), await teamOf(app)];
        if (incoming !== current) {
          throw new LocalizedError(
            msg("cli.update.appOtherDeveloper", { found: incoming ?? "-", installed: current ?? "-" }),
          );
        }

        rmSync(staged, { recursive: true, force: true });
        rmSync(old, { recursive: true, force: true });
        try {
          // ditto copies the app bundle exactly, keeping the signature and the symbolic links inside
          await run("ditto", [source, staged]);
        } catch (error) {
          throw cannotReplace(error, error.said);
        }
        try {
          renameSync(app, old);
        } catch (error) {
          throw cannotReplace(error);
        }
        try {
          renameSync(staged, app);
        } catch (error) {
          renameSync(old, app);
          throw cannotReplace(error);
        }
        rmSync(old, { recursive: true, force: true });
      } finally {
        rmSync(staged, { recursive: true, force: true });
        // If it won't unmount the directory is still mounted and can't be deleted with it (that would delete files on a read-only disk): force the unmount, and report the error if that fails too
        if (mounted) {
          await run("hdiutil", ["detach", "-quiet", mountpoint]).catch(() =>
            run("hdiutil", ["detach", "-force", "-quiet", mountpoint]),
          );
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },

    /**
     * Opens the app (reopening whichever was running after the swap). open passes its own environment to the app it opens,
     * and this command runs on Electron as Node (ELECTRON_RUN_AS_NODE=1): passed along, the app would run as Node too and exit right after starting.
     * Everything else passes through, so WHISPRFLOW_HOME and the like match the CLI side
     */
    async openApp(app) {
      const { ELECTRON_RUN_AS_NODE: _asNode, ...appEnv } = env;
      await run("open", [app], { env: appEnv });
    },
  };
}
