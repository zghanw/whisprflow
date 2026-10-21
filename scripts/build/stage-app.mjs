// Lays out "what a program installed on someone else's machine needs" in a temporary directory: code, the built helper, runtime dependencies.
// Packaging the .app (package.mjs) and release packages both start here.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const NPM_FLAGS = ["--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"];
/** The system doing the packaging (the package itself may be for another) */
const platformOfThisMachine = process.platform;

/**
 * The directories the background app reads from the repository at run time: code, the built helper, icons.
 * The .app gets only these; release packages also carry the CLI entry and licenses. Tests point out anything missing (test/scripts/build)
 */
export const APP_ENTRIES = ["src", "build", "assets"];

/**
 * Packages installed but never loaded by the program aren't distributed with it. @audio/decode-webm declares dependencies on other decoders (AAC, AC-3, DTS,
 * E-AC-3, FLAC, MP3, Opus, Vorbis), of which AAC, AC-3, and DTS are GPL and E-AC-3 is LGPL, incompatible with this project's MIT license;
 * and its bundled code only uses its own Opus decoder. codec-parser (LGPL) splits Ogg, which the program never converts (see src/server/audio/transcode.mjs).
 * Moving these out was tested: WebM still converts (test/server/audio).
 */
export const UNUSED_PACKAGES = [
  "@audio/decode-aac",
  "@audio/decode-ac3",
  "@audio/decode-dts",
  "@audio/decode-eac3",
  "@audio/decode-flac",
  "@audio/decode-mp3",
  "@audio/decode-opus",
  "@audio/decode-vorbis",
  "codec-parser",
];

/** Deletes the empty directories under dir, deepest first. In Node rather than find: on Windows, find is a different program */
function removeEmptyDirectories(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirectories(join(dir, entry.name));
  }
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}

export function pruneUnused(stagingDir) {
  for (const name of UNUSED_PACKAGES) rmSync(join(stagingDir, "node_modules", name), { recursive: true, force: true });
}

/** Whether an SPDX license expression can only be used under the GPL family (GPL, LGPL, AGPL). "MIT OR GPL-3.0" allows choosing MIT, so it doesn't count */
function copyleftOnly(license) {
  const alternatives = license.replace(/[()]/g, "").split(/\s+OR\s+/i);
  return alternatives.every((alternative) => /GPL/i.test(alternative));
}

/** The license in package.json. The old form is an object or a list of objects */
function licenseOf(manifest) {
  const { license, licenses } = manifest;
  if (typeof license === "string") return license;
  if (license?.type) return license.type;
  if (Array.isArray(licenses)) return licenses.map((entry) => entry.type ?? entry).join(" OR ");
  return null;
}

/**
 * Finds packages in node_modules (nested ones included) usable only under GPL-family licenses, or with no license at all.
 * What a machine can check shouldn't wait for a person: anything slipped in with a new dependency is stopped at packaging.
 * @returns {{ name: string, license: string }[]}
 */
export function findCopyleft(nodeModulesDir) {
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        visit(path);
        continue;
      }
      const manifestFile = join(path, "package.json");
      if (existsSync(manifestFile)) {
        const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
        const license = licenseOf(manifest);
        if (license === null || copyleftOnly(license))
          found.push({ name: manifest.name, license: license ?? "(none)" });
      }
      if (existsSync(join(path, "node_modules"))) visit(join(path, "node_modules"));
    }
  };
  visit(nodeModulesDir);
  return found;
}

/** Built helpers in build are per system (src/cli/native-helper.mjs); only the one for the target system is packaged */
export const HELPER_FILES = {
  darwin: ["key-helper", "key-helper.source-sha256"],
  win32: ["key-helper.exe", "key-helper.exe.source-sha256"],
};

/**
 * @param {string} packageDir the source repository
 * @param {string} stagingDir where to lay it out. Must be an empty directory
 * @param {string[]} entries what else to copy from the repository besides package.json and the lock file
 * @param {"arm64" | "x64"} arch which chip it is for
 * @param {"darwin" | "win32"} [platform] which system it is for
 */
export function stageApp(packageDir, stagingDir, entries, arch, platform = "darwin") {
  for (const entry of ["package.json", "package-lock.json", ...entries]) {
    cpSync(join(packageDir, entry), join(stagingDir, entry), { recursive: true });
  }
  // Of build, only this system's helper goes out: helpers for other systems stay out, and so does anything else built there on this machine
  if (entries.includes("build")) {
    for (const name of readdirSync(join(stagingDir, "build"))) {
      if (!HELPER_FILES[platform].includes(name))
        rmSync(join(stagingDir, "build", name), { recursive: true, force: true });
    }
  }
  // On-device transcription runtimes come as one package with native libraries per system and chip (optionalDependencies), and npm installs only this machine's by default:
  // when packaging for Intel or Windows on an Apple silicon Mac, say which to install, or the local one goes in and fails to load over there
  const target = [`--os=${platform}`, `--cpu=${arch}`];
  // As an npm script, npm's own entry runs on this Node (npm_execpath); otherwise the npm command, which on Windows is npm.cmd and needs a shell
  const [command, prefix] = process.env.npm_execpath ? [process.execPath, [process.env.npm_execpath]] : ["npm", []];
  const npm = (args) =>
    execFileSync(command, [...prefix, ...args, ...target, ...NPM_FLAGS], {
      cwd: stagingDir,
      stdio: "inherit",
      shell: !process.env.npm_execpath && platformOfThisMachine === "win32",
    });
  // Not handing the source repository to the packager to prune dev dependencies: it was seen to prune incompletely, bringing in the linter's tens-of-MB executable
  npm(["ci"]);
  // The electron dependency lets people running from source find a runtime. The installed program has its own runtime, so it and its downloader stay out
  // (--omit=dev here too: without it uninstall would reinstall all the dev dependencies)
  npm(["uninstall", "electron"]);
  pruneUnused(stagingDir);
  // Uninstalling leaves a few empty directories behind (node_modules/@electron and the like)
  removeEmptyDirectories(join(stagingDir, "node_modules"));
  const copyleft = findCopyleft(join(stagingDir, "node_modules"));
  if (copyleft.length > 0) {
    const listed = copyleft.map(({ name, license }) => `${name} (${license})`).join(", ");
    throw new Error(
      `The program includes packages whose licenses are incompatible with MIT, or have no license; check before releasing: ${listed}`,
    );
  }
}
