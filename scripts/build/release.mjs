#!/usr/bin/env node
// Builds the Windows release into dist/release, laid out the way GitHub Releases serves it:
//   download/v<version>/   the files to attach to the GitHub release v<version>:
//                          whisprflow-win32-x64.zip (the program and its Electron runtime), its .sha256, WhisprFlow-Setup-x64.exe,
//                          install.ps1, install.sh, and latest (one line, this version)
//   latest/download/       the same files again, as GitHub serves the newest release's: with this folder as WHISPRFLOW_INSTALL_BASE,
//                          install.ps1 installs from it exactly as it would from GitHub
// Usage: npm run release   (on Windows; the version comes from package.json)
//
// The macOS packages (npm run dist, scripts/build/dmg.mjs) are built on a Mac and aren't part of this script.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { downloadArtifact } from "@electron/get";
import { buildHelper } from "../../src/cli/native-helper.mjs";
import { tarCommand } from "../../src/models/runtime.mjs";
import { APP_ENTRIES, stageApp } from "./stage-app.mjs";
import { buildWindowsSetup } from "./windows-setup.mjs";

/** What the installed program needs besides what the background app reads: the CLI entry and the licenses */
const RELEASE_ENTRIES = [...APP_ENTRIES, "bin", "LICENSE", "THIRD_PARTY_NOTICES.md"];
const ARCHIVE = "whisprflow-win32-x64.zip";
const SETUP = "WhisprFlow-Setup-x64.exe";

if (process.platform !== "win32") {
  console.error(
    "The Windows release is built on Windows (the helper, the setup program, and the runtime are Windows builds).",
  );
  process.exit(2);
}

const packageDir = resolve(import.meta.dirname, "../..");
const { version, dependencies } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const versionDir = `v${version}`;
const out = join(packageDir, "dist", "release");
const files = join(out, "download", versionDir);
rmSync(out, { recursive: true, force: true });
mkdirSync(files, { recursive: true });

const staging = mkdtempSync(join(tmpdir(), "whisprflow-release-"));
try {
  console.log(`Building WhisprFlow ${versionDir} for Windows (x64)`);
  buildHelper(packageDir, { platform: "win32" });
  const app = join(staging, "app");
  mkdirSync(app);
  stageApp(packageDir, app, RELEASE_ENTRIES, "x64", "win32");

  // The runtime: Electron's own Windows build, the version the app is developed against, checked against Electron's published checksums
  const electronZip = await downloadArtifact({
    version: dependencies.electron,
    platform: "win32",
    arch: "x64",
    artifactName: "electron",
  });
  const runtime = join(staging, "runtime");
  mkdirSync(runtime);
  execFileSync(tarCommand(), ["-xf", electronZip, "-C", runtime]);

  const archive = join(files, ARCHIVE);
  execFileSync(tarCommand(), ["--format", "zip", "-cf", archive, "-C", staging, "app", "runtime"]);
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(`${archive}.sha256`, `${digest}  ${ARCHIVE}\n`);
  // With LF line ends whatever the checkout has (git on Windows may convert to CRLF): bash on macOS can't run a script with CRLF
  for (const script of ["install.ps1", "install.sh"]) {
    writeFileSync(join(files, script), readFileSync(join(packageDir, script), "utf8").replaceAll("\r\n", "\n"));
  }
  writeFileSync(join(files, "latest"), `${versionDir}\n`);
  buildWindowsSetup({ packageDir, version, versionDir, archive, out: join(files, SETUP) });

  cpSync(files, join(out, "latest", "download"), { recursive: true });
  console.log(`\nReleased ${versionDir} into ${out}`);
  console.log(`Attach the files in ${files} to the GitHub release ${versionDir}.`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
