#!/bin/sh
# Builds TREM-Lite Native.app from the release binary, signed ad hoc: enough to run on
# the machine that built it. Not notarized, so another Mac needs right-click > Open.
set -eu

cd "$(dirname "$0")/.."
cargo build --release

app="target/release/TREM-Lite Native.app"
icon="assets/icons/icon.icns"
version="$(sed -n 's/^version = "\(.*\)"$/\1/p' Cargo.toml | head -n 1)"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp target/release/trem-lite-native "$app/Contents/MacOS/trem-lite-native"
cp "$icon" "$app/Contents/Resources/icon.icns"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>TREM-Lite Native</string>
  <key>CFBundleDisplayName</key><string>TREM Lite</string>
  <key>CFBundleIdentifier</key><string>com.exptech.trem-lite.native</string>
  <key>CFBundleExecutable</key><string>trem-lite-native</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
codesign --force --deep --sign - "$app"
echo "built: apps/native/$app"
