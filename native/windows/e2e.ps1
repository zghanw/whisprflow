# Real-machine check of the Windows helper: starts key-helper.exe in a desktop session, simulates keys and clicks with SendInput, checks the events it reports,
# then pastes text into Notepad and reads it back. Must run on a desktop with a signed-in user (from a PowerShell window there: powershell -File e2e.ps1).
# A Notepad window pops up and gets text pasted in, closing itself at the end; whatever was in the clipboard is still there afterwards.
# Notepad's text is read back by select all and copy (Ctrl combinations bypass input methods); letters aren't typed: with an IME on (like Pinyin), they would go into the candidate window.
# Not checked: whether pressing right Alt alone summons the menu bar (the new Notepad has no classic menu to check); try that by hand in an app like Office.
$ErrorActionPreference = 'Stop'
$repo = "$HOME\whisprflow-dev\repo"

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Fake {
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public KEYBDINPUT k; [FieldOffset(0)] public MOUSEINPUT m; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  // The hook reports physical pixels; without declaring this, the process sees screen sizes scaled by the display scaling, and the two don't match
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static void Key(ushort vk, bool down) {
    var input = new INPUT { type = 1 };
    input.u.k = new KEYBDINPUT { vk = vk, flags = down ? 0u : 2u };
    SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
  }
  // Physical screen pixels to SendInput's absolute coordinates (0..65535), on the primary screen
  public static void Click(int x, int y, bool down) {
    var input = new INPUT { type = 0 };
    int dx = x * 65535 / (GetSystemMetrics(0) - 1), dy = y * 65535 / (GetSystemMetrics(1) - 1);
    input.u.m = new MOUSEINPUT { dx = dx, dy = dy, flags = 0x8001u | (down ? 0x2u : 0x4u) };
    SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@

[Fake]::SetProcessDPIAware() | Out-Null
$results = [System.Collections.Generic.List[string]]::new()
function Check($name, $ok, $detail) {
  $results.Add(("{0} {1}{2}" -f ($(if ($ok) { 'PASS' } else { 'FAIL' })), $name, $(if ($detail) { ": $detail" } else { '' })))
}

function Start-Helper($key) {
  $info = [System.Diagnostics.ProcessStartInfo]::new("$repo\build\key-helper.exe", "--key $key")
  $info.UseShellExecute = $false
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.StandardOutputEncoding = [Text.Encoding]::UTF8
  $process = [System.Diagnostics.Process]::Start($info)
  $queue = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
  $reader = Register-ObjectEvent -InputObject $process -EventName OutputDataReceived -MessageData $queue -Action {
    if ($EventArgs.Data) { $Event.MessageData.Enqueue($EventArgs.Data) }
  }
  $process.BeginOutputReadLine()
  [pscustomobject]@{ Process = $process; Queue = $queue; Reader = $reader }
}

# Waits for the next event (JSON parsed); $null if none arrives
function Next-Event($helper, $ms = 1500) {
  $deadline = (Get-Date).AddMilliseconds($ms)
  $line = $null
  while ((Get-Date) -lt $deadline) {
    if ($helper.Queue.TryDequeue([ref]$line)) { return $line | ConvertFrom-Json }
    Start-Sleep -Milliseconds 20
  }
  return $null
}
function Drain($helper) { $line = $null; while ($helper.Queue.TryDequeue([ref]$line)) {} }
# Write UTF-8: 5.1's StandardInput uses the system code page, while the parent (Node) writes UTF-8
function Send($helper, $object) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($object | ConvertTo-Json -Compress -Depth 5) + "`n")
  $helper.Process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
  $helper.Process.StandardInput.BaseStream.Flush()
}

$VK_RCONTROL = 0xA3; $VK_RMENU = 0xA5; $VK_ESCAPE = 0x1B; $VK_A = 0x41; $VK_CONTROL = 0x11

$saved = Get-Clipboard -Raw
$helper = Start-Helper 'right_ctrl'
try {
  $ready = Next-Event $helper 3000
  Check 'ready reported at start, hooks installed' ($ready.event -eq 'ready' -and $ready.listen -and $ready.capture) ($ready | ConvertTo-Json -Compress)

  # Hotkey press and release; the system's auto-repeat while held isn't reported separately
  [Fake]::Key($VK_RCONTROL, $true); Start-Sleep -Milliseconds 50; [Fake]::Key($VK_RCONTROL, $true)
  $down = Next-Event $helper
  [Fake]::Key($VK_RCONTROL, $false)
  $up = Next-Event $helper
  Check 'hotkey press and release reported once each' ($down.event -eq 'hotkey' -and $down.down -eq $true -and $up.event -eq 'hotkey' -and $up.down -eq $false) "$($down | ConvertTo-Json -Compress) $($up | ConvertTo-Json -Compress)"
  Check 'auto-repeat not reported separately' ($null -eq (Next-Event $helper 300))

  # Another key while the hotkey is held: other_key once, without saying which key
  [Fake]::Key($VK_RCONTROL, $true); $null = Next-Event $helper
  [Fake]::Key($VK_A, $true); [Fake]::Key($VK_A, $false); [Fake]::Key($VK_A, $true); [Fake]::Key($VK_A, $false)
  $other = Next-Event $helper
  [Fake]::Key($VK_RCONTROL, $false); $null = Next-Event $helper
  Check 'a combination reports other_key once' ($other.event -eq 'other_key' -and @($other.PSObject.Properties).Count -eq 1) ($other | ConvertTo-Json -Compress)
  Drain $helper

  # Capture esc and clicks in one region
  $width = [Fake]::GetSystemMetrics(0); $height = [Fake]::GetSystemMetrics(1)
  $x = [int]($width / 2); $y = [int]($height - 60)
  $results.Add("INFO primary screen ${width}x${height} (physical pixels), clicking at ($x, $y)")
  Send $helper @{ cmd = 'capture'; regions = @(@{ id = 'done'; x = $x - 20; y = $y - 20; width = 40; height = 40 }) }
  Start-Sleep -Milliseconds 200
  [Fake]::Key($VK_ESCAPE, $true); [Fake]::Key($VK_ESCAPE, $false)
  $escape = Next-Event $helper
  Check 'esc while capturing reports escape' ($escape.event -eq 'escape') ($escape | ConvertTo-Json -Compress)
  [Fake]::Click($x, $y, $true); Start-Sleep -Milliseconds 50; [Fake]::Click($x, $y, $false)
  $click = Next-Event $helper
  Check 'clicking the region while capturing reports click' ($click.event -eq 'click' -and $click.id -eq 'done') ($click | ConvertTo-Json -Compress)
  Send $helper @{ cmd = 'release' }
  Start-Sleep -Milliseconds 200
  [Fake]::Key($VK_ESCAPE, $true); [Fake]::Key($VK_ESCAPE, $false)
  [Fake]::Click($x, $y, $true); [Fake]::Click($x, $y, $false)
  Check 'after capturing stops, esc and clicks are not reported' ($null -eq (Next-Event $helper 400))

  # Paste text into Notepad: accented letters and a line break
  $text = "WhisprFlow check: caf$([char]0xE9), na$([char]0xEF)ve, world.`r`nSecond line $([char]0x2713)"
  # Notepad on Windows 11: the process started hands off to another process and exits, so find the newest one with a window by name
  $startedAt = Get-Date
  Start-Process notepad
  $window = 0
  for ($i = 0; $i -lt 30 -and $window -eq 0; $i++) {
    Start-Sleep -Milliseconds 200
    $notepad = Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1
    if ($notepad) { $window = $notepad.MainWindowHandle }
  }
  Check 'Notepad opened' ($window -ne 0) ''
  Start-Sleep -Milliseconds 800
  [Fake]::SetForegroundWindow($window) | Out-Null
  Start-Sleep -Milliseconds 500
  # Notepad on Windows 11 restores unsaved content from last time: clear it first
  [Fake]::Key($VK_CONTROL, $true); [Fake]::Key($VK_A, $true); [Fake]::Key($VK_A, $false); [Fake]::Key($VK_CONTROL, $false)
  [Fake]::Key(0x2E, $true); [Fake]::Key(0x2E, $false)
  Start-Sleep -Milliseconds 300
  Set-Clipboard -Value 'text the user copied before pasting'
  Send $helper @{ cmd = 'paste'; id = 1; text = $text }
  $pasted = Next-Event $helper 3000
  Check 'pasted ok reported after pasting' ($pasted.event -eq 'pasted' -and $pasted.id -eq 1 -and $pasted.ok) ($pasted | ConvertTo-Json -Compress)
  Check 'clipboard is back to the original after pasting' ((Get-Clipboard -Raw) -eq 'text the user copied before pasting') (Get-Clipboard -Raw)
  # Select all and copy to read back Notepad's text
  [Fake]::Key($VK_CONTROL, $true); [Fake]::Key($VK_A, $true); [Fake]::Key($VK_A, $false); [Fake]::Key(0x43, $true); [Fake]::Key(0x43, $false); [Fake]::Key($VK_CONTROL, $false)
  Start-Sleep -Milliseconds 400
  $inNotepad = Get-Clipboard -Raw
  Check 'Notepad holds the pasted text' ($inNotepad -eq $text) ($inNotepad)

} finally {
  $helper.Process.StandardInput.Close()
  if (-not $helper.Process.WaitForExit(2000)) { $helper.Process.Kill() }
  Check 'exits by itself after standard input closes' ($helper.Process.HasExited) ''
  Unregister-Event -SourceIdentifier $helper.Reader.Name -ErrorAction SilentlyContinue
  # Only close the one opened here (never the user's own Notepad windows)
  if ($startedAt) { Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $startedAt } | Stop-Process -Force -ErrorAction SilentlyContinue }
  if ($null -ne $saved) { Set-Clipboard -Value $saved }
}
$results
$checks = @($results | Where-Object { $_ -notlike 'INFO*' })
"{0}/{1} passed" -f @($checks | Where-Object { $_ -like 'PASS*' }).Count, $checks.Count
