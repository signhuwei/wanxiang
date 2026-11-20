#!/usr/bin/env bash
set -euo pipefail
umask 077
home=$1
release=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
exec 9>"$home/run/release-worker.lock"
flock -n 9 || exit 0
if [[ -f $home/service.env ]]; then
  set -a
  source "$home/service.env"
  set +a
fi
exec "$home/deps/bin/bun" --no-env-file "$release/deploy/server-release-worker.ts" "$home"
