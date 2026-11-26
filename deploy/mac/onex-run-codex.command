#!/bin/sh
set -eu
resources=$(cd "$(dirname "$0")" && pwd)
workspace="${1:-$HOME/OneX Workspace}"
if [ "$#" -eq 0 ]; then
  (umask 077; mkdir -p "$workspace")
fi
cd "$workspace"
exec "$resources/onex/bin/onex" run codex --managed
