#!/bin/sh
# Packages the app, installs it into Applications, and opens it. An existing install is replaced, and a running one quits first.
# Usage: npm run install-app
set -eu
cd "$(dirname "$0")/../.."
name="$(node -p "require('./package.json').productName")"
target="/Applications/$name.app"

npm run dist
built="dist/$name-darwin-$(node -p process.arch)/$name.app"

# A running copy must quit first: the installed app can't be replaced while running, and a command-started one holds the same home directory,
# so the newly installed app would find "one is already running" and fail to start. whisprflow stop handles both and waits until the process has really exited
node bin/whisprflow.mjs stop
rm -rf "$target"
ditto "$built" "$target"
echo "Installed: $target"
open "$target"
