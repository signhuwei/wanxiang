#!/bin/sh
set -eu
resources=$(cd "$(dirname "$0")" && pwd)
cd "$HOME"
exec "$resources/onex/bin/onex" run codex --managed
