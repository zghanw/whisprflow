import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

// Installer tests: really run install.sh with a fake release package (its "Electron" is a small script recording how it was called),
// installing into a temporary home. System facts (OS version, chip, disk, root or not, whether each provider is reachable) are faked by same-named
// small scripts earlier in PATH, so nothing goes online and the real ~/.whisprflow is never touched.
// Each test really runs a few freshly generated scripts, and macOS checks a new file the first time it runs, so one install takes 3 to 6 seconds;
// that's why this group runs on its own with a generous time limit (npm run test:install), not slowing down the usual group.

const INSTALLER = resolve(import.meta.dirname, "..", "..", "install.sh");

let root;
/** The fake user home */
let userHome;
/** The directory holding fake release packages, used as the download address */
let release;
let shims;
/** The fake Electron records each call here */
let callLog;

/** The fake Electron: records its environment and arguments, and acts by its second argument (the one after the script path) */
const FAKE_ELECTRON = `#!/bin/sh
printf '%s|%s|%s|%s\\n' "$ELECTRON_RUN_AS_NODE" "$WHISPRFLOW_HOME" "$#" "$*" >> "$FAKE_CALL_LOG"
case "$2" in
  --version) [ -z "$FAKE_BROKEN" ] || exit 1; echo "$FAKE_VERSION" ;;
  # The real CLI speaks the terminal's language; the installer judges from its words whether it stopped, so it must ask for English
  stop) [ -z "$FAKE_STOP_FAILS" ] || { echo "Couldn't stop WhisprFlow (pid 1)" >&2; exit 1; }
    [ "$WHISPRFLOW_LANGUAGE" = en ] || { echo "(not asked for English)"; exit 0; }; echo "\${FAKE_STOP_SAYS:-WhisprFlow was not running.}" ;;
esac
`;

/** Small scripts earlier in PATH posing as system commands. Unless asked to fake something, they pass through to the real ones */
const SHIMS = {
  sw_vers: `#!/bin/sh\necho "\${FAKE_MACOS:-14.5}"\n`,
  uname: `#!/bin/sh\ncase "$1" in -s) echo "\${FAKE_OS:-Darwin}" ;; -m) echo "\${FAKE_ARCH:-arm64}" ;; *) exec /usr/bin/uname "$@" ;; esac\n`,
  id: `#!/bin/sh\n[ "$1" = "-u" ] && [ -n "$FAKE_UID" ] && { echo "$FAKE_UID"; exit 0; }\nexec /usr/bin/id "$@"\n`,
  df: `#!/bin/sh\n[ -n "$FAKE_FREE_KB" ] && { echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "/dev/x 9 9 $FAKE_FREE_KB 1% /"; exit 0; }\nexec /bin/df "$@"\n`,
  // Only the provider reachability checks are faked; downloads over file:// still go to the real curl
  curl: `#!/bin/sh\ncase "$*" in *generativelanguage.googleapis.com*) exit "\${FAKE_GEMINI_EXIT:-0}" ;; *api.openai.com*) exit "\${FAKE_OPENAI_EXIT:-0}" ;; esac\nexec /usr/bin/curl "$@"\n`,
};

function makeArchive(arch, version = "9.9.9") {
  const staging = mkdtempSync(join(root, "pkg-"));
  const electron = join(staging, "runtime", "Electron.app", "Contents", "MacOS", "Electron");
  mkdirSync(join(electron, ".."), { recursive: true });
  writeFileSync(electron, FAKE_ELECTRON.replace('"$FAKE_VERSION"', `"${version}"`));
  chmodSync(electron, 0o755);
  mkdirSync(join(staging, "app", "bin"), { recursive: true });
  writeFileSync(join(staging, "app", "bin", "whisprflow.mjs"), "// fake\n");
  writeFileSync(join(staging, "app", "package.json"), `{\n  "name": "whisprflow",\n  "version": "${version}"\n}\n`);
  // Laid out like the real download address: each version's packages in its own directory, with latest at the root naming the newest
  mkdirSync(join(release, `v${version}`), { recursive: true });
  const archive = join(release, `v${version}`, `whisprflow-darwin-${arch}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", staging, "app", "runtime"]);
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(`${archive}.sha256`, `${digest}  whisprflow-darwin-${arch}.tar.gz\n`);
  writeFileSync(join(release, "latest"), `v${version}\n`);
  rmSync(staging, { recursive: true });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "smi-"));
  userHome = join(root, "u");
  release = join(root, "release");
  shims = join(root, "shims");
  callLog = join(root, "calls.log");
  for (const dir of [userHome, release, shims]) mkdirSync(dir);
  for (const [name, script] of Object.entries(SHIMS)) {
    writeFileSync(join(shims, name), script);
    chmodSync(join(shims, name), 0o755);
  }
  makeArchive("arm64");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Runs the installer once. env may hold FAKE_* to make a check fake its result */
function install({ env = {}, args = [], path = "" } = {}) {
  const result = spawnSync("/bin/bash", [INSTALLER, ...args], {
    encoding: "utf8",
    env: {
      HOME: userHome,
      PATH: `${shims}:${path}/usr/bin:/bin:/usr/sbin:/sbin`,
      WHISPRFLOW_INSTALL_BASE: release,
      FAKE_CALL_LOG: callLog,
      ...env,
    },
  });
  return { code: result.status, out: result.stdout, err: result.stderr, all: result.stdout + result.stderr };
}

const home = () => join(userHome, ".whisprflow");
const calls = () => (existsSync(callLog) ? readFileSync(callLog, "utf8").trim().split("\n") : []);
const installedVersion = (dir = home()) => JSON.parse(readFileSync(join(dir, "app", "package.json"), "utf8")).version;

test("fresh install: the program and runtime land in ~/.whisprflow, the command works, and only one link is added outside the home", () => {
  const { code, out, all } = install();
  assert.equal(code, 0, all);
  assert.match(out, /Checks[\s\S]*Install[\s\S]*Installed WhisprFlow 9\.9\.9/);
  assert.equal(installedVersion(), "9.9.9");
  assert.equal(statSync(home()).mode & 0o777, 0o700, "it holds recordings and keys, so only the owner can get in");
  // The temporary directories for downloading and unpacking don't stay behind
  assert.deepEqual(readdirSync(home()).sort(), ["app", "bin", "runtime"]);

  const link = join(userHome, ".local", "bin", "whisprflow");
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readlinkSync(link), join(home(), "bin", "whisprflow"));
  assert.equal(readFileSync(join(home(), "bin", "links"), "utf8"), `${link}\n`);
  // Apart from these two, nothing else lands in the user's home
  assert.deepEqual(readdirSync(userHome).sort(), [".local", ".whisprflow"]);

  // Running from the link: the bundled Electron runs as Node on the installed program, passing arguments through
  execFileSync(link, ["config", "set", "model", "a b"], { env: { PATH: "/usr/bin:/bin", FAKE_CALL_LOG: callLog } });
  assert.equal(calls().at(-1), `1|${home()}|5|${join(home(), "app", "bin", "whisprflow.mjs")} config set model a b`);
});

test("without a terminal it installs without starting, and says how to start", () => {
  const { out } = install();
  assert.match(out, /Run whisprflow to start/);
  // During install the program is only called to ask its version and stop the old one
  assert.deepEqual(
    calls().map((line) => line.split(" ").at(-1)),
    ["--version", "stop"],
  );
});

test("the command link goes to a directory in PATH; when ~/.local/bin isn't in PATH it says how to add it", () => {
  const missing = install();
  assert.match(missing.out, /isn't on your PATH/);
  assert.match(missing.out, /export PATH=/);

  rmSync(home(), { recursive: true });
  const present = install({ path: `${join(userHome, ".local", "bin")}:` });
  assert.equal(present.code, 0);
  assert.doesNotMatch(present.out, /isn't on your PATH/);
});

test("installing again upgrades: the program is replaced, settings, keys, history, and recordings stay; the running one is stopped first", () => {
  assert.equal(install().code, 0);
  for (const [file, content] of [
    ["settings.json", '{"hotkey":"fn"}'],
    ["gemini-key.bin", "ciphertext"],
    ["data/history.db", "history"],
    ["data/Recordings/a.webm", "recording"],
  ]) {
    mkdirSync(join(home(), file, ".."), { recursive: true });
    writeFileSync(join(home(), file), content);
  }
  rmSync(callLog);
  makeArchive("arm64", "10.0.0");

  const { code, out } = install({ env: { FAKE_STOP_SAYS: "WhisprFlow stopped." } });
  assert.equal(code, 0, out);
  assert.match(out, /Found 9\.9\.9/);
  assert.match(out, /Stopped the running WhisprFlow/);
  assert.match(out, /Upgraded: 9\.9\.9 → 10\.0\.0/);
  assert.equal(installedVersion(), "10.0.0");
  assert.equal(readFileSync(join(home(), "settings.json"), "utf8"), '{"hotkey":"fn"}');
  assert.equal(readFileSync(join(home(), "data", "Recordings", "a.webm"), "utf8"), "recording");
  assert.equal(readFileSync(join(home(), "gemini-key.bin"), "utf8"), "ciphertext");
  assert.deepEqual(readdirSync(home()).sort(), ["app", "bin", "data", "gemini-key.bin", "runtime", "settings.json"]);
  // The link list doesn't record duplicates
  assert.equal(
    readFileSync(join(home(), "bin", "links"), "utf8")
      .trim()
      .split("\n").length,
    1,
  );
});

/** A failed preflight or an error midway: exits nonzero, says why, leaves an existing install alone, and leaves nothing behind for a new one */
function assertRefused(result, reason) {
  assert.equal(result.code, 1, result.all);
  assert.match(result.err, reason);
  assert.match(result.err, /Nothing was installed/);
}

test("a failed preflight stops there: not macOS, OS too old, run with sudo, not enough disk", () => {
  for (const [env, reason] of [
    [{ FAKE_OS: "Linux" }, /only supports macOS/],
    [{ FAKE_MACOS: "11.7.10" }, /macOS 11\.7\.10 is too old/],
    [{ FAKE_UID: "0" }, /Don't run this with sudo/],
    [{ FAKE_FREE_KB: "20480" }, /Not enough disk space: 20 MB free/],
    [{ FAKE_ARCH: "riscv64" }, /Unknown chip/],
  ]) {
    assertRefused(install({ env }), reason);
    assert.equal(existsSync(home()), false, `a failed install leaves no directory: ${JSON.stringify(env)}`);
    assert.deepEqual(calls(), []);
  }
});

test("Intel chips get the x64 package; when this version has no such package it says so before downloading", () => {
  const result = install({ env: { FAKE_ARCH: "x86_64" } });
  assertRefused(result, /Couldn't reach the release package/);
  assert.match(result.err, /whisprflow-darwin-x64\.tar\.gz/);
  assert.equal(existsSync(home()), false);

  makeArchive("x64", "9.9.9");
  assert.equal(install({ env: { FAKE_ARCH: "x86_64" } }).code, 0);
});

test("installs the version marked latest at the download address by default; WHISPRFLOW_VERSION picks another, with or without v", () => {
  makeArchive("arm64", "10.0.0");
  assert.equal(install().code, 0);
  assert.equal(installedVersion(), "10.0.0");

  assert.equal(install({ env: { WHISPRFLOW_VERSION: "v9.9.9" } }).code, 0);
  assert.equal(installedVersion(), "9.9.9");
  assert.equal(install({ env: { WHISPRFLOW_VERSION: "10.0.0" } }).code, 0);
  assert.equal(installedVersion(), "10.0.0");
});

test("no latest version, one that doesn't look like a version, or a missing specified version: all said before downloading, nothing installed", () => {
  writeFileSync(join(release, "latest"), "<html>error</html>\n");
  assertRefused(install(), /returned a bad version number/);

  rmSync(join(release, "latest"));
  assertRefused(install(), /Couldn't find the latest version/);

  assertRefused(
    install({ env: { WHISPRFLOW_VERSION: "v1.2.3" } }),
    /Couldn't reach the release package[\s\S]*v1\.2\.3/,
  );
  assertRefused(
    install({ env: { WHISPRFLOW_VERSION: "../../etc" } }),
    /WHISPRFLOW_VERSION doesn't look like a version/,
  );
});

test("the providers the installer checks are the same list as the model vendors registered in the program", async () => {
  const { PROVIDERS } = await import("../../src/server/providers/index.mjs");
  const listed = readFileSync(INSTALLER, "utf8")
    .match(/^MODEL_HOSTS=\((.*)\)$/m)[1]
    .match(/"[^"]*"/g);
  const names = listed.filter((_, index) => index % 2 === 0).map((quoted) => quoted.slice(1, -1));
  assert.deepEqual(
    names,
    PROVIDERS.map(({ name }) => name),
  );
});

test("every provider's reachability is checked: reachable ones get a check, unreachable ones only warn without blocking the install", () => {
  const both = install();
  assert.equal(both.code, 0);
  assert.match(both.out, /✓ Gemini reachable/);
  assert.match(both.out, /✓ OpenAI reachable/);

  const noGemini = install({ env: { FAKE_GEMINI_EXIT: "7" } });
  assert.equal(noGemini.code, 0);
  assert.match(noGemini.out, /! Can't reach Gemini/);
  assert.match(noGemini.out, /✓ OpenAI reachable/);

  const neither = install({ env: { FAKE_GEMINI_EXIT: "7", FAKE_OPENAI_EXIT: "7" } });
  assert.equal(neither.code, 0);
  assert.match(neither.out, /! Can't reach Gemini/);
  assert.match(neither.out, /! Can't reach OpenAI/);
  // What to do is said only once
  assert.equal(neither.out.match(/need a proxy/g)?.length, 1);
  assert.equal(installedVersion(), "9.9.9");
});

test("a downloaded package that differs from the release (checksum fails): not installed, the existing install untouched", () => {
  assert.equal(install().code, 0);
  makeArchive("arm64", "10.0.0");
  writeFileSync(join(release, "v10.0.0", "whisprflow-darwin-arm64.tar.gz.sha256"), `${"0".repeat(64)}  x\n`);
  assertRefused(install(), /Checksum mismatch/);
  assert.equal(installedVersion(), "9.9.9");
  assert.deepEqual(readdirSync(home()).sort(), ["app", "bin", "runtime"]);
});

test("a downloaded program that can't run on this machine: caught before replacing the old one, which stays", () => {
  assert.equal(install().code, 0);
  makeArchive("arm64", "10.0.0");
  assertRefused(install({ env: { FAKE_BROKEN: "1" } }), /won't run on this Mac/);
  assert.equal(installedVersion(), "9.9.9");
});

test("a running copy that can't be stopped: no swap (it still has the old program's files open)", () => {
  assert.equal(install().code, 0);
  makeArchive("arm64", "10.0.0");
  const result = install({ env: { FAKE_STOP_FAILS: "1" } });
  assertRefused(result, /Couldn't stop the running WhisprFlow/);
  assert.equal(installedVersion(), "9.9.9");
});

test("someone else's file already at the link location: left alone, and the user is told to use the full path", () => {
  const theirs = join(userHome, ".local", "bin", "whisprflow");
  mkdirSync(join(theirs, ".."), { recursive: true });
  writeFileSync(theirs, "someone else's");
  const { code, out } = install();
  assert.equal(code, 0);
  assert.match(out, /is another whisprflow; left it alone/);
  assert.equal(readFileSync(theirs, "utf8"), "someone else's");
  assert.equal(existsSync(join(home(), "bin", "links")), false);
});

test("a warning when another whisprflow comes earlier in PATH", () => {
  const other = join(root, "other-bin");
  mkdirSync(other);
  writeFileSync(join(other, "whisprflow"), "#!/bin/sh\n");
  chmodSync(join(other, "whisprflow"), 0o755);
  const { out } = install({ path: `${other}:${join(userHome, ".local", "bin")}:` });
  assert.match(out, /Another whisprflow comes first on your PATH/);
});

test("installing elsewhere (WHISPRFLOW_HOME) works with spaces and quotes in the path; the link can point at another directory", () => {
  const custom = join(root, "my 'own' home");
  const bin = join(root, "bin dir");
  const { code, out } = install({ env: { WHISPRFLOW_HOME: custom, WHISPRFLOW_BIN_DIR: bin } });
  assert.equal(code, 0, out);
  assert.equal(installedVersion(custom), "9.9.9");
  assert.equal(existsSync(home()), false);
  execFileSync(join(bin, "whisprflow"), ["status"], { env: { PATH: "/usr/bin:/bin", FAKE_CALL_LOG: callLog } });
  assert.equal(calls().at(-1), `1|${custom}|2|${join(custom, "app", "bin", "whisprflow.mjs")} status`);
});

test("unknown arguments: nothing installed", () => {
  assertRefused(install({ args: ["--force"] }), /Unknown option: --force/);
  assert.equal(existsSync(home()), false);
});

test("the installer is all English: not a single Han character, comments included", () => {
  const lines = readFileSync(INSTALLER, "utf8").split("\n");
  const han = lines.map((line, index) => [index + 1, line]).filter(([, line]) => /\p{Script=Han}/u.test(line));
  assert.deepEqual(han, []);
});
