#!/bin/bash
# The WhisprFlow installer: checks the environment, downloads, verifies, installs into ~/.whisprflow, then starts it.
#
#   curl -fsSL https://github.com/zghanw/whisprflow/releases/latest/download/install.sh | bash
#
# Everything goes into the one ~/.whisprflow directory (the program, its runtime, and later the settings, keys, history, and recordings);
# outside it only a link to the command is created. No Node, npm, Xcode, or sudo needed.
# Running it again over an existing install upgrades: the program is replaced and your data stays. Uninstall with whisprflow uninstall.
#
# Environment variables that adjust it:
#   WHISPRFLOW_HOME          where to install (default ~/.whisprflow)
#   WHISPRFLOW_VERSION       which version to install, like v0.2.0 (default the latest)
#   WHISPRFLOW_INSTALL_BASE  where to download from: a URL prefix, or a local directory (dist/release made by npm run release)
#   WHISPRFLOW_BIN_DIR       which directory gets the command link (default ~/.local/bin)
# Add --no-start to install without starting: curl ... | bash -s -- --no-start
#
# Must run on the bash 3.2 that ships with macOS. All logic lives in functions, called only on the last line:
# when the script is read from a pipe and only half arrives, no half script runs.

set -euo pipefail

REPO_URL="https://github.com/zghanw/whisprflow"
# Releases live here, laid out the way GitHub Releases serves them: latest/download/latest is one line, the newest version, and each version's files
# are under download/<version>/: whisprflow-darwin-<chip>.tar.gz, a .sha256 of the same name, and this script
DOWNLOAD_URL="https://github.com/zghanw/whisprflow/releases"
# The cloud providers (name and host in pairs); cloud modes need to reach one of them. Matches those registered in src/server/providers/index.mjs
MODEL_HOSTS=("Gemini" "generativelanguage.googleapis.com" "OpenAI" "api.openai.com")
MIN_MACOS_MAJOR=12
# The download is about 120 MB, about 350 MB unpacked; on upgrade the old copy is only deleted once the new one is in place
NEEDED_MB=1000
# Unix socket paths on macOS are at most 103 bytes, and the control channel is at <directory>/run/control.sock
MAX_HOME_BYTES=86

TMP_DIR=""

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  GREEN=$'\033[32m' YELLOW=$'\033[33m' RED=$'\033[31m' BOLD=$'\033[1m' DIM=$'\033[2m' RESET=$'\033[0m'
else
  GREEN="" YELLOW="" RED="" BOLD="" DIM="" RESET=""
fi

heading() { printf '\n  %s%s%s\n' "$BOLD" "$1" "$RESET"; }
ok() { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
note() { printf '    %s%s%s\n' "$DIM" "$1" "$RESET"; }
# Says what is wrong and what to do, then exits. Up to this point nothing already installed has been replaced
fail() {
  printf '  %s✗%s %s\n' "$RED" "$RESET" "$1" >&2
  shift
  for line in "$@"; do printf '    %s\n' "$line" >&2; done
  printf '\n  Nothing was installed; what you had is untouched.\n' >&2
  exit 1
}

# Paths for people: the home directory written as ~
pretty() { case "$1" in "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;; *) printf '%s' "$1" ;; esac; }
# Writes text as a single-quoted sh literal, so spaces and quotes in paths don't break anything
quoted() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
on_path() { case ":$PATH:" in *":$1:"*) return 0 ;; *) return 1 ;; esac; }
cleanup() {
  [ -z "$TMP_DIR" ] || rm -rf "$TMP_DIR"
  # If nothing got installed, don't leave an empty directory behind (this can't delete it if it has contents, which is right)
  rmdir "${HOME_DIR:-}" 2>/dev/null || true
}

# ---------- Preflight ----------

check_system() {
  [ "$(uname -s)" = "Darwin" ] ||
    fail "WhisprFlow only supports macOS for now" "Listening for the hotkey and pasting rely on macOS system APIs. This machine runs $(uname -s)."

  [ "$(id -u)" -ne 0 ] ||
    fail "Don't run this with sudo or as root" "WhisprFlow installs into your home folder and doesn't need admin rights. Run it again without sudo."

  local version major
  version="$(sw_vers -productVersion)"
  major="${version%%.*}"
  [ "$major" -ge "$MIN_MACOS_MAJOR" ] 2>/dev/null ||
    fail "macOS $version is too old" "WhisprFlow needs macOS $MIN_MACOS_MAJOR or newer."
  ok "macOS $version"

  case "$(uname -m)" in
    arm64) ARCH="arm64" ;;
    x86_64)
      # A terminal running under Rosetta on Apple silicon reports x86_64
      if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then ARCH="arm64"; else ARCH="x64"; fi
      ;;
    *) fail "Unknown chip: $(uname -m)" "WhisprFlow is built for Apple silicon (arm64) and Intel (x86_64)." ;;
  esac
  if [ "$ARCH" = "arm64" ]; then ok "Apple silicon"; else ok "Intel"; fi

  local tool missing=""
  for tool in curl tar shasum mktemp awk sed df; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
  done
  [ -z "$missing" ] || fail "Missing built-in tools:$missing" "They come with macOS. Check whether your PATH was changed."
  ok "System tools found"
}

check_home() {
  local bytes
  bytes="$(printf '%s' "$HOME_DIR" | wc -c | tr -d ' ')"
  [ "$bytes" -le "$MAX_HOME_BYTES" ] ||
    fail "Install path is too long: $HOME_DIR" "Pick a shorter one with WHISPRFLOW_HOME=/a/short/path and run again."
  case "$HOME_DIR" in /*) ;; *) fail "WHISPRFLOW_HOME must be an absolute path, not $HOME_DIR" ;; esac

  mkdir -p "$HOME_DIR" 2>/dev/null && [ -w "$HOME_DIR" ] ||
    fail "Can't create or write to $(pretty "$HOME_DIR")" "Check its permissions, or pick another place with WHISPRFLOW_HOME."
  # It will hold recordings and keys, so only the owner can get in
  chmod 700 "$HOME_DIR"

  local free_mb
  free_mb="$(df -Pk "$HOME_DIR" | awk 'NR == 2 { printf "%d", $4 / 1024 }')"
  [ "$free_mb" -ge "$NEEDED_MB" ] 2>/dev/null ||
    fail "Not enough disk space: ${free_mb} MB free" "About ${NEEDED_MB} MB is needed. Free up some space and run again."
  ok "Installing to $(pretty "$HOME_DIR") ($((free_mb / 1024)) GB free)"

  INSTALLED_VERSION=""
  if [ -f "$HOME_DIR/app/package.json" ]; then
    INSTALLED_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$HOME_DIR/app/package.json" | head -1)"
    ok "Found ${INSTALLED_VERSION:-an earlier version}: replacing it; settings, keys, history and recordings stay"
  fi
}

# Settles which version to install: the one specified, or else the latest the download address reports
resolve_version() {
  local version="${WHISPRFLOW_VERSION:-}"
  if [ -n "$version" ]; then
    case "$version" in v*) ;; *) version="v$version" ;; esac
  else
    version="$(curl -fsSL --max-time 20 "$DOWNLOAD_BASE/latest/download/latest" 2>/dev/null | head -n 1 | tr -d '[:space:]')" || version=""
    [ -n "$version" ] || fail "Couldn't find the latest version" "URL: $DOWNLOAD_BASE/latest/download/latest" "Check your network and try again in a bit."
  fi
  # The version is spliced into the download address: anything that doesn't look like a version stops here (say, an error page)
  if ! [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+.][0-9A-Za-z.-]+)?$ ]]; then
    [ -n "${WHISPRFLOW_VERSION:-}" ] && fail "WHISPRFLOW_VERSION doesn't look like a version: $WHISPRFLOW_VERSION" "Write it like v0.2.0."
    fail "The download server returned a bad version number" "URL: $DOWNLOAD_BASE/latest/download/latest" "Try again in a bit. If it keeps happening, please open an issue at $REPO_URL/issues."
  fi
  BASE_URL="$DOWNLOAD_BASE/download/$version"
}

check_network() {
  resolve_version
  # This also confirms that the release package for this version and chip exists
  curl -fsSL --max-time 20 -o /dev/null "$BASE_URL/$ARCHIVE.sha256" 2>/dev/null ||
    fail "Couldn't reach the release package" \
      "URL: $BASE_URL/$ARCHIVE" \
      "Check your network. If you set WHISPRFLOW_VERSION, make sure that version exists."
  ok "Download server reachable"

  # Installing isn't the same as working: cloud modes need to reach their provider, and which one isn't known at install time, so check them all. Unreachable only warns, never blocks
  local i unreachable=0
  for ((i = 0; i < ${#MODEL_HOSTS[@]}; i += 2)); do
    if curl -s --max-time 8 -o /dev/null "https://${MODEL_HOSTS[i + 1]}/" 2>/dev/null; then
      ok "${MODEL_HOSTS[i]} reachable"
    else
      warn "Can't reach ${MODEL_HOSTS[i]} right now (${MODEL_HOSTS[i + 1]})"
      unreachable=1
    fi
  done
  if [ "$unreachable" = 1 ]; then
    note "Installing still works. You need to reach the provider you use; if you need a proxy, set it in the terminal that starts whisprflow."
  fi
}

# ---------- Install ----------

download() {
  TMP_DIR="$(mktemp -d "$HOME_DIR/.install.XXXXXX")"
  local progress="-sS"
  [ -t 2 ] && progress="--progress-bar"
  curl -fL "$progress" -o "$TMP_DIR/$ARCHIVE" "$BASE_URL/$ARCHIVE" ||
    fail "Download interrupted" "Run it again. URL: $BASE_URL/$ARCHIVE"
  curl -fsSL -o "$TMP_DIR/$ARCHIVE.sha256" "$BASE_URL/$ARCHIVE.sha256" || fail "Couldn't download the checksum" "Run it again."
  ok "Downloaded"

  local expected actual
  expected="$(awk '{ print $1; exit }' "$TMP_DIR/$ARCHIVE.sha256")"
  actual="$(shasum -a 256 "$TMP_DIR/$ARCHIVE" | awk '{ print $1 }')"
  [ -n "$expected" ] && [ "$expected" = "$actual" ] ||
    fail "Checksum mismatch: the download differs from the release" "It was probably damaged on the way. Run it again." "Expected $expected" "Got      $actual"
  ok "Checksum OK"

  tar -xzf "$TMP_DIR/$ARCHIVE" -C "$TMP_DIR" || fail "Couldn't unpack the package" "Run it again."
  NEW_ELECTRON="$TMP_DIR/runtime/Electron.app/Contents/MacOS/Electron"
  [ -f "$TMP_DIR/app/bin/whisprflow.mjs" ] && [ -x "$NEW_ELECTRON" ] || fail "The package is incomplete" "That's a problem with the release. Please open an issue at $REPO_URL/issues."

  # Run it in place before replacing the old one: if it can't run on this machine, find out now rather than after the swap
  NEW_VERSION="$(run_new --version 2>/dev/null)" ||
    fail "The downloaded app won't run on this Mac" "Please open an issue at $REPO_URL/issues with your macOS version and chip."
  ok "Unpacked WhisprFlow $NEW_VERSION"
}

# Runs a command with the program just downloaded
run_new() {
  WHISPRFLOW_HOME="$HOME_DIR" ELECTRON_RUN_AS_NODE=1 "$NEW_ELECTRON" "$TMP_DIR/app/bin/whisprflow.mjs" "$@"
}

# Swaps in the program and runtime just downloaded. Both swap or neither does: an error midway puts the originals back
swap_in() {
  local name
  for name in app runtime; do
    rm -rf "$HOME_DIR/$name.old"
    [ ! -e "$HOME_DIR/$name" ] || mv "$HOME_DIR/$name" "$HOME_DIR/$name.old" ||
      fail "Can't move $(pretty "$HOME_DIR/$name")" "Check the folder's permissions."
  done
  if mv "$TMP_DIR/app" "$HOME_DIR/app" && mv "$TMP_DIR/runtime" "$HOME_DIR/runtime"; then
    rm -rf "$HOME_DIR/app.old" "$HOME_DIR/runtime.old"
    return
  fi
  for name in app runtime; do
    [ -e "$HOME_DIR/$name.old" ] || continue
    rm -rf "$HOME_DIR/$name"
    mv "$HOME_DIR/$name.old" "$HOME_DIR/$name"
  done
  fail "Couldn't put the new version into $(pretty "$HOME_DIR")" "Check the folder's permissions. WhisprFlow was stopped; run whisprflow to start it again."
}

install_files() {
  # A running copy must stop first: it has the old program's files open. Stop it with the new copy, which knows background apps of old and new versions.
  # Whether it stopped is judged from what it says, and the CLI speaks the terminal's language: make it speak English, like this script
  local output
  output="$(WHISPRFLOW_LANGUAGE=en run_new stop 2>&1)" || fail "Couldn't stop the running WhisprFlow" "$output" "Quit it first, then install again."
  case "$output" in *"WhisprFlow stopped."* | *"force-quit"*) ok "Stopped the running WhisprFlow" ;; esac

  swap_in

  mkdir -p "$HOME_DIR/bin"
  LAUNCHER="$HOME_DIR/bin/whisprflow"
  # The directory's location is written into the launcher: links elsewhere point at it, so it can't guess from "where am I"
  cat >"$LAUNCHER" <<EOF
#!/bin/sh
# The whisprflow command, generated by the WhisprFlow installer.
# Runs on the bundled Electron as Node, so Node doesn't need to be installed.
installed_in=$(quoted "$HOME_DIR")
WHISPRFLOW_HOME="\${WHISPRFLOW_HOME:-\$installed_in}"
export WHISPRFLOW_HOME
ELECTRON_RUN_AS_NODE=1 exec $(quoted "$HOME_DIR/runtime/Electron.app/Contents/MacOS/Electron") $(quoted "$HOME_DIR/app/bin/whisprflow.mjs") "\$@"
EOF
  chmod 755 "$LAUNCHER"
  ok "Installed to $(pretty "$HOME_DIR")"
}

link_command() {
  local dir link
  if [ -n "${WHISPRFLOW_BIN_DIR:-}" ]; then
    dir="$WHISPRFLOW_BIN_DIR"
  elif on_path "$HOME/.local/bin"; then
    dir="$HOME/.local/bin"
  elif on_path /usr/local/bin && [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
    dir="/usr/local/bin"
  else
    dir="$HOME/.local/bin"
  fi
  link="$dir/whisprflow"

  # Something that isn't a link already exists at that location with the same name: we didn't put it there, so leave it
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    warn "$(pretty "$link") is another whisprflow; left it alone"
    note "To use the new one, run: $(pretty "$LAUNCHER")"
    return
  fi
  mkdir -p "$dir"
  ln -sfn "$LAUNCHER" "$link"
  # Record what was created outside the home directory, for uninstall to remove
  grep -qxF "$link" "$HOME_DIR/bin/links" 2>/dev/null || printf '%s\n' "$link" >>"$HOME_DIR/bin/links"
  ok "whisprflow command: $(pretty "$link")"

  if ! on_path "$dir"; then
    local rc=".zshrc"
    case "${SHELL:-}" in */bash) rc=".bash_profile" ;; esac
    warn "$(pretty "$dir") isn't on your PATH, so new terminals won't find whisprflow"
    note "Add it: echo 'export PATH=\"$dir:\$PATH\"' >> ~/$rc"
    note "Or use the full path: $(pretty "$LAUNCHER")"
    return
  fi
  # If another whisprflow comes earlier in PATH (say, an npm link from a source checkout), typing the command would run that one
  local found
  found="$(command -v whisprflow 2>/dev/null || true)"
  if [ -n "$found" ] && [ "$found" != "$link" ]; then
    warn "Another whisprflow comes first on your PATH: $(pretty "$found")"
    note "Typing whisprflow runs that one. It's likely an old npm link; remove it with: npm unlink -g whisprflow"
  fi
}

main() {
  local start="yes" arg
  for arg in "$@"; do
    case "$arg" in
      --no-start) start="no" ;;
      *) fail "Unknown option: $arg" "The only option is --no-start (install without starting)." ;;
    esac
  done

  HOME_DIR="${WHISPRFLOW_HOME:-$HOME/.whisprflow}"
  DOWNLOAD_BASE="${WHISPRFLOW_INSTALL_BASE:-$DOWNLOAD_URL}"
  # A local directory can also be the download address
  case "$DOWNLOAD_BASE" in /*) DOWNLOAD_BASE="file://$DOWNLOAD_BASE" ;; esac

  printf '\n  %sWhisprFlow installer%s\n' "$BOLD" "$RESET"
  trap cleanup EXIT

  heading "Checks"
  check_system
  ARCHIVE="whisprflow-darwin-$ARCH.tar.gz"
  check_home
  check_network

  heading "Install"
  download
  install_files
  link_command

  if [ -n "$INSTALLED_VERSION" ] && [ "$INSTALLED_VERSION" != "$NEW_VERSION" ]; then
    printf '\n  %sUpgraded: %s → %s%s\n' "$BOLD" "$INSTALLED_VERSION" "$NEW_VERSION" "$RESET"
  else
    printf '\n  %sInstalled WhisprFlow %s%s\n' "$BOLD" "$NEW_VERSION" "$RESET"
  fi
  note "To remove it: whisprflow uninstall deletes all of $(pretty "$HOME_DIR")."

  cleanup
  TMP_DIR=""
  # Read from a pipe, standard input isn't the terminal, and asking for a key needs the keyboard: connect it to the terminal before starting
  if [ "$start" = "yes" ] && [ -t 1 ] && (: </dev/tty) 2>/dev/null; then
    printf '\n'
    exec "$LAUNCHER" </dev/tty
  fi
  printf '\n  Run whisprflow to start.\n\n'
}

main "$@"
