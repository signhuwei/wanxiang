#!/usr/bin/env bash
set -euo pipefail
umask 077
home=${ONEX_HOME:-$HOME/apps/onex}
release=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
bin=$home/deps/bin
os=$(uname -s)
services=(valkey rustfs server)
reverse=(server rustfs valkey)

if [[ ! $home =~ ^/[a-zA-Z0-9_./-]+$ || ! $release =~ ^/[a-zA-Z0-9_./-]+$ ]]; then
  echo 'OneX paths must be absolute and contain only letters, digits, _, ., /, or -' >&2; exit 2
fi

load_settings() {
  # LAN OTP must be opted into in the operator's persistent settings, not the caller's environment.
  unset ONEX_ALLOW_LAN_DEV
  if [[ -f $home/service.env ]]; then
    set -a
    # Operator-owned shell settings. Never read secrets from the release tree.
    source "$home/service.env"
    set +a
  fi
  export ONEX_PORT=${ONEX_PORT:-18700} ONEX_VALKEY_PORT=${ONEX_VALKEY_PORT:-18701} ONEX_RUSTFS_PORT=${ONEX_RUSTFS_PORT:-18702}
  export ONEX_HOST=${ONEX_HOST:-127.0.0.1} NODE_ENV=${NODE_ENV:-development}
  local port
  for port in "$ONEX_PORT" "$ONEX_VALKEY_PORT" "$ONEX_RUSTFS_PORT"; do
    if [[ ! $port =~ ^[1-9][0-9]{0,4}$ || $port -gt 65535 ]]; then echo "Invalid TCP port: $port" >&2; exit 2; fi
  done
  if [[ $ONEX_PORT == "$ONEX_VALKEY_PORT" || $ONEX_PORT == "$ONEX_RUSTFS_PORT" || $ONEX_VALKEY_PORT == "$ONEX_RUSTFS_PORT" ]]; then
    echo 'OneX ports must be distinct' >&2; exit 2
  fi
  if [[ ! $ONEX_HOST =~ ^[a-zA-Z0-9.:_-]+$ || ! $NODE_ENV =~ ^(development|production)$ ]]; then
    echo 'Invalid ONEX_HOST or NODE_ENV' >&2; exit 2
  fi
  export ONEX_ALLOW_LAN_DEV=${ONEX_ALLOW_LAN_DEV:-0}
  export ONEX_ROUTE_POOL_DEVICES=${ONEX_ROUTE_POOL_DEVICES:-}
  local route_pair='ten_[0-9A-HJKMNP-TV-Z]{26}:dev_[0-9A-HJKMNP-TV-Z]{26}'
  if [[ -n $ONEX_ROUTE_POOL_DEVICES && ! $ONEX_ROUTE_POOL_DEVICES =~ ^$route_pair(,$route_pair)*$ ]]; then
    echo 'Invalid ONEX_ROUTE_POOL_DEVICES' >&2; exit 2
  fi
  if [[ $ONEX_ALLOW_LAN_DEV != 0 && $ONEX_ALLOW_LAN_DEV != 1 ]]; then
    echo 'ONEX_ALLOW_LAN_DEV must be 0 or 1' >&2; exit 2
  fi
  if [[ $NODE_ENV != production && $ONEX_HOST != 127.0.0.1 ]]; then
    if [[ $ONEX_ALLOW_LAN_DEV != 1 ]]; then
      echo 'Development login codes require a loopback bind unless service.env sets ONEX_ALLOW_LAN_DEV=1' >&2; exit 2
    fi
    if [[ ! $ONEX_HOST =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)[0-9.]+$ ]]; then
      echo 'LAN development requires a specific private IPv4 bind, not a wildcard or public address' >&2; exit 2
    fi
  fi
}

init() {
  mkdir -p "$home"/{run,logs,secrets,data/{server,valkey,rustfs}}
  chmod 700 "$home/secrets"
  local name tmp
  for name in master auth rustfs; do
    if [[ ! -e $home/secrets/$name.key ]]; then
      tmp=$(mktemp "$home/secrets/.key.XXXXXXXX")
      "$bin/bun" --no-env-file -e 'import {randomBytes} from "node:crypto"; console.log(randomBytes(32).toString("base64"));' > "$tmp"
      ln -- "$tmp" "$home/secrets/$name.key" || [[ -f $home/secrets/$name.key ]]
      rm -f -- "$tmp"
    fi
    [[ -f $home/secrets/$name.key && ! -L $home/secrets/$name.key ]] || { echo "Invalid $name key path" >&2; exit 1; }
    chmod 600 "$home/secrets/$name.key"
  done
}

proc_stamp() { ps -p "$1" -o lstart= -o state= | awk '$NF !~ /^Z/ {$NF=""; print}'; }
pid_for() {
  local pid stamp actual
  [[ -r $home/run/$1.pid ]] || return 1
  { read -r pid; IFS= read -r stamp; } < "$home/run/$1.pid"
  [[ $pid =~ ^[0-9]+$ && -n $stamp ]] || return 1
  actual=$(proc_stamp "$pid") || return 1
  [[ $actual == "$stamp" ]] || return 1
  printf '%s\n' "$pid"
}
start_mac() {
  local app pid stamp
  for app in "${services[@]}"; do
    if pid_for "$app" >/dev/null; then ready "$app"; continue; fi
    nohup /bin/bash "$release/deploy/run-service.sh" "$home" "$app" "$release" </dev/null >/dev/null 2>&1 &
    pid=$!
    stamp=$(proc_stamp "$pid")
    [[ -n $stamp ]] || { echo "$app failed to start" >&2; return 1; }
    printf '%s\n%s\n' "$pid" "$stamp" > "$home/run/$app.pid"
    ready "$app"
  done
}
stop_mac() {
  local app pid i
  for app in "${reverse[@]}"; do
    if pid=$(pid_for "$app"); then
      kill -TERM "$pid"
      for ((i=0; i<150; i++)); do
        pid_for "$app" >/dev/null || break
        sleep 0.2
      done
      if pid_for "$app" >/dev/null; then echo "$app has not shut down" >&2; return 1; fi
    fi
    rm -f -- "$home/run/$app.pid"
  done
}

ready() {
  local app=$1 i address=$ONEX_HOST
  case "$address" in 0.0.0.0) address=127.0.0.1;; ::) address='[::1]';; *:*) address="[$address]";; esac
  for ((i=0; i<120; i++)); do
    case "$app" in
      valkey) if [[ $("$bin/valkey-cli" -h 127.0.0.1 -p "$ONEX_VALKEY_PORT" ping 2>/dev/null) == PONG ]]; then return; fi;;
      rustfs) if curl -fsS --max-time 1 "http://127.0.0.1:$ONEX_RUSTFS_PORT/health" >/dev/null 2>&1 ||
        curl -fsS --max-time 1 "http://127.0.0.1:$ONEX_RUSTFS_PORT/minio/health/live" >/dev/null 2>&1; then return; fi;;
      server) if curl --noproxy '*' -fsS --max-time 1 "http://$address:$ONEX_PORT/v1/healthz" >/dev/null 2>&1; then return; fi;;
    esac
    sleep 0.25
  done
  echo "$app failed its readiness check; inspect $home/logs" >&2; return 1
}

install_release_worker() {
  [[ -f $home/secrets/server-release.pub ]] || return 0
  local unit_dir=/etc/systemd/system
  cat > "$unit_dir/onex-release-worker.service" <<EOF
[Unit]
Description=OneX Server rollout worker
After=network.target

[Service]
Type=oneshot
UMask=0077
TimeoutStartSec=30min
ExecStart=/bin/bash $home/current/deploy/server-release-worker.sh $home
EOF
  cat > "$unit_dir/onex-release-worker.timer" <<'EOF'
[Unit]
Description=OneX Server rollout queue

[Timer]
OnBootSec=5s
OnUnitInactiveSec=5s
AccuracySec=1s

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now onex-release-worker.timer
}

start_linux() {
  if [[ $(id -u) != 0 ]]; then echo 'Installing OneX system units requires root' >&2; return 1; fi
  local app unit tmp ordering
  for app in "${services[@]}"; do
    unit=/etc/systemd/system/onex-$app.service
    tmp=$(mktemp "$home/run/.unit.XXXXXXXX")
    ordering='After=network.target'
    if [[ $app == server ]]; then
      ordering=$'After=network.target onex-valkey.service onex-rustfs.service\nRequires=onex-valkey.service onex-rustfs.service'
    fi
    printf '%s\n' '[Unit]' "Description=OneX $app" "$ordering" '' '[Service]' 'Type=simple' 'Restart=on-failure' 'RestartSec=2s' \
      'TimeoutStopSec=35s' 'KillMode=mixed' 'NoNewPrivileges=true' 'UMask=0077' "WorkingDirectory=$release" \
      "Environment=ONEX_HOST=$ONEX_HOST" "Environment=ONEX_PORT=$ONEX_PORT" "Environment=ONEX_VALKEY_PORT=$ONEX_VALKEY_PORT" \
      "Environment=ONEX_RUSTFS_PORT=$ONEX_RUSTFS_PORT" "Environment=NODE_ENV=$NODE_ENV" "Environment=ONEX_ALLOW_LAN_DEV=$ONEX_ALLOW_LAN_DEV" \
      "Environment=ONEX_ROUTE_POOL_DEVICES=$ONEX_ROUTE_POOL_DEVICES" \
      "ExecStart=/bin/bash $release/deploy/run-service.sh $home $app $release" '' '[Install]' 'WantedBy=multi-user.target' > "$tmp"
    install -m 0644 "$tmp" "$unit"
    rm -f -- "$tmp"
  done
  systemctl daemon-reload
  systemctl enable onex-valkey.service onex-rustfs.service onex-server.service
  for app in "${services[@]}"; do systemctl start "onex-$app.service"; ready "$app"; done
  install_release_worker
}

case ${1:-} in
  start)
    load_settings
    [[ -x $bin/bun && -x $bin/valkey-server && -x $bin/rustfs ]] || { echo 'Run install-deps.sh first' >&2; exit 1; }
    [[ -d $release/server/node_modules ]] || { echo 'Run Bun install --frozen-lockfile in server first' >&2; exit 1; }
    init
    case "$os" in Darwin) start_mac;; Linux) start_linux;; *) exit 2;; esac ;;
  stop)
    case "$os" in
      Darwin) stop_mac;;
      Linux) for app in "${reverse[@]}"; do
        if [[ $(systemctl show -p LoadState --value "onex-$app.service") == loaded ]]; then systemctl stop "onex-$app.service"; fi
      done;;
      *) exit 2;;
    esac ;;
  status)
    for app in "${services[@]}"; do
      if [[ $os == Linux ]]; then state=$(systemctl is-active "onex-$app.service" || true)
      elif pid=$(pid_for "$app"); then state="running (PID $pid)"; else state=stopped; fi
      printf '%s: %s\n' "$app" "$state"
    done
    path=$home/data
    while [[ ! -d $path ]]; do path=$(dirname -- "$path"); done
    free=$(df -Pk "$path" | awk 'NR==2 {print $4}')
    [[ $free =~ ^[0-9]+$ ]] || { echo 'Could not determine free disk space' >&2; exit 1; }
    printf 'Available on data filesystem: %s KiB\n' "$free"
    if [[ $free -lt 9765625 ]]; then echo 'WARNING: less than 10 GB free on the data filesystem' >&2; fi ;;
  logs)
    app=${2:-server}
    case "$app" in server|valkey|rustfs) ;; *) echo 'Choose server, valkey, or rustfs' >&2; exit 2;; esac
    shopt -s nullglob
    files=("$home/logs/$app-"*.log)
    if [[ ${#files[@]} -eq 0 ]]; then echo "No $app logs yet"; else tail -n 100 -- "${files[${#files[@]}-1]}"; fi ;;
  *) echo 'Usage: onex.sh start | stop | status | logs [server|valkey|rustfs]' >&2; exit 2;;
esac
