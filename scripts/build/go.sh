#!/bin/sh
# Runs a go command with the project's own Go: scripts/build/go.sh build ...
# The Windows native helper (native/windows/) is written in Go and cross-compiled to an exe on a Mac. Go isn't installed system-wide: on first use the
# pinned version is downloaded, its SHA-256 checked, and unpacked into .tools/go; module and build caches live in .tools too, so deleting .tools/go* cleans up.
set -eu

VERSION=go1.27.2
# The checksums of this version's Mac packages for both chips, from go.dev/dl/?mode=json
SHA256_arm64=76812b213b1b2302c978d28fa52fa92d541704b9e7d9d5db8002c50e4018c4c5
SHA256_amd64=587b59182488b23aa6e5fc25110405a3e0e5b38ed2f5b2f46ed13c32aee356fe

root="$(cd "$(dirname "$0")/../.." && pwd)"
tools="$root/.tools"
goroot="$tools/go"

if [ "$("$goroot/bin/go" env GOVERSION 2>/dev/null || true)" != "$VERSION" ]; then
  case "$(uname -m)" in
    arm64) arch=arm64 sha256=$SHA256_arm64 ;;
    x86_64) arch=amd64 sha256=$SHA256_amd64 ;;
    *) echo "go.sh: unknown chip $(uname -m)" >&2; exit 1 ;;
  esac
  archive="$tools/$VERSION.darwin-$arch.tar.gz"
  mkdir -p "$tools"
  echo "go.sh: downloading ${VERSION} (only this once)" >&2
  curl -fsSL --retry 2 -o "$archive" "https://go.dev/dl/$VERSION.darwin-$arch.tar.gz"
  actual="$(shasum -a 256 "$archive" | cut -d' ' -f1)"
  if [ "$actual" != "$sha256" ]; then
    rm -f "$archive"
    echo "go.sh: checksum mismatch for ${VERSION}: expected ${sha256}, got ${actual}" >&2
    exit 1
  fi
  rm -rf "$goroot"
  tar -xzf "$archive" -C "$tools"
  rm -f "$archive"
fi

export GOROOT="$goroot"
export GOPATH="$tools/go-path"
export GOMODCACHE="$tools/go-path/pkg/mod"
export GOCACHE="$tools/go-cache"
# Don't let Go download toolchains of other versions by itself
export GOTOOLCHAIN=local
exec "$goroot/bin/go" "$@"
