// Packages WhisprFlow as a macOS app (WhisprFlow.app). Both a local build for yourself (package.mjs) and the per-chip builds for a release
// go through here. The helper must be built first (build/key-helper); this only lays out, packages, and signs.
//
// Signing: with a Developer ID configured (see signing.mjs) it signs with that and enables hardened runtime; with a notary profile too, it is notarized by Apple
// and stapled, so the app opens directly on other Macs and permissions and keys survive repackaging. With neither, it gets a local signature without identity.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packager } from "@electron/packager";
import { osxSignOptions } from "./signing.mjs";
import { APP_ENTRIES, stageApp } from "./stage-app.mjs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/**
 * @param {{ packageDir: string, arch: "arm64" | "x64", out: string, signing: { identity: string, notaryProfile: string | null } | null }} options
 *   packageDir: the repository root; out: the output directory (containing WhisprFlow-darwin-<chip>/WhisprFlow.app)
 * @returns {Promise<string>} the app's path
 */
export async function packageMacApp({ packageDir, arch, out, signing }) {
  const run = (command, args) => execFileSync(command, args, { cwd: packageDir, stdio: "inherit" });
  /** The app name is written once, in productName in package.json: the Keychain entry and the app bundle follow it */
  const appName = readJson(join(packageDir, "package.json")).productName;

  // First lay out "what belongs in the app" in a temporary directory with only runtime dependencies, then package from there
  const staging = mkdtempSync(join(tmpdir(), "whisprflow-package-"));
  let bundleDir;
  try {
    stageApp(packageDir, staging, APP_ENTRIES, arch);
    [bundleDir] = await packager({
      dir: staging,
      out,
      overwrite: true,
      name: appName,
      // Once signed, the system identifies the app by "this id + this certificate's team": permissions and Keychain entries are recorded under it, so never change it
      appBundleId: "com.zghanw.whisprflow",
      appCategoryType: "public.app-category.productivity",
      platform: "darwin",
      arch,
      electronVersion: readJson(join(packageDir, "node_modules/electron/package.json")).version,
      // No asar: the native helper must be directly executable, and page and main process paths stay the same as in development
      asar: false,
      // Dependencies above are already only the runtime part
      prune: false,
      ignore: [/^\/src\/cli($|\/)/, /^\/package-lock\.json$/],
      ...(existsSync(join(packageDir, "assets", "icon.icns")) ? { icon: join(packageDir, "assets", "icon.icns") } : {}),
      extendInfo: {
        // Menu bar only, no Dock icon
        LSUIElement: true,
        NSMicrophoneUsageDescription: "Dictation uses the microphone to record what you say.",
      },
      ...(signing && { osxSign: osxSignOptions(signing.identity) }),
      // Notarization queues at Apple, usually a few minutes; the packaged app is submitted, and the ticket is stapled when it returns
      ...(signing?.notaryProfile && { osxNotarize: { keychainProfile: signing.notaryProfile } }),
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  const appPath = join(bundleDir, `${appName}.app`);
  if (signing === null) {
    // Changing Info.plist and adding resources voids the original signature, and Apple silicon won't open apps without a valid one.
    // This is a local signature without identity: usable only on this machine, and after repackaging the system treats it as another app, so the three permissions must be granted again.
    run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
  }
  run("codesign", ["--verify", "--deep", "--strict", appPath]);
  if (signing?.notaryProfile) {
    // Notarized and stapled apps pass the system's Gatekeeper check even offline
    run("xcrun", ["stapler", "validate", appPath]);
    run("spctl", ["--assess", "--type", "execute", "--verbose", appPath]);
  }
  return appPath;
}
