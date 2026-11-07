#!/bin/sh
# Installs and starts calmdev from this clone: checks Node 22.13+, git, Claude Code, bubblewrap on Linux,
# then runs ./run.sh and opens http://localhost:3078. Nothing is downloaded, nothing is installed for you.
#   ./install.sh             check, start, open the page
#   ./install.sh --no-open   check and start, without opening the page
#   ./install.sh --check     check only (exit 1 if something is missing)
#   ./install.sh --lan       passed to ./run.sh (opens the LAN, for the phone)
#   ./install.sh --tab       open a tab of the default browser even when the Mac app is installed
# The Mac app opens when installed (/Applications/calmdev.app, docs/desktop.md), else the default browser
# (scripts/open-app.sh); ./run.sh --open reopens it later.
# Run from a project folder (cd ~/Dev/my-app && ~/escadrille/install.sh), that folder becomes one of calmdev's
# projects (lib/projects.mjs, ~/.config/escadrille/projects.json); run from this clone, nothing is added.
LAUNCHED_FROM="$(pwd -P)"
cd "$(dirname "$0")" || exit 1
CLONE="$(pwd -P)"

CHECK=0; OPEN=1; TAB=0; RUN_ARGS=""
for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;;
    --no-open) OPEN=0 ;;
    --tab) TAB=1 ;;
    --lan) RUN_ARGS="--lan" ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown option: $a (--check, --no-open, --tab, --lan)" >&2; exit 2 ;;
  esac
done

PORT="${PORT:-3078}"; URL="http://localhost:$PORT"; OS="$(uname -s)"; FAIL=0
ok() { echo "  ok    $1"; }
bad() { echo "  FAIL  $1"; FAIL=1; }
warn() { echo "  warn  $1"; }

echo "calmdev: checking what it needs"

# Node 22.13 or later (node:sqlite without a flag)
if command -v node >/dev/null 2>&1; then
  V="$(node --version 2>/dev/null | sed 's/^v//')"
  MAJOR="$(echo "$V" | cut -d. -f1)"; MINOR="$(echo "$V" | cut -d. -f2)"
  case "$MAJOR$MINOR" in *[!0-9]*|'') MAJOR=0; MINOR=0 ;; esac
  if [ "$MAJOR" -gt 22 ] || { [ "$MAJOR" -eq 22 ] && [ "$MINOR" -ge 13 ]; }; then
    ok "node $V"
  else
    bad "node $V is too old: calmdev needs Node 22.13 or later.
        https://nodejs.org (the LTS), or with nvm: nvm install 22 && nvm use 22 (https://github.com/nvm-sh/nvm)"
  fi
else
  bad "node not found: install Node 22.13 or later.
        https://nodejs.org (the LTS), or with nvm: nvm install 22 && nvm use 22 (https://github.com/nvm-sh/nvm)"
fi

# git: every session works in its own worktree and branch (on macOS /usr/bin/git is a stub until the Command Line Tools exist)
if git --version >/dev/null 2>&1; then
  ok "$(git --version 2>/dev/null)"
else
  bad "git not found: sessions run in git worktrees.
        macOS: xcode-select --install   Linux: sudo apt install git"
fi

# Claude Code on the PATH, logged in by the developer (not checked here); the stream is read as Claude Code 2.1 writes it
# ESCADRILLE_CLAUDE (a path) points the server, and this check, at another binary (tests, a claude outside the PATH)
CLAUDE_BIN="${ESCADRILLE_CLAUDE:-claude}"
if command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
  CV="$("$CLAUDE_BIN" --version 2>/dev/null | head -n 1)"
  ok "claude $CV"
  case "$CV" in 2.1.*) ;; *) warn "Claude Code $CV: calmdev is tested with 2.1.x; another version may stream differently." ;; esac
  # Logged in? `claude auth status` answers offline, in JSON; only an explicit "loggedIn": false warns (an older claude
  # without the subcommand says nothing). Not a FAIL: the page works, and plans start once the login is done, no restart.
  if "$CLAUDE_BIN" auth status 2>/dev/null | grep -q '"loggedIn": *false'; then
    warn "Claude Code is not logged in: no plan can start until you do. In a terminal, run 'claude' once and type /login."
  fi
else
  bad "Claude Code is not installed (no 'claude' on your PATH): calmdev cannot start a session without it.
        Install it (not run for you), then run 'claude' once to log in:
        curl -fsSL https://claude.ai/install.sh | bash
        (or: npm install -g @anthropic-ai/claude-code)"
fi

# Linux: Claude Code's sandbox needs bubblewrap and socat; without them no session starts
if [ "$OS" = "Linux" ]; then
  for b in bwrap socat; do
    if command -v "$b" >/dev/null 2>&1; then ok "$b"; else warn "$b not found: sessions will not start without the sandbox.
        sudo apt install bubblewrap socat   (Fedora: sudo dnf install bubblewrap socat)"; fi
  done
fi

if [ "$FAIL" -ne 0 ]; then echo "Fix the lines marked FAIL, then run ./install.sh again."; exit 1; fi
if [ "$CHECK" -eq 1 ]; then echo "All set. ./install.sh starts it on $URL"; exit 0; fi

# The folder this was launched from joins the project list (not the clone itself)
case "$LAUNCHED_FROM" in
  "$CLONE") ;;
  *) node lib/projects.mjs add "$LAUNCHED_FROM" --via install || warn "$LAUNCHED_FROM was not added: add it in the page (Add a project)." ;;
esac

# Something already answers on the port (calmdev started earlier, or another app): say so instead of
# opening someone else's page while our server fails with EADDRINUSE
if node -e "fetch('$URL').then(() => process.exit(0), () => process.exit(1))" 2>/dev/null; then
  echo "Something already answers on $URL: calmdev may already be running (open that page),"
  echo "or another app uses port $PORT. To run a second copy: PORT=3079 ./install.sh"
  exit 1
fi

# Start the server, wait for it, open the page, then stay with it (Ctrl-C stops it)
./run.sh $RUN_ARGS &
PID=$!
trap 'kill "$PID" 2>/dev/null' INT TERM
i=0
until node -e "fetch('$URL').then(() => process.exit(0), () => process.exit(1))" 2>/dev/null; do
  i=$((i + 1)); if [ "$i" -gt 50 ] || ! kill -0 "$PID" 2>/dev/null; then echo "The server did not start (see above)."; exit 1; fi
  sleep 0.2
done
echo "calmdev is running on $URL (Ctrl-C stops it). Pick a project folder, then describe a feature."
# The first window opens the guard link the server just wrote: it sets the browser's guard cookie and lands on $URL, so
# adding a project and planning work at once (docs/gate.md; without it every action answers 403, docs/first-run.md)
GUARD_LINK="$(head -n 1 "${ESCADRILLE_GUARD_DIR:-$HOME/.config/escadrille}/guard-link" 2>/dev/null)"
case "$GUARD_LINK" in "$URL/guard?k="*) OPEN_URL="$GUARD_LINK" ;; *) OPEN_URL="$URL" ;; esac
if [ "$OPEN" -eq 1 ] && [ "$TAB" -eq 0 ]; then
  scripts/open-app.sh "$OPEN_URL"
elif [ "$OPEN" -eq 1 ]; then
  if [ "$OS" = "Darwin" ] && command -v open >/dev/null 2>&1; then open "$OPEN_URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$OPEN_URL" >/dev/null 2>&1 &
  else echo "Open $URL in your browser."; fi
fi
wait "$PID"
