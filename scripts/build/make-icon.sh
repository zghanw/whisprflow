#!/bin/sh
# Regenerates the icons from the svgs in assets: icon.svg to icon.icns (app icon), tray.svg to trayTemplate.png and @2x (menu bar),
# icon.svg to icon.ico (the Windows app icon, used by the exe, the Start menu, and the notification area).
# Only needed after changing the icons; the generated files are committed.
# Needs rsvg-convert (brew install librsvg) and the system's iconutil.
set -eu
cd "$(dirname "$0")/../.."
iconset="$(mktemp -d)/icon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  rsvg-convert -w "$size" -h "$size" assets/icon.svg -o "$iconset/icon_${size}x${size}.png"
  rsvg-convert -w "$((size * 2))" -h "$((size * 2))" assets/icon.svg -o "$iconset/icon_${size}x${size}@2x.png"
done
iconutil --convert icns "$iconset" --output assets/icon.icns
rm -rf "$(dirname "$iconset")"
# Menu bar icons at 16 and 32 (@2x). The file name contains Template so macOS inverts it for light and dark menu bars
rsvg-convert -w 16 -h 16 assets/tray.svg -o assets/trayTemplate.png
rsvg-convert -w 32 -h 32 assets/tray.svg -o assets/trayTemplate@2x.png
# The Windows icon drops the macOS white margin: only the rounded square. Notification area icons don't invert with the taskbar, so this colored one is used
work="$(mktemp -d)"
sed 's|viewBox="0 0 1024 1024"|viewBox="100 100 824 824"|' assets/icon.svg > "$work/square.svg"
pngs=""
for size in 16 20 24 32 40 48 64 128 256; do
  rsvg-convert -w "$size" -h "$size" "$work/square.svg" -o "$work/$size.png"
  pngs="$pngs $work/$size.png"
done
# shellcheck disable=SC2086
node scripts/build/make-ico.mjs assets/icon.ico $pngs
rm -rf "$work"
echo "Generated assets/icon.icns, assets/trayTemplate.png, assets/trayTemplate@2x.png, assets/icon.ico"
