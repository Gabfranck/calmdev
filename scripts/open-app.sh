#!/bin/sh
# Opens calmdev for the developer: the Mac app (desktop/, docs/desktop.md) when it is installed in /Applications or
# ~/Applications and shows this server's port; otherwise a tab of the default browser (open, xdg-open).
# The app reads the guard link itself (docs/gate.md), so it opens without the URL; the browser gets the URL as given
# (the guard link on a first run, install.sh). No Chrome app window any more (Dev, 7 Nov.: the Mac app replaces it).
#   scripts/open-app.sh <url>
# Tests: CALMDEV_OPEN_DRY=1 prints the command instead of running it; CALMDEV_OS overrides uname -s;
# CALMDEV_APPS_DIRS (colon-separated) replaces /Applications:~/Applications. Each reads CALMDEV_X, else ESCADRILLE_X.
OS_="${CALMDEV_OS:-$ESCADRILLE_OS}"; DRY="${CALMDEV_OPEN_DRY:-${ESCADRILLE_OPEN_DRY:-0}}"
APPS_DIRS="${CALMDEV_APPS_DIRS:-$ESCADRILLE_APPS_DIRS}"
URL="${1:-http://localhost:${PORT:-3078}}"
OS="${OS_:-$(uname -s)}"

# Runs the command detached (install.sh stays attached to the server), or prints it on one line in dry mode
launch() {
  if [ "$DRY" = "1" ]; then echo "$*"; return 0; fi
  "$@" >/dev/null 2>&1 &
}

# The port of a local URL (http://localhost:3078/guard?k=… → 3078), empty otherwise; shell only, no outside tool
port_of() {
  rest="${1#*://}"; host="${rest%%/*}"; host="${host%%\?*}"
  case "$host" in localhost:*|127.0.0.1:*|\[::1\]:*) echo "${host##*:}" ;; esac
}

# The port the app shows: "port" of its config.json (docs/desktop.md), else 3078
app_port() {
  p=""
  conf="$HOME/Library/Application Support/ai.calmdev.desktop/config.json"
  if [ -f "$conf" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in *'"port"'*)
        v="${line#*\"port\"}"; v="${v#*:}"; v="${v#"${v%%[! ]*}"}"; v="${v%%[!0-9]*}"; [ -n "$v" ] && p="$v" ;;
      esac
    done < "$conf"
  fi
  echo "${p:-3078}"
}

if [ "$OS" = "Darwin" ]; then
  if [ "$(port_of "$URL")" = "$(app_port)" ]; then
    rest="${APPS_DIRS:-/Applications:$HOME/Applications}:"
    while [ -n "$rest" ]; do
      d="${rest%%:*}"; rest="${rest#*:}"
      if [ -n "$d" ] && [ -d "$d/calmdev.app" ]; then launch open "$d/calmdev.app"; exit 0; fi
    done
  fi
  FALLBACK=open
else
  FALLBACK=xdg-open
fi

if command -v "$FALLBACK" >/dev/null 2>&1; then launch "$FALLBACK" "$URL"
else echo "Open $URL in your browser."; fi
