#!/bin/sh
# Makes the desktop app's icon files (src-tauri/icons) from icon.svg. Needs ImageMagick (`magick`) and cargo-tauri.
set -e
cd "$(dirname "$0")"
magick -background none -density 384 icon.svg -resize 1024x1024 PNG32:icon-1024.png
cargo tauri icon icon-1024.png
rm icon-1024.png
