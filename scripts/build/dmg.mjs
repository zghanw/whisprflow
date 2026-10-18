// Puts a signed, notarized WhisprFlow.app into a dmg: opening it shows the app on the left and an Applications alias on the right, drag to install.
// The dmg itself is also signed, notarized by Apple, and stapled: a dmg downloaded by a browser carries the "from the internet" mark, and the system checks this outermost layer first.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * @param {{ appPath: string, dmgPath: string, signing: { identity: string, notaryProfile: string } }} options
 */
export function makeDmg({ appPath, dmgPath, signing }) {
  const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });
  const stage = mkdtempSync(join(tmpdir(), "whisprflow-dmg-"));
  try {
    // ditto copies the app bundle exactly, keeping the signature, ticket, and symbolic links inside
    run("ditto", [appPath, join(stage, basename(appPath))]);
    symlinkSync("/Applications", join(stage, "Applications"));
    run("hdiutil", ["create", "-volname", "WhisprFlow", "-srcfolder", stage, "-format", "UDZO", "-ov", dmgPath]);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }

  run("codesign", ["--sign", signing.identity, "--timestamp", dmgPath]);
  notarize(dmgPath, signing.notaryProfile);
  run("xcrun", ["stapler", "staple", dmgPath]);
  run("xcrun", ["stapler", "validate", dmgPath]);
  // This is the check the system runs when a dmg is double-clicked
  run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose", dmgPath]);
}

/** Submits to Apple for notarization and waits for the result. On failure prints Apple's list of issues, then throws */
function notarize(file, profile) {
  const output = execFileSync(
    "xcrun",
    ["notarytool", "submit", file, "--keychain-profile", profile, "--wait", "--output-format", "json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const result = JSON.parse(output);
  if (result.status === "Accepted") {
    console.log(`Notarized: ${basename(file)} (${result.id})`);
    return;
  }
  execFileSync("xcrun", ["notarytool", "log", result.id, "--keychain-profile", profile], { stdio: "inherit" });
  throw new Error(`${basename(file)} failed notarization: ${result.status} ${result.message ?? ""} (id ${result.id})`);
}
