#!/usr/bin/env bash
set -euo pipefail
umask 077
home=${ONEX_HOME:-$HOME/apps/onex}
releases=$home/releases
current=$home/current
mkdir -p "$home/run"
exec 9>"$home/run/deploy.lock"
flock -n 9 || { echo 'Another OneX deployment is running' >&2; exit 1; }

link() {
  ln -s -- "$1" "$home/.current.$$"
  mv -Tf -- "$home/.current.$$" "$current"
}
valid_release() { [[ $1 =~ ^[0-9a-f]{40}$ && -f $releases/$1/deploy/onex.sh && ! -L $releases/$1 ]]; }
current_commit() {
  local target
  if [[ -L $current ]]; then
    target=$(readlink "$current")
    [[ $target = releases/* ]] && valid_release "${target#releases/}" || { echo 'Unexpected current link; refusing activation' >&2; return 1; }
    printf '%s\n' "${target#releases/}"
  elif [[ -e $current ]]; then echo 'Current must be a symlink' >&2; return 1; fi
}

backup_databases() (
  set -e
  shopt -s nullglob
  local data=$home/data/server output=$home/backups tmp file
  local files=()
  for file in "$data"/system.sqlite{,-wal,-shm} "$data"/tenant-*.sqlite "$data"/tenant-*.sqlite-{wal,shm}; do
    if [[ -f $file && ! -L $file ]]; then files+=("${file##*/}"); fi
  done
  [[ ${#files[@]} -gt 0 ]] || return 0
  mkdir -p "$output" || exit 1
  tmp=$(mktemp "$output/.server-db.XXXXXXXX") || exit 1
  trap 'rm -f -- "$tmp"' EXIT
  tar -czf "$tmp" -C "$data" -- "${files[@]}" || exit 1
  mv -- "$tmp" "$output/server-db-$(date -u +%Y%m%dT%H%M%S)-$1.tar.gz"
)

activate() {
  local revision=$1 previous=$2
  if [[ -n $previous ]]; then
    ONEX_HOME=$home bash "$releases/$previous/deploy/onex.sh" stop
    if ! backup_databases "$previous"; then
      echo 'Could not back up OneX databases; restarting current release' >&2
      ONEX_HOME=$home bash "$releases/$previous/deploy/onex.sh" start
      return 1
    fi
  fi
  link "releases/$revision"
  if ONEX_HOME=$home bash "$current/deploy/onex.sh" start && check_health "$revision"; then
    printf '%s\n' "$revision" > "$home/run/active-revision"
    if [[ -n $previous && $previous != "$revision" ]]; then printf '%s\n' "$previous" > "$home/run/previous-revision"; fi
    return
  fi
  echo "Release $revision did not become healthy" >&2
  if ! ONEX_HOME=$home bash "$current/deploy/onex.sh" stop; then
    echo 'Could not stop failed release; inspect systemd before rollback' >&2; return 1
  fi
  if [[ -n $previous && $previous != "$revision" ]]; then
    link "releases/$previous"
    echo "Attempting to restart $previous with the existing data" >&2
    ONEX_HOME=$home bash "$current/deploy/onex.sh" start && check_health "$previous" || echo 'Previous release failed; check schema compatibility and restore a backup if needed' >&2
  elif [[ -z $previous ]]; then rm -f -- "$current"; fi
  return 1
}

check_health() {
  local response address=${ONEX_HOST:-127.0.0.1} port=${ONEX_PORT:-18700}
  if [[ -f $home/service.env ]]; then
    read -r address port < <(source "$home/service.env"; printf '%s %s\n' "${ONEX_HOST:-127.0.0.1}" "${ONEX_PORT:-18700}") || return 1
  fi
  [[ $address =~ ^[a-zA-Z0-9.:_-]+$ && $port =~ ^[1-9][0-9]{0,4}$ && $port -le 65535 ]] || return 1
  case "$address" in 0.0.0.0) address=127.0.0.1;; ::) address='[::1]';; *:*) address="[$address]";; esac
  response=$(curl --noproxy '*' -fsS --max-time 3 "http://$address:$port/v1/healthz") || return 1
  "$home/deps/bin/bun" --no-env-file -e 'const row=JSON.parse(process.argv[1]); if(row.status!=="ok" || row.commit!==process.argv[2]) process.exit(1);' -- "$response" "$1"
}

prune() {
  local revision preserved=$1 keep=1
  if [[ -n $preserved && $preserved != "$2" ]] && valid_release "$preserved"; then ((keep+=1)); fi
  while read -r revision; do
    if ! valid_release "$revision" || [[ $revision == "$2" || $revision == "$preserved" ]]; then continue; fi
    if [[ $keep -lt 5 ]]; then
      ((keep+=1))
    else
      rm -rf -- "$releases/$revision"
    fi
  done < <(find "$releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | sort -rn | cut -d ' ' -f2)
}

previous=$(current_commit)
case ${1:-} in
  deploy)
    revision=$2 stage=$3
    if [[ -n ${4:-} && $4 != "$previous" ]]; then
      echo 'OneX active release changed before activation' >&2; exit 1
    fi
    [[ $revision =~ ^[0-9a-f]{40}$ && $stage == "$releases/.incoming."* && -d $stage/server/node_modules ]] || exit 2
    if [[ -d $stage/runtime-assets ]]; then
      ONEX_HOME=$home ONEX_ASSET_CACHE=$stage/runtime-assets bash "$stage/deploy/install-deps.sh" --offline
      rm -rf -- "$stage/runtime-assets"
    else
      ONEX_HOME=$home bash "$stage/deploy/install-deps.sh"
    fi
    if [[ -e $releases/$revision || -L $releases/$revision ]]; then
      valid_release "$revision" || { echo 'Existing release path is not a valid release' >&2; exit 2; }
    else
      mv -T -- "$stage" "$releases/$revision"
    fi
    activate "$revision" "$previous"
    prune "$previous" "$revision"
    ;;
  rollback)
    [[ -n $previous && -f $home/run/previous-revision ]] || { echo 'There is no previous release to roll back to' >&2; exit 1; }
    revision=$(<"$home/run/previous-revision")
    valid_release "$revision" && [[ $revision != "$previous" ]] || { echo 'Previous release is not available' >&2; exit 1; }
    activate "$revision" "$previous"
    ;;
  *) exit 2;;
esac
printf 'OneX healthy at %s\n' "$revision"
