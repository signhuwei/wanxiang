#!/bin/bash
set -euo pipefail

if [[ $# != 5 ]]; then
  echo 'Usage: package.sh <OneX Desktop.app> <onex> <onexd> <server-origin> <output.pkg>' >&2
  exit 2
fi

[[ $(uname -m) == arm64 ]] || { echo 'Build this package on an Apple Silicon Mac.' >&2; exit 2; }

app=$1
cli=$2
daemon=$3
origin=${4%/}
output=$5
scripts=$(cd "$(dirname "$0")" && pwd)
identifier=com.onex.desktop
agent=$identifier.edge
[[ $output == *.pkg && ! -e $output ]] || { echo 'Choose a new .pkg output path.' >&2; exit 2; }
[[ $origin =~ ^https?://([a-zA-Z0-9._-]+|\[[0-9A-Fa-f:]+\])(:[0-9]+)?$ ]] || {
  echo 'Server origin must be an HTTP or HTTPS origin with no path.' >&2
  exit 2
}

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

stage=$(mktemp -d "${TMPDIR:-/tmp}/onex-pkg.XXXXXX")
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

/usr/bin/codesign --force --sign - "$resources/onex/bin/onex" "$resources/onex/bin/onexd"
/usr/bin/codesign --force --sign - "$bundle"
/usr/bin/codesign --verify --deep --strict "$bundle"

/usr/bin/pkgbuild --analyze --root "$payload" "$stage/components.plist"
/usr/bin/plutil -replace 0.BundleIsRelocatable -bool NO "$stage/components.plist"
/usr/bin/pkgbuild --root "$payload" --identifier "$identifier" --version "$version" \
  --install-location / --component-plist "$stage/components.plist" --scripts "$stage/scripts" "$stage/OneX.pkg"
mv "$stage/OneX.pkg" "$output"
echo "$output"
