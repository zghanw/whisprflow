#!/usr/bin/env node
// Builds the native helper.
// Usage: npm run build:native              this machine only (on macOS native/main.swift to build/key-helper, this architecture)
//       node scripts/build/build-native.mjs --universal   both macOS chips merged (what release builds use)
//       node scripts/build/build-native.mjs --windows     the Windows one (native/windows to build/key-helper.exe), cross-compiled on a Mac
import { resolve } from "node:path";
import { buildHelper, helperPaths } from "../../src/cli/native-helper.mjs";

const packageDir = resolve(import.meta.dirname, "../..");
const platform = process.argv.includes("--windows") ? "win32" : process.platform;
try {
  buildHelper(packageDir, { platform, universal: process.argv.includes("--universal") });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
console.log(`Built: ${helperPaths(packageDir, platform).binary}`);
