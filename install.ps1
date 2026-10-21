# The WhisprFlow installer for Windows: checks the environment, downloads, verifies, installs into %USERPROFILE%\.whisprflow, then starts it.
#
#   irm https://github.com/zghanw/whisprflow/releases/latest/download/install.ps1 | iex
#
# The same job and layout as install.sh: the program, its runtime, and later the settings, keys, history, and recordings all live in the one .whisprflow directory.
# Outside it only two things change, both recorded in bin\links for whisprflow uninstall to remove:
#   - .whisprflow\bin is added to the user Path (so whisprflow is found in newly opened terminals)
#   - a "WhisprFlow" shortcut in the Start menu
# No Node, npm, or administrator rights needed. Running it again over an existing install upgrades: the program is replaced and your data stays.
#
# Environment variables that adjust it (irm | iex can't pass arguments, so everything goes through environment variables):
#   WHISPRFLOW_HOME          where to install (default %USERPROFILE%\.whisprflow)
#   WHISPRFLOW_VERSION       which version to install, like v0.9.0 (default the latest)
#   WHISPRFLOW_INSTALL_BASE  where to download from: a URL prefix, or a local directory (dist\release made by npm run release)
#
# The download address is laid out the way GitHub Releases serves it: latest/download/latest holds the newest version, and each version's files
# are under download/<version>/ (the package, its .sha256, and this script)
#   WHISPRFLOW_NO_START=1    install without starting
#
# Must run on the PowerShell 5.1 that ships with Windows, which has these known pitfalls:
#   - everything is wrapped in one script block and errors never exit: irm | iex runs in the user's own window, and exit would close it
#   - no Expand-Archive or Get-FileHash: the former draws its progress bar very slowly, the latter fails to load in 5.1 opened from PowerShell 7; .NET does both
#   - ErrorActionPreference is relaxed when calling external programs: under Stop, 5.1 turns the first line of standard error into an exception
#   - the user Path is read and written raw (REG_EXPAND_SZ, unexpanded), otherwise %USERPROFILE% inside it would be baked in

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  # The download address requires TLS 1.2 or later; 5.1 on older Windows 10 builds doesn't enable it by default
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $RepoUrl = 'https://github.com/zghanw/whisprflow'
  $DownloadUrl = 'https://github.com/zghanw/whisprflow/releases'
  $Archive = 'whisprflow-win32-x64.zip'
  # Electron 44 needs Windows 10 1809 (build 17763) or later
  $MinBuild = 17763
  # The download is about 180 MB, about 500 MB unpacked; on upgrade the old copy is only deleted once the new one is in place
  $NeededMB = 1200

  function Ok($text) { Write-Host "  " -NoNewline; Write-Host ([char]0x2713) -ForegroundColor Green -NoNewline; Write-Host " $text" }
  function Warn($text) { Write-Host "  ! " -ForegroundColor Yellow -NoNewline; Write-Host $text }
  function Note($text) { Write-Host "    $text" -ForegroundColor DarkGray }
  function Heading($text) { Write-Host ""; Write-Host "  $text" }
  # Says what is wrong and what to do, then stops. Up to this point nothing already installed has been replaced
  function Fail($title) {
    $lines = @($args)
    throw [System.Management.Automation.RuntimeException]::new("WHISPRFLOW_INSTALL_FAILED`n$title`n$($lines -join "`n")")
  }
  # Paths for people: the home directory written as ~
  function Pretty($path) { if ($path.StartsWith($HOME, [StringComparison]::OrdinalIgnoreCase)) { '~' + $path.Substring($HOME.Length) } else { $path } }

  # Runs an external program and returns its output (standard error included) and exit code. Temporarily relaxed: 5.1 treats standard error as exceptions;
  # output is read as UTF-8 (WhisprFlow writes UTF-8, 5.1 reads the system code page by default), and the user's window encoding is restored afterwards
  function Invoke-Native([string]$file, [string[]]$arguments, [hashtable]$environment = @{}) {
    $saved = @{}
    foreach ($name in $environment.Keys) { $saved[$name] = [Environment]::GetEnvironmentVariable($name); [Environment]::SetEnvironmentVariable($name, $environment[$name]) }
    $previous = $ErrorActionPreference
    $encoding = [Console]::OutputEncoding
    $ErrorActionPreference = 'Continue'
    try {
      [Console]::OutputEncoding = [Text.Encoding]::UTF8
      $output = & $file @arguments 2>&1 | ForEach-Object { "$_" }
      return @{ Output = ($output -join "`n"); Code = $LASTEXITCODE }
    } finally {
      [Console]::OutputEncoding = $encoding
      $ErrorActionPreference = $previous
      foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
    }
  }

  # ---------- Preflight ----------

  function Test-System {
    $build = [Environment]::OSVersion.Version.Build
    if ($build -lt $MinBuild) { Fail "Windows (build $build) is too old" "WhisprFlow needs Windows 10 version 1809 or newer, or Windows 11." }
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
    switch ($arch) {
      'AMD64' { Ok "Windows (build $build), x64" }
      # Windows on ARM can run x64 programs (the system's built-in emulation); on-device transcription gets no GPU acceleration
      'ARM64' { Ok "Windows (build $build), ARM"; Note "WhisprFlow is built for x64; it runs here through Windows' x64 emulation." }
      default { Fail "Unsupported processor: $arch" "WhisprFlow is built for 64-bit Windows (x64)." }
    }
  }

  # Only the owner (and SYSTEM) can get in: it will hold recordings and keys. The same as WhisprFlow itself does (src/storage/owner-only.mjs)
  function Protect-Home($dir) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $result = Invoke-Native 'icacls' @($dir, '/inheritance:r', '/grant:r', "*${sid}:(OI)(CI)F", '*S-1-5-18:(OI)(CI)F')
    if ($result.Code -ne 0) { Fail "Couldn't restrict access to $(Pretty $dir)" $result.Output }
  }

  function Test-Home {
    if (-not [IO.Path]::IsPathRooted($script:HomeDir)) { Fail "WHISPRFLOW_HOME must be an absolute path, not $($script:HomeDir)" }
    try { New-Item -ItemType Directory -Force -Path $script:HomeDir | Out-Null } catch {
      Fail "Can't create $(Pretty $script:HomeDir)" "Check its permissions, or pick another place with WHISPRFLOW_HOME."
    }
    Protect-Home $script:HomeDir
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($script:HomeDir))
    $freeMB = [int]($drive.AvailableFreeSpace / 1MB)
    if ($freeMB -lt $NeededMB) { Fail "Not enough disk space: $freeMB MB free" "About $NeededMB MB is needed. Free up some space and run again." }
    Ok "Installing to $(Pretty $script:HomeDir) ($([int]($freeMB / 1024)) GB free)"

    $script:InstalledVersion = ''
    $manifest = Join-Path $script:HomeDir 'app\package.json'
    if (Test-Path $manifest) {
      $script:InstalledVersion = (Get-Content -Raw -Encoding UTF8 $manifest | ConvertFrom-Json).version
      Ok "Found $($script:InstalledVersion): replacing it; settings, keys, history and recordings stay"
    }
  }

  # The download address can be a local directory (for testing release packages)
  $script:LocalBase = $false
  function Get-Remote($name, $destination) {
    if ($script:LocalBase) {
      $source = Join-Path $script:Base $name
      if (-not (Test-Path $source)) { throw "No such file: $source" }
      if ($destination) { Copy-Item -LiteralPath $source -Destination $destination; return }
      return [IO.File]::ReadAllText($source)
    }
    $url = "$($script:Base)/$name"
    if ($destination) { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $destination -TimeoutSec 1800; return }
    return (Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 20).Content
  }

  # Settles which version to install: the one specified, or else the latest the download address reports
  function Resolve-Version {
    $version = $env:WHISPRFLOW_VERSION
    if ($version) {
      if (-not $version.StartsWith('v')) { $version = "v$version" }
    } else {
      try { $version = ([string](Get-Remote 'latest/download/latest')).Trim() } catch {
        Fail "Couldn't find the latest version" "URL: $($script:Base)/latest/download/latest" "Check your network and try again in a bit." "($($_.Exception.Message))"
      }
    }
    # The version is spliced into the download address: anything that doesn't look like a version stops here (say, an error page)
    if ($version -notmatch '^v\d+\.\d+\.\d+([-+.][0-9A-Za-z.-]+)?$') {
      if ($env:WHISPRFLOW_VERSION) { Fail "WHISPRFLOW_VERSION doesn't look like a version: $($env:WHISPRFLOW_VERSION)" "Write it like v0.9.0." }
      Fail "The download server returned a bad version number" "URL: $($script:Base)/latest/download/latest" "Try again in a bit. If it keeps happening, please open an issue at $RepoUrl/issues."
    }
    $script:Version = $version
    Ok "Version $version"
  }

  # ---------- Install ----------

  function Get-Package {
    # A run cut off midway (the window closed while unpacking) can't clean up after itself and leaves a full unpacked copy behind: clear those first
    Get-ChildItem -LiteralPath $script:HomeDir -Directory -Force -Filter '.install.*' -ErrorAction SilentlyContinue | ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
    $script:TmpDir = Join-Path $script:HomeDir ".install.$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    New-Item -ItemType Directory -Path $script:TmpDir | Out-Null
    $zip = Join-Path $script:TmpDir $Archive
    try {
      Get-Remote "download/$($script:Version)/$Archive" $zip
      Get-Remote "download/$($script:Version)/$Archive.sha256" "$zip.sha256"
    } catch {
      Fail "Couldn't download the package" "URL: $($script:Base)/download/$($script:Version)/$Archive" "Check your network. If you set WHISPRFLOW_VERSION, make sure that version exists." "($($_.Exception.Message))"
    }
    Ok "Downloaded"

    $expected = ((Get-Content -Raw "$zip.sha256").Trim() -split '\s+')[0].ToLowerInvariant()
    $stream = [IO.File]::OpenRead($zip)
    try { $actual = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) } finally { $stream.Dispose() }
    if (-not $expected -or $expected -ne $actual) {
      Fail "Checksum mismatch: the download differs from the release" "It was probably damaged on the way. Run it again." "Expected $expected" "Got      $actual"
    }
    Ok "Checksum OK"

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    try { [IO.Compression.ZipFile]::ExtractToDirectory($zip, $script:TmpDir) } catch { Fail "Couldn't unpack the package" "Run it again." "($($_.Exception.Message))" }
    Remove-Item -LiteralPath $zip, "$zip.sha256"
    $script:NewElectron = Join-Path $script:TmpDir 'runtime\electron.exe'
    if (-not (Test-Path (Join-Path $script:TmpDir 'app\bin\whisprflow.mjs')) -or -not (Test-Path $script:NewElectron)) {
      Fail "The package is incomplete" "That's a problem with the release. Please open an issue at $RepoUrl/issues."
    }

    # Run it in place before replacing the old one: if it can't run on this machine, find out now rather than after the swap
    $result = Invoke-NewCopy @('--version')
    if ($result.Code -ne 0) { Fail "The downloaded app won't run on this PC" $result.Output "Please open an issue at $RepoUrl/issues with your Windows version." }
    $script:NewVersion = $result.Output.Trim()
    Ok "Unpacked WhisprFlow $($script:NewVersion)"
  }

  # Runs a command with the program just downloaded, in English: whether it stopped is judged from what it says below
  function Invoke-NewCopy([string[]]$arguments) {
    Invoke-Native $script:NewElectron (@((Join-Path $script:TmpDir 'app\bin\whisprflow.mjs')) + $arguments) @{
      WHISPRFLOW_HOME = $script:HomeDir; ELECTRON_RUN_AS_NODE = '1'; WHISPRFLOW_LANGUAGE = 'en'
    }
  }

  # Moves each item of a directory into another directory (created if missing), noting each move so errors can roll back. On the same disk a move is a rename, instant
  function Move-Entries($from, $to) {
    New-Item -ItemType Directory -Force -Path $to | Out-Null
    Get-ChildItem -LiteralPath $from -Force | ForEach-Object {
      $target = Join-Path $to $_.Name
      Move-Item -LiteralPath $_.FullName -Destination $target
      [void]$script:Moves.Add(@($_.FullName, $target))
    }
  }

  # Swaps in the program and runtime just downloaded: the old ones move into <name>.old.<number>, the new ones move in. The directory's contents move, not the directory itself:
  # a running Electron (like the copy running whisprflow update) holds the directory it lives in, so the directory can't be renamed,
  # but the files and subdirectories inside can be moved (tested one by one on real hardware). Old ones are deleted if possible; those still in use stay
  # and are deleted at the next install (whisprflow update deletes them after it exits). An error midway moves items back one by one
  function Install-Files {
    $result = Invoke-NewCopy @('stop')
    if ($result.Code -ne 0) { Fail "Couldn't stop the running WhisprFlow" $result.Output "Quit it first, then install again." }
    if ($result.Output -match 'WhisprFlow stopped\.|force-quit') { Ok "Stopped the running WhisprFlow" }

    $names = @('app', 'runtime')
    foreach ($name in $names) {
      Get-ChildItem -LiteralPath $script:HomeDir -Directory -Filter "$name.old*" -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
      }
    }
    $id = [guid]::NewGuid().ToString('N').Substring(0, 8)
    $script:Moves = New-Object System.Collections.ArrayList
    try {
      foreach ($name in $names) {
        $current = Join-Path $script:HomeDir $name
        if (Test-Path $current) { Move-Entries $current (Join-Path $script:HomeDir "$name.old.$id") }
      }
      foreach ($name in $names) { Move-Entries (Join-Path $script:TmpDir $name) (Join-Path $script:HomeDir $name) }
    } catch {
      $reason = $_.Exception.Message
      # If rolling back fails, stop rolling back and report it (without claiming "nothing changed"): the old copy is still in <name>.old.<number>
      for ($i = $script:Moves.Count - 1; $i -ge 0; $i--) { Move-Item -LiteralPath $script:Moves[$i][1] -Destination $script:Moves[$i][0] }
      foreach ($name in $names) { Remove-Item -LiteralPath (Join-Path $script:HomeDir "$name.old.$id") -Recurse -Force -ErrorAction SilentlyContinue }
      Fail "Couldn't put the new version into $(Pretty $script:HomeDir)" "Close any window that has a file in it open, then run again. WhisprFlow was stopped; run whisprflow to start it again." "($reason)"
    }
    $left = $false
    foreach ($name in $names) {
      $old = Join-Path $script:HomeDir "$name.old.$id"
      if (Test-Path $old) {
        Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path $old) { $left = $true }
      }
    }
    if ($left) { Note "Part of the previous version is still in use; it will be removed later." }

    $binDir = Join-Path $script:HomeDir 'bin'
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    # The launcher only uses paths relative to itself: its content never changes (an upgrade never rewrites a running batch file), and non-ASCII paths don't depend on how cmd decodes it
    $launcher = @(
      '@echo off',
      'rem The whisprflow command, generated by the WhisprFlow installer.',
      'rem Runs on the bundled Electron as Node, so Node does not need to be installed.',
      'setlocal',
      'if not defined WHISPRFLOW_HOME for %%I in ("%~dp0..") do set "WHISPRFLOW_HOME=%%~fI"',
      'set ELECTRON_RUN_AS_NODE=1',
      '"%~dp0..\runtime\electron.exe" "%~dp0..\app\bin\whisprflow.mjs" %*'
    ) -join "`r`n"
    $script:Launcher = Join-Path $binDir 'whisprflow.cmd'
    if (-not (Test-Path $script:Launcher) -or (Get-Content -Raw $script:Launcher) -ne "$launcher`r`n") {
      [IO.File]::WriteAllText($script:Launcher, "$launcher`r`n", [Text.Encoding]::ASCII)
    }
    Ok "Installed to $(Pretty $script:HomeDir)"
  }

  # Record what changed outside the home directory, for uninstall to undo (src/cli/commands/uninstall.mjs)
  function Add-Link($line) {
    $file = Join-Path $script:HomeDir 'bin\links'
    $lines = @()
    if (Test-Path $file) { $lines = @(Get-Content -Encoding UTF8 $file) }
    if ($lines -notcontains $line) { Add-Content -Encoding UTF8 -Path $file -Value $line }
  }

  # Add bin to the user Path. Read and written raw: forms like %USERPROFILE% aren't expanded on reading, so what is written back stays expandable
  function Add-ToPath {
    $binDir = Join-Path $script:HomeDir 'bin'
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
      $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $entries = @($raw -split ';' | Where-Object { $_ })
      $present = $entries | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $binDir.TrimEnd('\') }
      # The default location is written as %USERPROFILE%\.whisprflow\bin: still right after a username change or a moved profile
      $entry = $binDir
      if ($binDir -ieq (Join-Path $env:USERPROFILE '.whisprflow\bin')) { $entry = '%USERPROFILE%\.whisprflow\bin' }
      if (-not $present) {
        $key.SetValue('Path', (($entries + $entry) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
        # Setting an environment variable makes the system broadcast "environment changed": only then do newly opened terminals see the new Path
        [Environment]::SetEnvironmentVariable('WHISPRFLOW_PATH_CHANGED', '1', 'User')
        [Environment]::SetEnvironmentVariable('WHISPRFLOW_PATH_CHANGED', $null, 'User')
        Ok "Added $(Pretty $binDir) to your Path"
      } else {
        $entry = $present | Select-Object -First 1
        Ok "$(Pretty $binDir) is on your Path"
      }
      Add-Link "path $entry"
    } finally { $key.Dispose() }
    # Usable in this window right away too
    if (($env:Path -split ';') -notcontains $binDir) { $env:Path = "$env:Path;$binDir" }
  }

  # The Start menu shortcut: starts Electron directly with the program directory (the same as the whisprflow command starts, sharing keys and settings)
  function Add-Shortcut {
    $programs = [Environment]::GetFolderPath('Programs')
    $link = Join-Path $programs 'WhisprFlow.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($link)
    $shortcut.TargetPath = Join-Path $script:HomeDir 'runtime\electron.exe'
    $shortcut.Arguments = '"' + (Join-Path $script:HomeDir 'app') + '"'
    $shortcut.WorkingDirectory = $script:HomeDir
    $shortcut.IconLocation = (Join-Path $script:HomeDir 'app\assets\icon.ico') + ',0'
    $shortcut.Description = 'WhisprFlow: press a hotkey, speak, and polished text is pasted in'
    $shortcut.Save()
    Add-Link "shortcut $link"
    Ok "Start menu: WhisprFlow"
  }

  function Remove-Tmp { if ($script:TmpDir -and (Test-Path $script:TmpDir)) { Remove-Item -LiteralPath $script:TmpDir -Recurse -Force -ErrorAction SilentlyContinue } }

  # ---------- Entry point ----------

  try {
    $script:HomeDir = if ($env:WHISPRFLOW_HOME) { $env:WHISPRFLOW_HOME } else { Join-Path $env:USERPROFILE '.whisprflow' }
    $script:Base = if ($env:WHISPRFLOW_INSTALL_BASE) { $env:WHISPRFLOW_INSTALL_BASE.TrimEnd('/', '\') } else { $DownloadUrl }
    # A local directory can also be the download address
    $script:LocalBase = $script:Base -notmatch '^[a-z]+://'

    Write-Host ""
    Write-Host "  WhisprFlow installer"
    Heading "Checks"
    Test-System
    Test-Home
    Resolve-Version

    Heading "Install"
    Get-Package
    Install-Files
    Add-ToPath
    Add-Shortcut
    Remove-Tmp

    Write-Host ""
    if ($script:InstalledVersion -and $script:InstalledVersion -ne $script:NewVersion) {
      Write-Host "  Upgraded: $($script:InstalledVersion) -> $($script:NewVersion)"
    } else {
      Write-Host "  Installed WhisprFlow $($script:NewVersion)"
    }
    Note "To remove it: whisprflow uninstall deletes all of $(Pretty $script:HomeDir)."

    if ($env:WHISPRFLOW_NO_START -ne '1' -and [Environment]::UserInteractive) {
      Write-Host ""
      & $script:Launcher
    } else {
      Write-Host ""
      Write-Host "  Run whisprflow in a new terminal to start, or open WhisprFlow from the Start menu."
      Write-Host ""
    }
  } catch {
    Remove-Tmp
    $message = $_.Exception.Message
    if ($message.StartsWith('WHISPRFLOW_INSTALL_FAILED')) {
      $lines = $message.Split("`n") | Select-Object -Skip 1 | Where-Object { $_ }
      Write-Host ""
      Write-Host "  x " -ForegroundColor Red -NoNewline
      Write-Host ($lines | Select-Object -First 1)
      $lines | Select-Object -Skip 1 | ForEach-Object { Write-Host "    $_" }
      Write-Host ""
      Write-Host "  Nothing was installed; what you had is untouched."
    } else {
      Write-Host ""
      Write-Host "  x Something went wrong: $message" -ForegroundColor Red
      Write-Host "    $($_.InvocationInfo.PositionMessage)"
      Write-Host "    Please open an issue at $RepoUrl/issues with the text above."
    }
    # Give the caller (whisprflow update) a nonzero result without exit: that would close the user's window
    $global:LASTEXITCODE = 1
  }
}
