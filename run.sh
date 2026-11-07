#!/bin/sh
# Starts Escadrille on http://localhost:3078, this Mac only; ./run.sh --lan opens it to the LAN (http://192.168.1.x:3078, the phone)
# ./run.sh --open reopens the app window on a server that already runs
# A minimal supervisor: when the server exits with code 75 (a merge touched server.mjs, lib/ or run.sh), it starts
# again; any other exit ends run.sh with that code. Ctrl-C or a TERM to run.sh stops the server cleanly.
# A restart from a shell: `kill -HUP <pid of the node child>` (not run.sh's): the server exits with 75 and comes back.
cd "$(dirname "$0")" || exit 1
[ "$1" = "--open" ] && exec scripts/open-app.sh "http://localhost:${PORT:-3078}"
[ "$1" = "--lan" ] && export ESCADRILLE_HOST=0.0.0.0
export ESCADRILLE_SUPERVISED=1
entry="${ESCADRILLE_ENTRY:-server.mjs}"
child=
trap '[ -n "$child" ] && kill -TERM "$child" 2>/dev/null' TERM INT HUP
while :; do
  node --no-warnings "$entry" & child=$!
  wait "$child"; code=$?
  # a trapped signal interrupts wait: wait again for the server's own exit code
  while kill -0 "$child" 2>/dev/null; do wait "$child"; code=$?; done
  [ "$code" -eq 75 ] || exit "$code"
  echo "escadrille: restart after a merge of its own code"
done
