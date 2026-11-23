#!/usr/bin/env bash
set -euo pipefail
umask 077
host=${1:-}
mode=${2:-}
if [[ ! $host =~ ^([a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$ || ( -n $mode && $mode != --rollback && $mode != --upload-deps ) ]]; then
  echo 'Usage: deploy.sh [user@]host [--rollback | --upload-deps]' >&2; exit 2
fi
root=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
if [[ $mode == --rollback ]]; then
  ssh "$host" 'bash "$HOME/apps/onex/current/deploy/remote-release.sh" rollback'
  exit
fi
bun_version=$(<"$root/deploy/bun-version")
if [[ "$(bun --version)" != "$bun_version" ]]; then
  echo "Run with Bun $bun_version" >&2
  exit 1
fi

commit=$(git -C "$root" rev-parse HEAD)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/onex-release.XXXXXXXX")
trap 'rm -rf -- "$tmp"' EXIT
mkdir "$tmp/tree"
git -C "$root" archive "$commit" server deploy | tar -xf - -C "$tmp/tree"
# Build the Linux production tree, including the target-specific DuckDB bindings.
bun install --cwd "$tmp/tree/server" --frozen-lockfile --production --ignore-scripts --os=linux --cpu=x64
if [[ $mode == --upload-deps ]]; then
  platform=$(ssh "$host" 'uname -s; uname -m; if grep -qw avx2 /proc/cpuinfo; then printf "avx2\n"; fi')
  case "$platform" in
    $'Linux\nx86_64\navx2') asset_platform=Linux-x86_64;;
    $'Linux\nx86_64') asset_platform=Linux-x86_64-baseline;;
    *) echo 'Offline asset staging requires Linux x86_64' >&2; exit 1;;
  esac
  mkdir "$tmp/tree/runtime-assets"
  ONEX_ASSET_PLATFORM=$asset_platform ONEX_ASSET_CACHE="$tmp/tree/runtime-assets" bash "$tmp/tree/deploy/install-deps.sh" --download-only
fi

tar -czf "$tmp/$commit.tar.gz" -C "$tmp/tree" .
# SSH stdin carries the archive into a fresh staging directory; activation is performed remotely.
ssh "$host" "bash -c 'set -eu
  umask 077
  home=\"\$HOME/apps/onex\"
  mkdir -p \"\$home/releases\"
  stage=\$(mktemp -d \"\$home/releases/.incoming.XXXXXXXX\")
  cleanup() { rm -rf -- \"\$stage\"; }
  trap cleanup EXIT
  tar -xzf - -C \"\$stage\"
  bash \"\$stage/deploy/remote-release.sh\" deploy $commit \"\$stage\"
'" < "$tmp/$commit.tar.gz"
