#!/usr/bin/env bash
# Install session-context.
#   ./install.sh extension          link the OMP extension on this machine
#   ./install.sh mod [host]         copy the Herdr Desktop mod to this machine, or to HOST over ssh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
case "${1:-}" in
  extension)
    mkdir -p "$HOME/.omp/agent/extensions"
    ln -sfn "$HERE/extension" "$HOME/.omp/agent/extensions/session-context"
    echo "linked $HOME/.omp/agent/extensions/session-context"
    ;;
  mod)
    HOST="${2:-}"
    DEST=".config/herdr-app/mods/session-context/"
    if [ -n "$HOST" ]; then
      rsync -a --delete --exclude '*.test.js' "$HERE/herdr-mod/" "$HOST:$DEST"
    else
      mkdir -p "$HOME/$DEST"
      rsync -a --delete --exclude '*.test.js' "$HERE/herdr-mod/" "$HOME/$DEST"
    fi
    echo "installed mod; see README to add the block to your layout"
    ;;
  *)
    echo "usage: $0 extension | mod [host]" >&2
    exit 2
    ;;
esac
