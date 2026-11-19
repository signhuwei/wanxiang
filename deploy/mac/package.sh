#!/bin/bash
set -euo pipefail

if [[ $# != 5 && $# != 6 ]]; then
  echo 'Usage: package.sh <OneX Desktop.app> <onex> <onexd> <server-origin> <output.pkg> [--release]' >&2
  exit 2
fi

[[ $(uname -m) == arm64 ]] || { echo 'Build this package on an Apple Silicon Mac.' >&2; exit 2; }

app=$1
cli=$2
daemon=$3
origin=${4%/}
output=$5
release=0
if [[ $# == 6 ]]; then
  [[ $6 == --release ]] || { echo 'Usage: package.sh <OneX Desktop.app> <onex> <onexd> <server-origin> <output.pkg> [--release]' >&2; exit 2; }
  release=1
fi
scripts=$(cd "$(dirname "$0")" && pwd)
identifier=com.onex.desktop
agent=$identifier.edge

# Reject existing output paths, including dangling symlinks.
if [[ $output != *.pkg ]] || [[ -e $output || -L $output ]]; then
  echo 'Choose a new .pkg output path.' >&2
  exit 2
fi
[[ $origin =~ ^https?://([a-zA-Z0-9._-]+|\[[0-9A-Fa-f:]+\])(:[0-9]+)?$ ]] || {
  echo 'Server origin must be an HTTP or HTTPS origin with no path.' >&2
  exit 2
}

# The five-argument path produces an ad-hoc package for internal testing.
codesign_bin=/usr/bin/codesign
pkgbuild_bin=/usr/bin/pkgbuild
pkgutil_bin=/usr/sbin/pkgutil
spctl_bin=/usr/sbin/spctl
plutil_bin=/usr/bin/plutil
# Arguments for the one shared codesign invocation below. Always non-empty (this machine's
# /bin/bash is 3.2.57, where "${empty_array[@]}" under `set -u` is an unbound-variable error,
# unlike bash >= 4.4) — ad-hoc still signs (with "-"), it just signs with a different,
# non-identity value, so there is always at least --force --sign <something>.
codesign_args=(--force --sign -)
if [[ $release == 1 ]]; then
  : "${ONEX_SIGN_APP_IDENTITY:?--release requires ONEX_SIGN_APP_IDENTITY (a Developer ID Application identity).}"
  : "${ONEX_SIGN_INSTALLER_IDENTITY:?--release requires ONEX_SIGN_INSTALLER_IDENTITY (a Developer ID Installer identity).}"
  : "${ONEX_NOTARY_PROFILE:?--release requires ONEX_NOTARY_PROFILE (a registered notarytool Keychain profile).}"
  [[ $ONEX_SIGN_APP_IDENTITY != - ]] || { echo 'ONEX_SIGN_APP_IDENTITY must not be "-" (ad hoc) for --release' >&2; exit 2; }
  [[ $ONEX_SIGN_INSTALLER_IDENTITY != - ]] || { echo 'ONEX_SIGN_INSTALLER_IDENTITY must not be "-" (ad hoc) for --release' >&2; exit 2; }
  notarytool=$(/usr/bin/xcrun --find notarytool) || { echo 'Missing `xcrun notarytool` (needs a current Xcode command line tools install)' >&2; exit 1; }
  stapler=$(/usr/bin/xcrun --find stapler) || { echo 'Missing `xcrun stapler`' >&2; exit 1; }
  codesign_args=(--sign "$ONEX_SIGN_APP_IDENTITY" --force --options runtime --timestamp)
fi

case "$origin" in
  https:*) ws=wss://${origin#https://}/v1/edge/ws ;;
  http:*) ws=ws://${origin#http://}/v1/edge/ws ;;
esac

plist=$app/Contents/Info.plist
[[ $(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$plist") == "$identifier" ]]
version=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$plist")
executable=$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$plist")
for bin in "$app/Contents/MacOS/$executable" "$cli" "$daemon"; do
  [[ -x $bin ]] && /usr/bin/lipo "$bin" -verify_arch arm64 || { echo "Missing arm64 executable: $bin" >&2; exit 2; }
done

# Stage on the output filesystem so publishing does not require a copy.
out_dir=$(cd "$(dirname "$output")" && pwd) || { echo "No such directory: $(dirname "$output")" >&2; exit 2; }
stage=$(mktemp -d "$out_dir/.onex-pkg.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
payload=$stage/payload
bundle="$payload/Applications/OneX Desktop.app"
resources=$bundle/Contents/Resources
launch_agents=$payload/Library/LaunchAgents
mkdir -p "$payload/Applications" "$launch_agents" "$stage/scripts"
/usr/bin/ditto "$app" "$bundle"
mkdir -p "$resources/onex/bin"
install -m 0755 "$cli" "$resources/onex/bin/onex"
install -m 0755 "$daemon" "$resources/onex/bin/onexd"
install -m 0755 "$scripts/onex-run-claude.command" "$resources/onex-run-claude.command"
install -m 0755 "$scripts/postinstall" "$stage/scripts/postinstall"

cat > "$launch_agents/$agent.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$agent</string>
  <key>ProgramArguments</key>
  <array><string>/Applications/OneX Desktop.app/Contents/Resources/onex/bin/onexd</string></array>
  <key>EnvironmentVariables</key><dict><key>ONEX_SERVER</key><string>$ws</string></dict>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
PLIST
chmod 0644 "$launch_agents/$agent.plist"
/usr/bin/plutil -lint "$launch_agents/$agent.plist"

echo "==> Signing nested Mach-O binaries (onex, onexd)" >&2
"$codesign_bin" "${codesign_args[@]}" "$resources/onex/bin/onex" "$resources/onex/bin/onexd"
# Sign nested code before signing and sealing the app bundle.
echo "==> Signing the app bundle" >&2
"$codesign_bin" "${codesign_args[@]}" "$bundle"
"$codesign_bin" --verify --deep --strict "$bundle"
if [[ $release == 1 ]]; then
  "$codesign_bin" --display --verbose=4 "$bundle" 2>&1 | grep -q 'flags=.*runtime' ||
    { echo 'Hardened runtime flag missing from the signed app bundle' >&2; exit 1; }
fi

"$pkgbuild_bin" --analyze --root "$payload" "$stage/components.plist"
"$plutil_bin" -replace 0.BundleIsRelocatable -bool NO "$stage/components.plist"
echo "==> Building the installer package" >&2
# Always non-empty for the same bash 3.2 unbound-variable reason as codesign_args above: start
# from the base flags every build needs, then append the release-only --sign/--timestamp pair.
pkgbuild_args=(--root "$payload" --identifier "$identifier" --version "$version"
  --install-location / --component-plist "$stage/components.plist" --scripts "$stage/scripts")
if [[ $release == 1 ]]; then
  pkgbuild_args+=(--sign "$ONEX_SIGN_INSTALLER_IDENTITY" --timestamp)
fi
"$pkgbuild_bin" "${pkgbuild_args[@]}" "$stage/OneX.pkg"

if [[ $release == 1 ]]; then
  echo "==> Checking the installer package's own signature before submitting it" >&2
  "$pkgutil_bin" --check-signature "$stage/OneX.pkg"

  echo "==> Submitting to the Apple notary service" >&2
  submission_json="$stage/submission.json"
  "$notarytool" submit "$stage/OneX.pkg" --keychain-profile "$ONEX_NOTARY_PROFILE" --wait \
    --output-format json > "$submission_json"
  status=$("$plutil_bin" -extract status raw -o - "$submission_json" 2>/dev/null || true)
  submission_id=$("$plutil_bin" -extract id raw -o - "$submission_json" 2>/dev/null || true)
  if [[ $status != Accepted ]]; then
    echo "Notarization did not succeed (status: ${status:-unknown}); fetching the notary log for diagnosis" >&2
    if [[ -n $submission_id ]]; then
      "$notarytool" log "$submission_id" --keychain-profile "$ONEX_NOTARY_PROFILE" "$stage/notary.log" >&2 || true
      [[ -f "$stage/notary.log" ]] && cat "$stage/notary.log" >&2
    fi
    echo 'Refusing to ship an unnotarized package as an official build.' >&2
    exit 1
  fi
  echo "==> Accepted (submission $submission_id)" >&2

  echo "==> Stapling the notarization ticket" >&2
  "$stapler" staple "$stage/OneX.pkg"
  "$stapler" validate "$stage/OneX.pkg"

  echo "==> Final Gatekeeper check" >&2
  "$spctl_bin" -a -vvv --type install "$stage/OneX.pkg"
fi

if [[ $release == 1 ]]; then
  # link(1) publishes atomically and fails if a concurrent build has claimed the path.
  /bin/link "$stage/OneX.pkg" "$out_dir/$(basename -- "$output")"
else
  mv -n -- "$stage/OneX.pkg" "$output"
  [[ -f $output && ! -e "$stage/OneX.pkg" ]] || { echo "Could not publish to $output" >&2; exit 1; }
fi
echo "$output"
