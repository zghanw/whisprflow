import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { currentUserSid } from "../../src/storage/owner-only.mjs";

// How "only the owner can enter this directory" is checked on each system (the approach is in src/storage/owner-only.mjs):
// macOS checks the permission bits; Windows checks the access control list, which may hold only the owner and SYSTEM, neither inherited from above.

const SYSTEM_SID = "S-1-5-18";

/** A directory's access control list: who each entry is (SID) and whether it is inherited */
function aclOf(path) {
  const script = `(Get-Acl -LiteralPath '${path.replace(/'/g, "''")}').Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value + '|' + $_.IsInherited }`;
  const output = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sid, inherited] = line.split("|");
      return { sid, inherited: inherited === "True" };
    });
}

export function assertOwnerOnlyDir(path) {
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o777, 0o700);
    return;
  }
  const entries = aclOf(path);
  const allowed = new Set([currentUserSid(), SYSTEM_SID]);
  assert.ok(entries.length > 0, `${path} has an empty access control list`);
  for (const { sid, inherited } of entries) {
    assert.ok(allowed.has(sid), `${path} still has someone else's entry: ${sid}`);
    assert.equal(inherited, false, `${path} still has an entry inherited from above: ${sid}`);
  }
}
