// Which certificate signs the .app and what notarizes it. Only names are handled here: the certificate's name in the Keychain (MAC_SIGNING_IDENTITY),
// and the profile name given when storing credentials with xcrun notarytool store-credentials (MAC_NOTARY_PROFILE); the keys themselves are never touched.
// Environment variables come first; otherwise the local .machine.env file (KEY=value lines) is read: certificate names contain a person's name and team id, so they stay out of the repository.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/** Entitlements for the main program and helper: V8 needs JIT, dictation needs the microphone. The signing library's default also enables camera, location, photos, and so on, which aren't needed */
export const ENTITLEMENTS = join(import.meta.dirname, "entitlements.plist");

/**
 * @param {string} packageDir the repository root, where .machine.env lives
 * @returns {{ identity: string, notaryProfile: string | null } | null} null: not configured, so a local signature without identity
 */
export function signingConfig(packageDir, env = process.env) {
  const file = join(packageDir, ".machine.env");
  const machine = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  const value = (name) => (env[name] ?? machine[name] ?? "").trim() || null;
  const identity = value("MAC_SIGNING_IDENTITY");
  const notaryProfile = value("MAC_NOTARY_PROFILE");
  if (identity === null) {
    if (notaryProfile !== null) {
      throw new Error(
        "MAC_NOTARY_PROFILE is set but MAC_SIGNING_IDENTITY isn't: notarizing needs a Developer ID signature first",
      );
    }
    return null;
  }
  return { identity, notaryProfile };
}

/**
 * Passed to @electron/packager's osxSign. Hardened runtime and timestamps are on by default in the signing library (notarization requires both).
 * Chromium's helpers (Renderer, GPU, Plugin) get the signing library's defaults, which are modeled on Chrome's
 */
export function osxSignOptions(identity) {
  return {
    identity,
    optionsForFile: (filePath) =>
      /\((Renderer|GPU|Plugin)\)\.app/.test(filePath) ? {} : { entitlements: ENTITLEMENTS },
  };
}
