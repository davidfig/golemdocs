#!/bin/sh
# Makes the app's icon files from the two drawings: the desktop icon (icon.svg, with a margin and rounded corners, into
# src-tauri/icons) and the phone icon (icon-ios.svg, a full-bleed square, into src-tauri/icons/ios and the Xcode project's
# asset catalog, which `tauri ios init` fills with the Tauri logo; and the same for Android). Needs ImageMagick (`magick`) and cargo-tauri.
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
# Android launcher icons, from icon-android.svg (the same drawing with a smaller glyph: Android crops the icon to a circle or
# squircle and keeps only its middle): kept in src-tauri/icons/android and copied into the Android project.
magick -background none -density 384 icon-android.svg -resize 1024x1024 -alpha off PNG24:icon-android-1024.png
rm -rf .icon-android && cargo tauri icon icon-android-1024.png --output .icon-android
rm icon-android-1024.png
rm -rf src-tauri/icons/android && cp -R .icon-android/android src-tauri/icons/android
res=src-tauri/gen/android/app/src/main/res
if [ -d "$res" ]; then cp -R .icon-android/android/* "$res"/; fi
rm -rf .icon-android
# The adaptive icon's background is the icon's own orange (`tauri icon` makes it white), so the round or squircle mask shows no ring.
for dir in src-tauri/icons/android "$res"; do
  file="$dir/values/ic_launcher_background.xml"
  if [ -f "$file" ]; then sed -i.bak 's/#fff/#d9601f/' "$file" && rm "$file.bak"; fi
done
rm -rf .icon-ios
