import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LocalizedError, msg } from "../i18n/index.mjs";

// Where the native helper's executable (hotkey listening, pasting text) comes from. One per system, speaking the same protocol to the parent (src/app/helper.mjs):
//   macOS    native/main.swift  -> build/key-helper      built with swiftc; releases merge both chips into one
//   Windows  native/windows/    -> build/key-helper.exe  built with Go (scripts/build/go.sh cross-compiles on a Mac)
// The installed program ships prebuilt without sources; run from a source checkout it is built locally on first start and after source changes.

/** The lowest system version Electron 44 supports; the helper matches it */
const MIN_MACOS = "12.0";
const UNIVERSAL_ARCHS = ["arm64", "x86_64"];

/**
 * @param {string} packageDir
 * @param {NodeJS.Platform} [platform] which system it is for
 */
export function helperPaths(packageDir, platform = process.platform) {
  const windows = platform === "win32";
  const binary = join(packageDir, "build", windows ? "key-helper.exe" : "key-helper");
  return {
    // On Windows it is a directory (a Go module); on macOS a single file
    source: windows ? join(packageDir, "native", "windows") : join(packageDir, "native", "main.swift"),
    binary,
    /** Which sources the executable was built from: the SHA-256 of those sources */
    stamp: `${binary}.source-sha256`,
  };
}

function readOrNull(file) {
  try {
    return readFileSync(file);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") return null;
    throw error;
  }
}

/** The file names in a directory; null if it isn't a directory (or doesn't exist) */
function listOrNull(dir) {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

/**
 * The source content used for the fingerprint: a single file is itself (so existing builds need no rebuild);
 * a Go module is go.mod plus the non-test .go files, sorted by name and joined with their names. null if the sources are missing
 */
function sourceContent(source, read, list) {
  const names = list(source);
  if (names === null) return read(source);
  const parts = names
    .filter((name) => name === "go.mod" || (name.endsWith(".go") && !name.endsWith("_test.go")))
    .sort()
    .flatMap((name) => [Buffer.from(`${name}\0`), read(join(source, name)) ?? Buffer.alloc(0), Buffer.from("\0")]);
  return parts.length === 0 ? null : Buffer.concat(parts);
}

const fingerprint = (content) => createHash("sha256").update(content).digest("hex");

/**
 * Whether to (re)build: there is no executable, or it wasn't built from the current sources.
 * File modification times aren't compared: unpacking and git checkouts set them to the current time, and in installed packages the sources were seen to be "newer" than the executable,
 * which triggered a pointless build that then failed on machines without build tools.
 */
export function helperNeedsBuild({ source, binary, stamp }, read = readOrNull, list = listOrNull) {
  if (read(binary) === null) return true;
  const written = sourceContent(source, read, list);
  if (written === null) return false;
  return read(stamp)?.toString().trim() !== fingerprint(written);
}

/** Runs the compiler. Not installed (command not found) and build errors are reported separately; messages: { missing, failed }, the keys of the two sentences */
function compile(run, command, args, options, messages) {
  try {
    run(command, args, { stdio: ["ignore", "ignore", "pipe"], ...options });
  } catch (error) {
    if (error.code === "ENOENT") throw new LocalizedError(msg(messages.missing), { cause: error });
    const detail = String(error.stderr ?? "").trim() || error.message;
    throw new LocalizedError(msg(messages.failed, { detail }), { cause: error });
  }
}

const SWIFT = { missing: "cli.daemon.needXcode", failed: "cli.daemon.buildFailed" };
const GO = { missing: "cli.daemon.needGo", failed: "cli.daemon.buildFailedGo" };

/**
 * Where Go is: on Windows the installed go; on other systems (releases, cross-compiling) the project's own copy (scripts/build/go.sh,
 * downloaded into .tools/ on first use)
 */
export const goCommand = (packageDir, host) =>
  host === "win32" ? "go" : join(packageDir, "scripts", "build", "go.sh");

/**
 * Builds the helper and records which sources it came from.
 * @param {string} packageDir
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform] which system to build for: win32 builds the Windows one (cross-compiling on a Mac)
 * @param {boolean} [options.universal] on macOS, builds one per chip and merges them into one file; used for releases
 */
export function buildHelper(
  packageDir,
  {
    platform = process.platform,
    host = process.platform,
    universal = false,
    run = execFileSync,
    mkdir = mkdirSync,
    remove = rmSync,
    read = readOrNull,
    list = listOrNull,
    write = writeFileSync,
  } = {},
) {
  const { source, binary, stamp } = helperPaths(packageDir, platform);
  mkdir(dirname(binary), { recursive: true });
  if (platform === "win32") {
    // -H windowsgui: not a console program, so no black window flashes when it starts; standard input and output still connect
    compile(
      run,
      goCommand(packageDir, host),
      ["build", "-trimpath", "-ldflags", "-s -w -H windowsgui", "-o", binary, "."],
      { cwd: source, env: { ...process.env, GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "0" } },
      GO,
    );
  } else if (universal) {
    const slices = UNIVERSAL_ARCHS.map((arch) => `${binary}-${arch}`);
    UNIVERSAL_ARCHS.forEach((arch, index) => {
      compile(
        run,
        "swiftc",
        ["-O", "-target", `${arch}-apple-macos${MIN_MACOS}`, "-o", slices[index], source],
        {},
        SWIFT,
      );
    });
    run("lipo", ["-create", "-output", binary, ...slices]);
    for (const slice of slices) remove(slice, { force: true });
  } else {
    compile(run, "swiftc", ["-O", "-o", binary, source], {}, SWIFT);
  }
  write(stamp, `${fingerprint(sourceContent(source, read, list))}\n`);
}

/**
 * Builds once if needed (for this system). Building takes over ten seconds, so onBuild is called first to give the caller a chance to say so.
 * @returns {boolean} whether it built this time
 */
export function ensureHelper(
  packageDir,
  { read = readOrNull, list = listOrNull, onBuild = () => {}, platform = process.platform, ...buildOptions } = {},
) {
  if (!helperNeedsBuild(helperPaths(packageDir, platform), read, list)) return false;
  onBuild();
  buildHelper(packageDir, { read, list, platform, ...buildOptions });
  return true;
}
