import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// The Python runtime Phonon-2 runs in (the fermion-research package), installed into the model's own directory after its files download (store.mjs),
// so deleting the model frees it too. uv (Astral, MIT) does the work: the pinned uv build in the model's files downloads a pinned CPython, makes a
// virtual environment, and installs a pinned fermion-research with every dependency frozen to what was published by EXCLUDE_NEWER, so every install
// gets the same packages. Then the model archive is unpacked by fermion's own unpacker, which checks each file's sha256 before writing it.
// Nothing here touches the system Python or the user's uv settings (--no-config), and nothing is left outside the model directory.
//
// Layout in the model directory: runtime/python (CPython), runtime/venv (the environment), profile (the unpacked model, what the server loads).
// runtime/uv and runtime/cache exist only during the install, and the downloaded files (the archive, uv) go once used: the receipt says what was
// installed, and a reinstall downloads them again.

export const UV_VERSION = "0.12.23";
export const PYTHON_VERSION = "3.12.15";
export const FERMION_VERSION = "0.2.11";
/** No package newer than this, the date fermion-research 0.2.11 and the pinned model revision came out */
export const EXCLUDE_NEWER = "2026-10-09T00:00:00Z";

/** Goes into the model's install receipt: changing any pin installs the runtime again */
export const RUNTIME_STAMP = `fermion-research ${FERMION_VERSION} · uv ${UV_VERSION} · python ${PYTHON_VERSION} · ${EXCLUDE_NEWER}`;

const uvRelease = (asset, size, sha256) =>
  Object.freeze({
    path: asset,
    url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`,
    size,
    sha256,
  });

/** The uv build for each chip the runtime runs on (fermion ships native kernels for these two); downloaded and checked like a model file */
export const UV_BUILDS = Object.freeze({
  "windows-x64": uvRelease(
    "uv-x86_64-pc-windows-msvc.zip",
    18_043_715,
    "75d05de6762778c31ee183398de7dd15093fad0ed90b1f236d8205ea5ec00c90",
  ),
  "apple-silicon": uvRelease(
    "uv-aarch64-apple-darwin.tar.gz",
    17_044_217,
    "50487ae565ccd96e499056b4674d438f4c53170202617b4c759defe0c6a1b544",
  ),
});

/** What pip installs: Apple silicon adds the MLX packages, so the model runs on the GPU there (untested: no Mac to measure on) */
const PACKAGES = Object.freeze({
  "windows-x64": `fermion-research==${FERMION_VERSION}`,
  "apple-silicon": `fermion-research[mlx]==${FERMION_VERSION}`,
});

/** Bytes uv downloads (CPython and the packages, measured on Windows), for progress. Past it progress holds at the install share */
const DOWNLOAD_BYTES = 230_000_000;
/** Progress share once the packages are installed; the unpack takes the rest */
const INSTALLED_SHARE = 0.9;
/** The last lines of a failed step's output go into its error */
const OUTPUT_LINES = 20;

const UNPACK = [
  "import sys",
  "from pathlib import Path",
  "from fermion._speech.fetch import _unpack",
  "_unpack(Path(sys.argv[1]), Path(sys.argv[2]))",
].join("\n");

/** Where things live in a model directory */
export function runtimePaths(dir, platform = process.platform) {
  const root = join(dir, "runtime");
  return {
    root,
    python: platform === "win32" ? join(root, "venv", "Scripts", "python.exe") : join(root, "venv", "bin", "python"),
    profile: join(dir, "profile"),
  };
}

/** uv prints "Downloading torch (118.4MiB)" when a large download starts and " Downloaded torch" when it ends */
const DOWNLOADING = /^Downloading (.+) \(([\d.]+)(KiB|MiB|GiB)\)$/;
const DOWNLOADED = /^\s*Downloaded (.+)$/;
const UNITS = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };

/** Counts finished downloads from uv's output lines */
export function downloadMeter() {
  const started = new Map();
  let bytes = 0;
  return {
    line(text) {
      const starting = DOWNLOADING.exec(text);
      if (starting) started.set(starting[1], Number(starting[2]) * UNITS[starting[3]]);
      const done = DOWNLOADED.exec(text);
      if (done) bytes += started.get(done[1]) ?? 0;
    },
    get bytes() {
      return bytes;
    },
  };
}

/**
 * Runs a program to its end, handing each output line (stdout and stderr) to onLine.
 * Rejects when it exits with a non-zero code, with the last lines of output in the message
 */
export function runProgram(command, args, { env, cwd, signal, onLine = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, signal, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const last = [];
    const read = (stream) => {
      let rest = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        const lines = (rest + chunk).split(/\r?\n/);
        rest = lines.pop();
        for (const line of lines) {
          last.push(line);
          last.splice(0, Math.max(0, last.length - OUTPUT_LINES));
          onLine(line);
        }
      });
    };
    read(child.stdout);
    read(child.stderr);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}:\n${last.join("\n")}`));
    });
  });
}

/** The tar that reads and writes zip too: Windows 10 and later ship bsdtar in System32 (a tar from Git or MSYS on PATH can't), macOS's tar is bsdtar */
export const tarCommand = (platform = process.platform) =>
  platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

/**
 * Installs the runtime into a model directory whose files are already downloaded and verified, then unpacks the model.
 * Starts clean every time: a half-finished earlier try is removed first
 * @param {object} options
 * @param {object} options.model the catalog entry (files.archive and files.uv)
 * @param {string} options.dir the model directory
 * @param {string} options.chip which chip this is (chipOf in catalog.mjs)
 * @param {AbortSignal} [options.signal] stops the install (the running step is ended)
 * @param {(fraction: number) => void} [options.onProgress] 0 to 1
 * @param {typeof runProgram} [options.run] replaced by a fake in tests
 */
export async function installRuntime({
  model,
  dir,
  chip,
  signal,
  onProgress = () => {},
  run = runProgram,
  platform = process.platform,
}) {
  const packages = PACKAGES[chip];
  if (!packages) throw new Error(`${model.name} runs on Windows (x64) and Apple silicon only`);
  const { root, python, profile } = runtimePaths(dir, platform);
  rmSync(root, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
  const uvDir = join(root, "uv");
  mkdirSync(uvDir, { recursive: true });

  await run(tarCommand(platform), ["-xf", join(dir, model.files.uv.path), "-C", uvDir], { signal });
  // The Windows zip holds uv.exe at its top; the macOS archive has it in a folder named after the build
  const uv = [
    join(uvDir, "uv.exe"),
    join(uvDir, "uv"),
    join(uvDir, model.files.uv.path.replace(/\.tar\.gz$/, ""), "uv"),
  ].find((path) => existsSync(path));
  if (!uv) throw new Error(`No uv in ${model.files.uv.path}`);

  const env = {
    ...process.env,
    UV_PYTHON_INSTALL_DIR: join(root, "python"),
    UV_CACHE_DIR: join(root, "cache"),
    UV_NO_PROGRESS: "1",
  };
  const meter = downloadMeter();
  const onLine = (line) => {
    meter.line(line);
    onProgress(Math.min(INSTALLED_SHARE, (meter.bytes / DOWNLOAD_BYTES) * INSTALLED_SHARE));
  };
  const venv = join(root, "venv");
  await run(uv, ["venv", venv, "--python", PYTHON_VERSION, "--python-preference", "only-managed", "--no-config"], {
    env,
    cwd: root,
    signal,
    onLine,
  });
  await run(uv, ["pip", "install", "--python", venv, "--exclude-newer", EXCLUDE_NEWER, "--no-config", packages], {
    env,
    cwd: root,
    signal,
    onLine,
  });
  onProgress(INSTALLED_SHARE);

  // -I: the interpreter ignores PYTHON* variables and doesn't import from the working directory
  await run(python, ["-I", "-c", UNPACK, join(dir, model.files.archive.path), profile], { cwd: root, signal });
  // The cache holds the unzipped packages, about as big as the environment. The environment's files are hard links into it where the disk allows, and stay
  rmSync(join(root, "cache"), { recursive: true, force: true });
  rmSync(uvDir, { recursive: true, force: true });
  // The profile is unpacked and checked; the archive (164 MB) and uv's download aren't needed to run
  for (const used of [model.files.archive, model.files.uv]) rmSync(join(dir, used.path), { force: true });
  onProgress(1);
}
