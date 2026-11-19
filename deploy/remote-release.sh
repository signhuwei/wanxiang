#!/usr/bin/env bash
set -euo pipefail
umask 077
home=$HOME/apps/onex
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

activate() {
  local revision=$1 previous=$2
  if [[ -n $previous ]]; then ONEX_HOME=$home bash "$releases/$previous/deploy/onex.sh" stop; fi
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
  local response port=${ONEX_PORT:-18700}
  if [[ -f $home/service.env ]]; then
    port=$(source "$home/service.env"; printf '%s' "${ONEX_PORT:-18700}")
  fi
  [[ $port =~ ^[1-9][0-9]{0,4}$ && $port -le 65535 ]] || return 1
  response=$(curl -fsS --max-time 3 "http://127.0.0.1:$port/v1/healthz") || return 1
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
