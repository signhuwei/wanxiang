#!/usr/bin/env bash
set -euo pipefail
umask 077
bun_version=$(<"$(dirname -- "${BASH_SOURCE[0]}")/bun-version")

home=${ONEX_HOME:-$HOME/apps/onex}
cache=${ONEX_ASSET_CACHE:-$home/cache}
platform=${ONEX_ASSET_PLATFORM:-$(uname -s)-$(uname -m)}
mode=${1:---install}
case "$mode" in --install|--download-only|--offline) ;; *) echo 'Usage: install-deps.sh [--download-only | --offline]' >&2; exit 2;; esac
mkdir -p "$cache"

case "$platform" in
  Darwin-arm64)
    bun_asset=bun-darwin-aarch64
    bun_sha=b5d6bc2e13caf14e57c89661e89efd073ff16165b41bfe43882616410609cd10
    valkey_url=https://github.com/valkey-io/valkey/archive/refs/tags/8.1.5.tar.gz
    valkey_file=valkey-8.1.5-src.tar.gz
    valkey_sha=2d47a6afaec7a5383813579c2367193053ec885bc135e810284fe94ccdd324d2
    rustfs_asset=rustfs-macos-aarch64-v1.0.6
    rustfs_sha=e0bf7e8aeee45490034576fde6513377db81844d8c40e24c57269e9bb274882f
    ;;
  Linux-x86_64|Linux-x86_64-baseline)
    if [[ $(uname -s) != Linux && $mode != --download-only ]]; then echo 'Cannot install Linux binaries on macOS' >&2; exit 2; fi
    if [[ $platform == Linux-x86_64-baseline ]] || { [[ -z ${ONEX_ASSET_PLATFORM:-} && $(uname -s) == Linux ]] && ! grep -qw avx2 /proc/cpuinfo; }; then
      bun_asset=bun-linux-x64-baseline
      bun_sha=dcb23a18a1c2fff12d57bcef696dbbb42eb67fde29f43816ecb595459a24c463
    else
      bun_asset=bun-linux-x64
      bun_sha=94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb
    fi
    valkey_file=valkey-8.1.5-jammy-x86_64.tar.gz
    valkey_url=https://download.valkey.io/releases/$valkey_file
    valkey_sha=9f5b1fc5c4599e71dc03de5bc4fe1c619d6881d0230f9877b3d470c36a635789
    rustfs_asset=rustfs-linux-x86_64-musl-v1.0.6
    rustfs_sha=a4d109a09857c04bf5d11b2cec0fbbf0887819b9392e5d46d7d153dae6a1398f
    ;;
  *) echo "Unsupported platform: $platform" >&2; exit 2;;
esac

work=$(mktemp -d "${TMPDIR:-/tmp}/onex-deps.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
sha() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d ' ' -f1; else shasum -a 256 "$1" | cut -d ' ' -f1; fi
}
asset() {
  local file=$1 url=$2 hash=$3 tmp
  if [[ -f $cache/$file && $(sha "$cache/$file") == "$hash" ]]; then return; fi
  if [[ $mode == --offline ]]; then echo "Missing or invalid checked asset: $file" >&2; return 1; fi
  tmp=$(mktemp "$cache/.download.XXXXXXXX")
  if ! curl --fail --silent --show-error --location --retry 2 --proto '=https' --proto-redir '=https' --output "$tmp" "$url"; then
    rm -f -- "$tmp"
    echo "Could not download $file. If your network requires a proxy, set HTTPS_PROXY." >&2
    return 1
  fi
  if [[ $(sha "$tmp") != "$hash" ]]; then
    rm -f -- "$tmp"
    echo "SHA-256 verification failed for $file" >&2
    return 1
  fi
  mv -f -- "$tmp" "$cache/$file"
}

bun_zip=$bun_asset-$bun_version.zip
rustfs_zip=$rustfs_asset.zip
bun_url=https://github.com/oven-sh/bun/releases/download/bun-v$bun_version/$bun_asset.zip
rustfs_url=https://github.com/rustfs/rustfs/releases/download/1.0.6/$rustfs_zip
if [[ $mode == --download-only ]]; then
  asset "$bun_zip" "$bun_url" "$bun_sha"
  asset "$valkey_file" "$valkey_url" "$valkey_sha"
  asset "$rustfs_zip" "$rustfs_url" "$rustfs_sha"
  exit
fi

bin=$home/deps/bin
mkdir -p "$bin"
put() {
  install -m 0755 "$1" "$bin/.$2.new.$$"
  mv -f -- "$bin/.$2.new.$$" "$bin/$2"
}
if [[ ! -x $bin/bun || $("$bin/bun" --version) != "$bun_version" ]]; then
  asset "$bun_zip" "$bun_url" "$bun_sha"
  mkdir "$work/bun"
  unzip -q "$cache/$bun_zip" -d "$work/bun"
  checked_bun=$work/bun/$bun_asset/bun
  [[ $("$checked_bun" --version) == "$bun_version" ]] || { echo "Expected Bun $bun_version" >&2; exit 1; }
  put "$checked_bun" bun
fi
if [[ ! -x $bin/valkey-server || ! -x $bin/valkey-cli || $("$bin/valkey-server" --version) != *'v=8.1.5 '* ]]; then
  asset "$valkey_file" "$valkey_url" "$valkey_sha"
  mkdir "$work/valkey"
  tar -xzf "$cache/$valkey_file" -C "$work/valkey"
  if [[ $platform == Darwin-arm64 ]]; then
    # Official macOS binaries are not published. No TLS needed for the localhost sidecar.
    make -C "$work/valkey/valkey-8.1.5" -j "$(sysctl -n hw.logicalcpu)" BUILD_TLS=no MALLOC=libc
  fi
  for name in valkey-server valkey-cli; do
    file=$(find "$work/valkey" -type f -name "$name" -print -quit)
    [[ -n $file ]] || { echo "Valkey archive did not produce $name" >&2; exit 1; }
    put "$file" "$name"
  done
fi
if [[ ! -x $bin/rustfs || ! $("$bin/rustfs" --version) =~ (^|[[:space:]])v?1[.]0[.]6($|[[:space:]]) ]]; then
  asset "$rustfs_zip" "$rustfs_url" "$rustfs_sha"
  mkdir "$work/rustfs"
  unzip -q "$cache/$rustfs_zip" -d "$work/rustfs"
  file=$(find "$work/rustfs" -type f -name rustfs -print -quit)
  [[ -n $file ]] || { echo 'RustFS archive did not contain rustfs' >&2; exit 1; }
  put "$file" rustfs
fi
printf 'OneX dependencies ready: %s\n' "$bin"
