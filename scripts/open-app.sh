#!/bin/sh
# Opens Escadrille in its own window (no tabs, no address bar): a Chromium browser in --app mode with a
# separate profile in ~/.escadrille/app-profile, so the window keeps its own icon and size and never mixes
# with the tabs of the browser. No Chromium browser found: the usual open (open, xdg-open), and a line says so.
#   scripts/open-app.sh <url>
# The installed app first: when Chrome (or Edge, Brave, Chromium) has installed Escadrille as an app (the line in the
# sidebar, public/manifest.webmanifest), it opens by its id, --app-id, borderless; the id is the one Chrome derives from the
# manifest id (the SHA-256 of "<origin>/", first 16 bytes, each hex digit shifted to a-p) and is looked up in the profiles
# (<data>/<profile>/Web Applications/Manifest Resources/<id>). No installed app: the --app window below.
# Tests: ESCADRILLE_BROWSER_DATA replaces the folder of the browsers' data (~/Library/Application Support, ~/.config);
# ESCADRILLE_OPEN_DRY=1 prints the command instead of running it; ESCADRILLE_OS overrides uname -s;
# ESCADRILLE_APPS_DIRS (colon-separated) replaces /Applications:~/Applications; ESCADRILLE_APP_PROFILE the profile folder.
# Each variable reads CALMDEV_X first, else ESCADRILLE_X (lib/names.mjs); the home folder is ~/.calmdev, else
# ~/.escadrille when only the old one exists (a browser profile is never moved under a running window).
NEW_DIR=".calmdev"; OLD_DIR=".escadrille"   # the names of lib/names.mjs (PROJECT_DIR, LEGACY_PROJECT_DIR)
HOME_DIR="$HOME/$NEW_DIR"; [ ! -d "$HOME_DIR" ] && [ -d "$HOME/$OLD_DIR" ] && HOME_DIR="$HOME/$OLD_DIR"
ESCADRILLE_OS="${CALMDEV_OS:-$ESCADRILLE_OS}"; ESCADRILLE_APP_PROFILE="${CALMDEV_APP_PROFILE:-$ESCADRILLE_APP_PROFILE}"
ESCADRILLE_OPEN_DRY="${CALMDEV_OPEN_DRY:-$ESCADRILLE_OPEN_DRY}"; ESCADRILLE_APPS_DIRS="${CALMDEV_APPS_DIRS:-$ESCADRILLE_APPS_DIRS}"
ESCADRILLE_BROWSER_DATA="${CALMDEV_BROWSER_DATA:-$ESCADRILLE_BROWSER_DATA}"
URL="${1:-http://localhost:${PORT:-3078}}"
OS="${ESCADRILLE_OS:-$(uname -s)}"
PROFILE="${ESCADRILLE_APP_PROFILE:-$HOME_DIR/app-profile}"
SIZE="1440,900"   # the browser shrinks a window to the screen it opens on
DRY="${ESCADRILLE_OPEN_DRY:-0}"

# Runs the command, or prints it (one line) in dry mode; the browser is detached so install.sh stays attached to the server.
launch() {
  if [ "$DRY" = "1" ]; then echo "$*"; return 0; fi
  "$@" >/dev/null 2>&1 &
}

# Is <name>.app in one of the application folders?
has_app() {
  rest="$DIRS:"
  while [ -n "$rest" ]; do
    d="${rest%%:*}"; rest="${rest#*:}"
    [ -n "$d" ] && [ -d "$d/$1.app" ] && return 0
  done
  return 1
}

# The id Chrome gives the installed app of this origin; empty when no SHA-256 tool exists
ORIGIN=$(printf '%s' "$URL" | sed -E 's#^(https?://[^/?\#]+).*#\1#')
if command -v shasum >/dev/null 2>&1; then SUM=$(printf '%s/' "$ORIGIN" | shasum -a 256)
elif command -v sha256sum >/dev/null 2>&1; then SUM=$(printf '%s/' "$ORIGIN" | sha256sum)
else SUM=""; fi
APPID=$(printf '%s' "$SUM" | cut -c1-32 | tr '0123456789abcdef' 'abcdefghijklmnop')

# The profile folder (Default, Profile 1...) of data folder $1 where the app is installed; prints it, returns 1 when none
installed_profile() {
  [ -n "$APPID" ] || return 1
  for d in "$1"/*/; do
    [ -d "${d}Web Applications/Manifest Resources/$APPID" ] && { basename "$d"; return 0; }
  done
  return 1
}

mkdir_profile() { [ "$DRY" = "1" ] || mkdir -p "$PROFILE" 2>/dev/null; }

if [ "$OS" = "Darwin" ]; then
  DIRS="${ESCADRILLE_APPS_DIRS:-/Applications:$HOME/Applications}"
  # Arc is left out on purpose: it ignores --app.
  DATA="${ESCADRILLE_BROWSER_DATA:-$HOME/Library/Application Support}"
  for app in "Google Chrome|Google/Chrome" "Microsoft Edge|Microsoft Edge" "Brave Browser|BraveSoftware/Brave-Browser" "Chromium|Chromium"; do
    dir="${app#*|}"; app="${app%%|*}"
    if has_app "$app"; then
      if prof=$(installed_profile "$DATA/$dir"); then
        launch open -na "$app" --args "--profile-directory=$prof" "--app-id=$APPID"
        exit 0
      fi
      mkdir_profile
      launch open -na "$app" --args "--app=$URL" "--user-data-dir=$PROFILE" "--window-size=$SIZE" --no-first-run --no-default-browser-check
      exit 0
    fi
  done
  FALLBACK=open
else
  DATA="${ESCADRILLE_BROWSER_DATA:-$HOME/.config}"
  for b in google-chrome:google-chrome google-chrome-stable:google-chrome chromium:chromium chromium-browser:chromium microsoft-edge:microsoft-edge brave-browser:BraveSoftware/Brave-Browser; do
    dir="${b#*:}"; b="${b%%:*}"
    if command -v "$b" >/dev/null 2>&1; then
      if prof=$(installed_profile "$DATA/$dir"); then
        launch "$b" "--profile-directory=$prof" "--app-id=$APPID"
        exit 0
      fi
      mkdir_profile
      launch "$b" "--app=$URL" "--user-data-dir=$PROFILE" "--window-size=$SIZE" --no-first-run --no-default-browser-check
      exit 0
    fi
  done
  FALLBACK=xdg-open
fi

if command -v "$FALLBACK" >/dev/null 2>&1; then
  echo "No Chromium browser found (Chrome, Edge, Brave, Chromium): opening $URL in a tab of the default browser."
  launch "$FALLBACK" "$URL"
else
  echo "No Chromium browser found and no $FALLBACK: open $URL in your browser."
fi
