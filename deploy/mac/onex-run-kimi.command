#!/bin/sh
set -eu
resources=$(cd "$(dirname "$0")" && pwd)
cd "${1:-$HOME}"
exec "$resources/onex/bin/onex" run kimi-code --managed
