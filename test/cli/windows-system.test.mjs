import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { isOurShortcut, removeLoginItem, removePathEntry } from "../../src/cli/windows-system.mjs";

const windowsOnly = { skip: process.platform !== "win32" && "needs PowerShell on Windows" };

test(
  "removal after exit: the calling process exits at once, and the directories are still removed after it does",
  windowsOnly,
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "wf-winsys-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const doomed = join(dir, "runtime.old.test");
    mkdirSync(doomed);
    writeFileSync(join(doomed, "electron.exe"), "");
    // Like whisprflow uninstall and update: hand off, then exit at once. On Windows Node reaps child processes it started directly when it exits
    const script = join(dir, "caller.mjs");
    const module = pathToFileURL(join(import.meta.dirname, "../../src/cli/windows-system.mjs")).href;
    writeFileSync(
      script,
      `import { removeAfterExit } from ${JSON.stringify(module)};\nremoveAfterExit([process.argv[2]]);\n`,
    );
    execFileSync(process.execPath, [script, doomed]);
    // Two PowerShell starts plus the wait take about two seconds on real hardware; the whole file has 5 seconds (--test-timeout)
    for (let waited = 0; existsSync(doomed) && waited < 4000; waited += 100) await delay(100);
    assert.equal(existsSync(doomed), false, "the directory still exists 4 seconds after the caller exited");
  },
);

test(
  "when an entry doesn't exist it says so honestly without erroring: no login item or Path entry for this home",
  windowsOnly,
  () => {
    // The home is made up: the real installation's login item and Path entry are never touched (only entries pointing at this home are removed)
    const home = join(tmpdir(), "wf-winsys-nowhere", ".whisprflow");
    assert.equal(removeLoginItem(home), false);
    assert.equal(removePathEntry(join(home, "bin")), false);
  },
);

test(
  "whether a shortcut is ours goes by the target Windows reads back; only one pointing at this home's runtime counts (non-ASCII paths too)",
  windowsOnly,
  (t) => {
    const dir = mkdtempSync(join(tmpdir(), "wf-caf\u00e9-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const home = join(dir, "Jos\u00e9", ".whisprflow");
    const make = (name, target) => {
      const file = join(dir, name);
      // Created with WScript.Shell like Add-Shortcut in install.ps1; the target needn't exist
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK); $s.TargetPath = $env:TARGET; $s.Arguments = $env:ARGS; $s.Save()",
        ],
        { env: { ...process.env, LNK: file, TARGET: target, ARGS: `"${join(home, "app")}"` } },
      );
      return file;
    };
    assert.equal(isOurShortcut(make("ours.lnk", join(home, "runtime", "electron.exe")), home), true);
    assert.equal(isOurShortcut(make("theirs.lnk", join(dir, "other", "runtime", "electron.exe")), home), false);
    assert.equal(isOurShortcut(join(dir, "missing.lnk"), home), false);
  },
);
