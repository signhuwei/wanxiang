#!/bin/sh
set -eu
resources=$(cd "$(dirname "$0")" && pwd)
workspace="$HOME/OneX Workspace"
(umask 077; mkdir -p "$workspace")
cd "$workspace"
exec "$resources/onex/bin/onex" run codex --managed
