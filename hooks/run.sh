#!/bin/sh
# Finds a Node.js binary even when the agent launches hooks with a minimal PATH
# (GUI apps on macOS don't see nvm/volta/fnm), then runs emit.js.
# Never fails: without Node it swallows stdin and exits 0.

case "$0" in */*) DIR="${0%/*}" ;; *) DIR="." ;; esac
NODE="${CHIBISCOPE_NODE:-$(command -v node 2>/dev/null)}"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  NODE=""
  for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.volta/bin/node "$HOME"/.local/share/fnm/aliases/default/bin/node "$HOME"/.nvm/versions/node/*/bin/node /usr/bin/node; do
    if [ -x "$c" ]; then NODE="$c"; break; fi
  done
fi

if [ -z "$NODE" ]; then
  input="$(cat)"
  if [ "$1" = "cursor" ]; then
    case "$input" in *beforeSubmitPrompt*) printf '{"continue":true}' ;; *) printf '{}' ;; esac
  fi
  exit 0
fi

exec "$NODE" "$DIR/emit.js" "$@"
