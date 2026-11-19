#!/usr/bin/env bash
set -euo pipefail
umask 077
home=$1
service=$2
release=$3
bin=$home/deps/bin
export ONEX_PORT=${ONEX_PORT:-18700} ONEX_VALKEY_PORT=${ONEX_VALKEY_PORT:-18701} ONEX_RUSTFS_PORT=${ONEX_RUSTFS_PORT:-18702}
export ONEX_HOST=${ONEX_HOST:-127.0.0.1}
export ONEX_DATA_DIR=$home/data/server ONEX_VALKEY_URL=redis://127.0.0.1:$ONEX_VALKEY_PORT
export ONEX_COMMIT=$(basename "$release")
if [[ ! $ONEX_COMMIT =~ ^[0-9a-f]{40}$ ]]; then export ONEX_COMMIT=local; fi
exec > >("$bin/bun" "$release/deploy/rotate-log.ts" "$home/logs" "$service") 2>&1
case "$service" in
  valkey) exec "$bin/valkey-server" --bind 127.0.0.1 --port "$ONEX_VALKEY_PORT" --dir "$home/data/valkey" --appendonly yes;;
  rustfs)
    export RUSTFS_ACCESS_KEY=onex-sidecar
    RUSTFS_SECRET_KEY=$(<"$home/secrets/rustfs.key")
    export RUSTFS_SECRET_KEY
    export RUSTFS_ADDRESS=127.0.0.1:$ONEX_RUSTFS_PORT RUSTFS_CONSOLE_ENABLE=false
    exec "$bin/rustfs" "$home/data/rustfs";;
  server)
    ONEX_MASTER_KEY=$(<"$home/secrets/master.key")
    ONEX_AUTH_SECRET=$(<"$home/secrets/auth.key")
    export ONEX_MASTER_KEY ONEX_AUTH_SECRET
    cd "$release/server"
    exec "$bin/bun" --no-env-file src/index.ts;;
  *) exit 2;;
esac
