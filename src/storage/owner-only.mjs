import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";

// Makes a directory accessible to its owner only: it holds recordings and keys. Files created inside follow the directory, so none need setting one by one.
//   macOS: permission bits 700.
//   Windows: permission bits mean nothing (chmod only toggles read-only), so the directory's access control list changes instead: inherited entries
//     are removed, leaving only the owner and SYSTEM, which files and subdirectories below inherit. Account names change with the system language, so SIDs are used.
//     Under the user profile the inherited entries are already close to this (owner, SYSTEM, Administrators), but WHISPRFLOW_HOME
//     can point at another drive, where the Users group can usually read.

/** The SYSTEM account. System services (backup, antivirus) still need to read; removing it causes odd problems */
const SYSTEM_SID = "S-1-5-18";

/**
 * A Windows system tool by full path. A bare name can resolve to another program first on PATH:
 * Git Bash ships its own whoami, which doesn't take /user
 */
const systemTool = (name) => join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);

/** The current user's SID: whoami /user in CSV prints "machine\user","S-1-5-21-..." */
export function currentUserSid(run = execFileSync) {
  const line = run(systemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
  const sid = line.trim().split(",").at(-1)?.replace(/"/g, "");
  if (!sid?.startsWith("S-1-")) throw new Error(`whoami /user gave no SID: ${JSON.stringify(line.slice(0, 200))}`);
  return sid;
}

/**
 * @param {string} dir a directory that already exists
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform]
 * @param {typeof execFileSync} [options.run] replaced in tests
 */
export function restrictToOwner(dir, { platform = process.platform, run = execFileSync } = {}) {
  if (platform !== "win32") {
    chmodSync(dir, 0o700);
    return;
  }
  const grant = (sid) => `*${sid}:(OI)(CI)F`;
  // /inheritance:r removes inherited entries, /grant:r makes these two the only ones (running it again gives the same result)
  run(systemTool("icacls.exe"), [dir, "/inheritance:r", "/grant:r", grant(currentUserSid(run)), grant(SYSTEM_SID)], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
}
