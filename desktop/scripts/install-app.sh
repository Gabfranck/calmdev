#!/bin/sh
# Builds the release app and puts it in /Applications/calmdev.app (docs/desktop.md). Run again after a change to
# desktop/ to update it. The build target lives outside the repository; nothing is signed or published.
cd "$(dirname "$0")/.." || exit 1
TARGET="${CARGO_TARGET_DIR:-$HOME/Library/Caches/calmdev-desktop-target}"
DEST="${CALMDEV_APP_DEST:-/Applications}"
CARGO_TARGET_DIR="$TARGET" npx tauri build --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}' || exit 1 # no update key on this Mac
APP="$TARGET/release/bundle/macos/calmdev.app"
[ -d "$APP" ] || { echo "No app built at $APP" >&2; exit 1; }
if pgrep -xq calmdev; then echo "calmdev is open: quit it, then run this again." >&2; exit 1; fi
rm -rf "$DEST/calmdev.app.new" && cp -R "$APP" "$DEST/calmdev.app.new" && rm -rf "$DEST/calmdev.app" && mv "$DEST/calmdev.app.new" "$DEST/calmdev.app" || exit 1
echo "Installed: $DEST/calmdev.app"
