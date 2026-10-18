import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { buildHelper, ensureHelper, helperNeedsBuild, helperPaths } from "../../src/cli/native-helper.mjs";

// These check the macOS layout (paths joined POSIX style); the Windows version is checked separately below
const paths = helperPaths("/pkg", "darwin");
const SOURCE = "print(1)";
/** A fake file system: path to content; missing files read as null */
const filesOf = (files) => (file) => (file in files ? Buffer.from(files[file]) : null);
const stampOf = (source) => createHash("sha256").update(source).digest("hex");
/** The fake file system has no directories */
const noDirs = () => null;

/** Every external action the build uses is replaced by a record */
function fakeBuild(run) {
  const build = {
    written: {},
    removed: [],
    options: {
      run,
      mkdir: () => {},
      read: filesOf({ [paths.source]: SOURCE }),
      list: () => null,
      platform: "darwin",
      write: (file, content) => {
        build.written[file] = content;
      },
      remove: (file) => build.removed.push(file),
    },
  };
  return build;
}

test("where the executable, the sources, and the fingerprint file are", () => {
  assert.deepEqual(paths, {
    source: join("/pkg", "native", "main.swift"),
    binary: join("/pkg", "build", "key-helper"),
    stamp: join("/pkg", "build", "key-helper.source-sha256"),
  });
});

test("no executable means a build is needed", () => {
  assert.equal(helperNeedsBuild(paths, filesOf({ [paths.source]: SOURCE }), noDirs), true);
});

test("an executable built from the current sources needs no rebuild", () => {
  const files = { [paths.source]: SOURCE, [paths.binary]: "x", [paths.stamp]: `${stampOf(SOURCE)}\n` };
  assert.equal(helperNeedsBuild(paths, filesOf(files), noDirs), false);
});

test("changed sources, or not knowing which sources the executable came from, means a rebuild", () => {
  const built = { [paths.binary]: "x", [paths.stamp]: stampOf(SOURCE) };
  assert.equal(helperNeedsBuild(paths, filesOf({ ...built, [paths.source]: "print(2)" }), noDirs), true);
  assert.equal(helperNeedsBuild(paths, filesOf({ [paths.source]: SOURCE, [paths.binary]: "x" }), noDirs), true);
});

test("an executable without sources is used as is", () => {
  assert.equal(helperNeedsBuild(paths, filesOf({ [paths.binary]: "x" }), noDirs), false);
});

test("normally only this machine's architecture is built, recording which sources it came from", () => {
  const calls = [];
  const build = fakeBuild((command, args) => calls.push([command, ...args]));
  buildHelper("/pkg", build.options);
  assert.deepEqual(calls, [["swiftc", "-O", "-o", paths.binary, paths.source]]);
  assert.deepEqual(build.written, { [paths.stamp]: `${stampOf(SOURCE)}\n` });
});

test("a release builds one per chip and merges them into one file, deleting the intermediate files", () => {
  const calls = [];
  const build = fakeBuild((command, args) => calls.push([command, ...args]));
  buildHelper("/pkg", { ...build.options, universal: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.slice(0, 2).map((call) => call[call.indexOf("-target") + 1]),
    ["arm64-apple-macos12.0", "x86_64-apple-macos12.0"],
  );
  assert.deepEqual(calls[2], [
    "lipo",
    "-create",
    "-output",
    paths.binary,
    `${paths.binary}-arm64`,
    `${paths.binary}-x86_64`,
  ]);
  assert.deepEqual(build.removed, [`${paths.binary}-arm64`, `${paths.binary}-x86_64`]);
  assert.deepEqual(Object.keys(build.written), [paths.stamp]);
});

test("without the build tools it says what to install; a failed build leaves no fingerprint, so the next run doesn't think it is built", () => {
  const build = fakeBuild(() => {
    throw Object.assign(new Error("spawnSync swiftc ENOENT"), { code: "ENOENT" });
  });
  assert.throws(() => buildHelper("/pkg", build.options), /xcode-select --install/);
  assert.deepEqual(build.written, {});
});

test("a build error passes on what the compiler said", () => {
  const build = fakeBuild(() => {
    throw Object.assign(new Error("Command failed"), {
      status: 1,
      stderr: Buffer.from("main.swift:3: error: cannot find name in scope"),
    });
  });
  assert.throws(() => buildHelper("/pkg", build.options), /cannot find name in scope/);
});

test("ensureHelper builds only when needed, says so before starting, and reports whether it built", () => {
  const calls = [];
  const said = [];
  const build = fakeBuild((command) => calls.push(command));
  const onBuild = () => said.push("building");
  const upToDate = filesOf({ [paths.source]: SOURCE, [paths.binary]: "x", [paths.stamp]: stampOf(SOURCE) });

  assert.equal(ensureHelper("/pkg", { ...build.options, read: upToDate, onBuild }), false);
  assert.deepEqual([calls, said], [[], []]);
  assert.equal(ensureHelper("/pkg", { ...build.options, onBuild }), true);
  assert.deepEqual([calls, said], [["swiftc"], ["building"]]);
});

// ---------- Windows: native/windows/ is a Go module, cross-compiled on a Mac ----------

const win = helperPaths("C:/pkg", "win32");
const GO_FILES = {
  "go.mod": "module whisprflow/keyhelper\n",
  "main_windows.go": "package main",
  "keys.go": "package main",
};
/** A fake native/windows directory: a few Go files plus a test file (test files aren't part of the fingerprint) */
const goModule = (files = GO_FILES) => ({
  read: filesOf(Object.fromEntries(Object.entries(files).map(([name, content]) => [join(win.source, name), content]))),
  list: (dir) => (dir === win.source ? [...Object.keys(files), "keys_test.go"] : null),
});

test("Windows: the executable is build/key-helper.exe and the sources are the native/windows Go module", () => {
  assert.deepEqual(win, {
    source: join("C:/pkg", "native", "windows"),
    binary: join("C:/pkg", "build", "key-helper.exe"),
    stamp: join("C:/pkg", "build", "key-helper.exe.source-sha256"),
  });
});

test("Windows: on a Mac the bundled Go cross-compiles a windowless exe and records the sources' fingerprint", () => {
  const calls = [];
  const written = {};
  const { read, list } = goModule();
  buildHelper("C:/pkg", {
    platform: "win32",
    host: "darwin",
    run: (command, args, options) => calls.push({ command, args, cwd: options.cwd, env: options.env }),
    mkdir: () => {},
    read,
    list,
    write: (file, content) => {
      written[file] = content;
    },
  });
  assert.equal(calls.length, 1);
  const [{ command, args, cwd, env }] = calls;
  assert.equal(command, join("C:/pkg", "scripts", "build", "go.sh"));
  assert.deepEqual(args, ["build", "-trimpath", "-ldflags", "-s -w -H windowsgui", "-o", win.binary, "."]);
  assert.equal(cwd, win.source);
  assert.deepEqual([env.GOOS, env.GOARCH, env.CGO_ENABLED], ["windows", "amd64", "0"]);
  assert.deepEqual(Object.keys(written), [win.stamp]);
  // Once built no rebuild is needed; changing any Go file needs one, changing a test file doesn't
  const built = (files) => {
    const module = goModule(files);
    return (file) =>
      file === win.binary
        ? Buffer.from("exe")
        : file === win.stamp
          ? Buffer.from(written[win.stamp])
          : module.read(file);
  };
  assert.equal(helperNeedsBuild(win, built(GO_FILES), list), false);
  assert.equal(helperNeedsBuild(win, built({ ...GO_FILES, "keys.go": "package main // changed" }), list), true);
});

test("Windows: running from source on Windows uses the installed go; without it, it says to install Go", () => {
  const { read, list } = goModule();
  const calls = [];
  const options = { platform: "win32", host: "win32", mkdir: () => {}, read, list, write: () => {} };
  buildHelper("C:/pkg", { ...options, run: (command) => calls.push(command) });
  assert.deepEqual(calls, ["go"]);
  const missing = () => {
    throw Object.assign(new Error("spawnSync go ENOENT"), { code: "ENOENT" });
  };
  assert.throws(() => buildHelper("C:/pkg", { ...options, run: missing }), /Go 1\.27/);
});
