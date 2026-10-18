#!/usr/bin/env node
// Packages WhisprFlow as a double-clickable macOS app: dist/WhisprFlow-darwin-<arch>/WhisprFlow.app
// Usage: npm run dist
//
// Starting with the whisprflow command is usually enough. The packaged app differs in that the three system permissions are recorded under "WhisprFlow" itself
// (not the terminal that started it), and it can launch at login.
// The app contains src, the built helper, and runtime dependencies; tests, scripts, and the CLI entry stay out. How it is packaged and signed is in mac-app.mjs.

import { join, resolve } from "node:path";
import { buildHelper } from "../../src/cli/native-helper.mjs";
import { packageMacApp } from "./mac-app.mjs";
import { signingConfig } from "./signing.mjs";

const packageDir = resolve(import.meta.dirname, "../..");
// Read first: a misconfiguration is reported before building and packaging
const signing = signingConfig(packageDir);

buildHelper(packageDir);
const appPath = await packageMacApp({ packageDir, arch: process.arch, out: join(packageDir, "dist"), signing });
const how =
  signing === null
    ? "local signature"
    : `${signing.identity}${signing.notaryProfile ? ", notarized" : ", not notarized"}`;
console.log(`\nPackaged (${how}): ${appPath}`);
