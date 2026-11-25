#!/bin/sh
set -eu

artifact=$1
desktop_pid=$2
bundle=$3
installer=$4

cleanup() {
  /bin/rm -f -- "$artifact"
  /bin/rmdir -- "$(/usr/bin/dirname "$artifact")" 2>/dev/null || :
}
trap cleanup EXIT

remaining=120
while kill -0 "$desktop_pid" 2>/dev/null; do
  [ "$remaining" -gt 0 ] || exit 1
  remaining=$((remaining - 1))
  /bin/sleep 0.1
done

# A new Installer instance lets us wait for the user's install or cancellation.
# Reopen the bundle on disk in either case, with the old version still available on cancellation.
/usr/bin/open -n -W -a "$installer" "$artifact" || :
/usr/bin/open -a "$bundle"
