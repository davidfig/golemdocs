#!/bin/sh
# Makes the app's icon files from the two drawings: the desktop icon (icon.svg, with a margin and rounded corners, into
# src-tauri/icons) and the phone icon (icon-ios.svg, a full-bleed square, into src-tauri/icons/ios and the Xcode project's
# asset catalog, which `tauri ios init` fills with the Tauri logo). Needs ImageMagick (`magick`) and cargo-tauri.
set -e
cd "$(dirname "$0")"
magick -background none -density 384 icon.svg -resize 1024x1024 PNG32:icon-1024.png
cargo tauri icon icon-1024.png
rm icon-1024.png

# The phone icon: `tauri icon` writes every platform, so only its iOS files are kept (into a temporary folder first).
magick -background none -density 384 icon-ios.svg -resize 1024x1024 -alpha off PNG24:icon-ios-1024.png
rm -rf .icon-ios && cargo tauri icon icon-ios-1024.png --output .icon-ios
rm icon-ios-1024.png
rm -rf src-tauri/icons/ios && cp -R .icon-ios/ios src-tauri/icons/ios
catalog=src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset
if [ -d "$catalog" ]; then cp .icon-ios/ios/*.png "$catalog"/; fi
rm -rf .icon-ios
