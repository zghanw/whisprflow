import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

// The parts of Windows the CLI has to touch: what install.ps1 left outside the home directory (an entry in the user Path, the Start menu shortcut)
// and launch at login turned on in the app, removed on uninstall; plus the fact that running programs can't be deleted. All done through PowerShell, with values passed in environment variables,
// so no outside text is spliced into scripts. Not used on macOS.

/**
 * Runs a PowerShell snippet and returns its standard output. Errors stop it with a nonzero exit (execFileSync throws); a normal run exits with an explicit 0:
 * otherwise -Command's exit code follows the last command, and an expected case like "entry not found" would become 1
 */
function powershell(script, env = {}) {
  const wrapped = `$ErrorActionPreference = 'Stop'\n${script}\nexit 0`;
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", wrapped], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...env },
  });
}

/**
 * Removes this entry from the user Path (the one install.ps1 added, recorded as is in bin\links). Reads and writes it raw: reading doesn't expand
 * forms like %USERPROFILE%, so what is written back stays expandable; afterwards it sets an environment variable so the system broadcasts the change
 * @returns {boolean} whether it existed
 */
export function removePathEntry(entry) {
  const output = powershell(
    `$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
     $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
     $entries = @($raw -split ';' | Where-Object { $_ })
     $kept = @($entries | Where-Object { $_ -ine $env:WHISPRFLOW_PATH_ENTRY })
     if ($kept.Count -ne $entries.Count) {
       $key.SetValue('Path', ($kept -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
       [Environment]::SetEnvironmentVariable('WHISPRFLOW_PATH_CHANGED', '1', 'User')
       [Environment]::SetEnvironmentVariable('WHISPRFLOW_PATH_CHANGED', $null, 'User')
       'removed'
     }
     $key.Dispose()`,
    { WHISPRFLOW_PATH_ENTRY: entry },
  );
  return output.trim() === "removed";
}

/**
 * Whether this shortcut points at the program in this home directory. Entries in the list are rechecked before uninstalling: something else may be at that location now.
 * Windows reads the target itself (WScript.Shell): a .lnk file doesn't store one continuous path (the local-encoding copy is split into pieces,
 * and the UTF-16 copy is relative), so searching the bytes doesn't find it. The comparison also happens in PowerShell, so paths never pass through the console encoding
 */
export function isOurShortcut(file, home) {
  if (!existsSync(file)) return false;
  const output = powershell(
    `$target = (New-Object -ComObject WScript.Shell).CreateShortcut($env:WHISPRFLOW_SHORTCUT).TargetPath
     if ($target.StartsWith("$env:WHISPRFLOW_HOME_DIR\\runtime\\", [StringComparison]::OrdinalIgnoreCase)) { 'ours' }`,
    { WHISPRFLOW_SHORTCUT: file, WHISPRFLOW_HOME_DIR: home },
  );
  return output.trim() === "ours";
}

const RUN_KEYS = [
  "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
  "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run",
];

/**
 * Removes launch at login (turned on in the app's settings; Electron records it under Run in the registry, named WhisprFlow). Only the entry pointing at this home directory is removed
 * @returns {boolean} whether it existed
 */
export function removeLoginItem(home) {
  const output = powershell(
    `$run = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'WhisprFlow' -ErrorAction SilentlyContinue
    # Match the home directory literally (not -like: [ ] in the path would be treated as wildcards)
     if ($run -and $run.WhisprFlow.IndexOf("$env:WHISPRFLOW_HOME_DIR\\runtime\\", [StringComparison]::OrdinalIgnoreCase) -ge 0) {
       foreach ($key in $env:WHISPRFLOW_RUN_KEYS.Split([char]10)) { Remove-ItemProperty -Path $key -Name 'WhisprFlow' -ErrorAction SilentlyContinue }
       'removed'
     }`,
    { WHISPRFLOW_HOME_DIR: home, WHISPRFLOW_RUN_KEYS: RUN_KEYS.join("\n") },
  );
  return output.trim() === "removed";
}

/**
 * Deletes these directories after this process exits. On Windows running programs can't be deleted, and during uninstall and update the running one is this command itself
 * (the installed Electron): a hidden PowerShell waits for it to exit, waits a moment more, then deletes, leaving no window.
 * It must be started one level removed: on Windows Node puts directly started children in a job object that ends them all when it exits, so it would vanish as soon as this command exits;
 * detached avoids that, but PowerShell started that way has no console and exits with 0 without running a line (both tried on real hardware).
 * So a PowerShell runs synchronously first and Start-Process launches the worker: a grandchild isn't in that job object
 */
export function removeAfterExit(dirs, pid = process.pid) {
  const cleanup = `Wait-Process -Id $env:WHISPRFLOW_WAIT_PID -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800
foreach ($dir in $env:WHISPRFLOW_REMOVE.Split([char]10)) { if ($dir) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue } }`;
  powershell(
    "Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand',$env:WHISPRFLOW_CLEANUP",
    {
      WHISPRFLOW_WAIT_PID: String(pid),
      WHISPRFLOW_REMOVE: dirs.join("\n"),
      WHISPRFLOW_CLEANUP: Buffer.from(cleanup, "utf16le").toString("base64"),
    },
  );
}
