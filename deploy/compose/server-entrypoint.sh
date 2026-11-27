#!/bin/sh
set -eu

read_secret() {
    value=$(cat "$1")
    if [ -z "$value" ]; then
        printf 'OneX secret file is empty: %s\n' "$1" >&2
        return 1
    fi
    printf '%s' "$value"
}

ONEX_MASTER_KEY=$(read_secret /run/onex-server-secrets/master.key)
ONEX_AUTH_SECRET=$(read_secret /run/onex-server-secrets/auth.key)
ONEX_RUSTFS_SECRET_KEY=$(read_secret /run/onex-object-secrets/rustfs.key)
export ONEX_MASTER_KEY ONEX_AUTH_SECRET ONEX_RUSTFS_SECRET_KEY
exec bun --no-env-file "$@"
