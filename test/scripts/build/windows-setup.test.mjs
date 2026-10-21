import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { buildWindowsSetup, fileVersion, SETUP_MAGIC, setupTrailer } from "../../../scripts/build/windows-setup.mjs";
import { tarCommand } from "../../../src/models/runtime.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-setup-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("trailer: an 8-byte marker plus the zip's 8-byte little-endian length, as native/windows-setup/payload.go reads it", () => {
  const trailer = setupTrailer(0x0102030405);
  assert.equal(trailer.length, 16);
  assert.equal(trailer.subarray(0, 8).toString("ascii"), SETUP_MAGIC);
  assert.equal(trailer.readBigUInt64LE(8), 0x0102030405n);
});

test("the file version only takes four numbers: a prerelease takes the first three", () => {
  assert.equal(fileVersion("0.9.0"), "0.9.0.0");
  assert.equal(fileVersion("0.9.0-rc.1"), "0.9.0.0");
});

test("layout: the program first, then a stored zip (install.ps1, and the package, checksum, and latest laid out like the download address), then the trailer; build-time resource files don't stay", () => {
  const packageDir = join(dir, "repo");
  const source = join(packageDir, "native", "windows-setup");
  mkdirSync(source, { recursive: true });
  mkdirSync(join(packageDir, "assets"));
  writeFileSync(join(packageDir, "install.ps1"), "& { 'install' }\n");
  const archive = join(dir, "whisprflow-win32-x64.zip");
  writeFileSync(archive, "program package");
  writeFileSync(`${archive}.sha256`, "abc  whisprflow-win32-x64.zip\n");
  const calls = [];
  // Fake go and tar: record how they were called and write the files they should produce
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[1]?.startsWith("github.com/tc-hib/go-winres"))
      writeFileSync(join(source, "rsrc_windows_amd64.syso"), "resources");
    if (args[0] === "build") writeFileSync(args[args.indexOf("-o") + 1], "MZ installer");
    if (command === tarCommand()) {
      const staged = options.cwd;
      // Everything staged is there: the zip below builds a "package" from their contents
      const content = [
        "install.ps1",
        "latest/download/latest",
        "download/v0.9.0/whisprflow-win32-x64.zip",
        "download/v0.9.0/whisprflow-win32-x64.zip.sha256",
      ]
        .map((name) => `${name}=${readFileSync(join(staged, name), "utf8")}`)
        .join("|");
      writeFileSync(
        args.find((arg) => arg.endsWith(".zip")),
        content,
      );
    }
  };
  const out = join(dir, "WhisprFlow-Setup-x64.exe");
  buildWindowsSetup({ packageDir, version: "0.9.0", versionDir: "v0.9.0", archive, out, run });

  const winres = calls.find(({ args }) => args[1]?.startsWith("github.com/tc-hib/go-winres"));
  assert.ok(winres.args.includes("--manifest") && winres.args[winres.args.indexOf("--manifest") + 1] === "cli");
  assert.ok(!winres.args.includes("--admin"), "no administrator rights");
  assert.equal(winres.options.env?.GOOS, undefined, "go-winres is a tool run on this machine, not cross-compiled");
  const build = calls.find(({ args }) => args[0] === "build");
  assert.equal(build.options.env.GOOS, "windows");
  const zip = calls.find(({ command }) => command === tarCommand());
  assert.ok(
    zip.args.includes("zip:compression=store"),
    "stored, not compressed: the program package is already compressed",
  );

  const bytes = readFileSync(out);
  const program = Buffer.from("MZ installer");
  assert.deepEqual(bytes.subarray(0, program.length), program);
  const trailer = bytes.subarray(bytes.length - 16);
  assert.equal(trailer.subarray(0, 8).toString("ascii"), SETUP_MAGIC);
  const payloadLength = Number(trailer.readBigUInt64LE(8));
  assert.equal(program.length + payloadLength + 16, bytes.length);
  const payload = bytes.subarray(program.length, program.length + payloadLength).toString();
  assert.equal(
    payload,
    "install.ps1=& { 'install' }\n|latest/download/latest=v0.9.0\n|download/v0.9.0/whisprflow-win32-x64.zip=program package|download/v0.9.0/whisprflow-win32-x64.zip.sha256=abc  whisprflow-win32-x64.zip\n",
  );
  assert.equal(existsSync(join(source, "rsrc_windows_amd64.syso")), false);
});
