#!/bin/bash
set -euo pipefail

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ $# -eq 1 ]] || fail 'Usage: bash bootstrap.sh /path/to/ed25519-signing-public.pem'
public_key=$1
[[ -f $public_key && -r $public_key ]] || fail 'Cannot read the Server release signing public key.'
public_key_pem=$(<"$public_key")
if ! printf '%s\n' "$public_key_pem" | awk '
  { sub(/\r$/, "") }
  NR == 1 { if ($0 != "-----BEGIN PUBLIC KEY-----") exit 1; next }
  closed { exit 1 }
  $0 == "-----END PUBLIC KEY-----" { closed = 1; next }
  !/^[A-Za-z0-9+\/=]+$/ { exit 1 }
  { body = 1 }
  END { if (!body || !closed) exit 1 }
'; then
  fail 'Provide a single PEM public key.'
fi

bundle=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
(
  cd -- "$bundle"
  for file in compose.yaml deployment.env images.tar.gz images.sha256; do
    [[ -f $file && -s $file ]] || fail "Missing bootstrap file: $file"
  done

  expected=$(<images.sha256)
  [[ $expected =~ ^[0-9a-f]{64}$ ]] || fail 'Invalid SHA-256 in images.sha256.'
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum images.tar.gz)
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 images.tar.gz)
  else
    fail 'Install sha256sum or shasum to verify images.tar.gz.'
  fi
  [[ ${actual%% *} == "$expected" ]] || fail 'images.tar.gz does not match images.sha256.'

  compose=(docker compose --env-file deployment.env -f compose.yaml)
  docker image load --input images.tar.gz </dev/null >&2
  recipient=$(printf '%s\n' "$public_key_pem" | "${compose[@]}" --profile bootstrap run --rm -T --no-deps config-init)
  [[ $recipient =~ ^age1[0-9a-z]{58}$ ]] || fail 'Bootstrap did not return a Server release encryption recipient.'
  "${compose[@]}" up -d --no-recreate valkey rustfs server release-worker </dev/null >&2
  printf '%s\n' "$recipient"
)
