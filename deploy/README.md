# OneX MVP deployment

Run these commands from the checkout root. The non-root dependency installer supports macOS arm64 and Ubuntu 22.04 x86_64. It verifies pinned SHA-256 checksums before extraction. Valkey uses the official Jammy binary on Linux and builds the official source with `make` and Xcode command-line tools on macOS. RustFS uses the Linux musl build. The runtime needs `bash`, `curl`, `tar`, `unzip` and a SHA-256 tool; macOS needs `make` and the Xcode CLI tools.

## Local verification (macOS)

Use a fresh `ONEX_HOME` so no existing service, port or data is modified unintentionally. Set `HTTPS_PROXY` if the download requires it.

```sh
export ONEX_HOME="$HOME/apps/onex-local-check"
for path in deploy/*.sh; do bash -n "$path" || break; done
bash deploy/install-deps.sh
bash deploy/install-deps.sh  # should skip installed versions
"$ONEX_HOME/deps/bin/bun" install --cwd server --frozen-lockfile
bash deploy/onex.sh start
curl --fail http://127.0.0.1:18700/v1/healthz
bash deploy/onex.sh status
ONEX_TEST_VALKEY_URL=redis://127.0.0.1:18701 "$ONEX_HOME/deps/bin/bun" test server/test
bash deploy/onex.sh logs server
bash deploy/onex.sh stop
```

## Deploy as the operator

`deploy.sh` packages the committed `server/` (including Web) and `deploy/` from `HEAD`, materializes the frozen production JS dependencies locally, and uploads the release via SSH. Use the reviewed commit; uncommitted files are not packaged. The operator needs access to a root SSH account for the three systemd units. Deployment installs only the `onex-*` units and never acts on SIMA.

```sh
bash deploy/deploy.sh root@192.168.3.211
```

If the host cannot download dependencies, use `bash deploy/deploy.sh root@192.168.3.211 --upload-deps` instead. This downloads and checks Linux assets locally (selecting Bun for the host CPU), uploads them with the release and verifies them again remotely. To switch to the previous release, use `bash deploy/deploy.sh root@192.168.3.211 --rollback`. Rollback restores program files, not data or SQLite schema. Back up `~/apps/onex/data` and `~/apps/onex/secrets` before schema-changing deployments, and only roll back to a schema-compatible release.

Data remains in `~/apps/onex/data`; secrets are generated on the host into `~/apps/onex/secrets`, with mode `0600`, and are not transferred. Keep the master key stable. The five most recent retained releases include the active and previous revisions. Status prints free space, with a warning below 10 GB. Logs rotate by UTC day and at 16 MiB, with a combined 1 GB limit across the three streams. Use `bash ~/apps/onex/current/deploy/onex.sh logs server` on the host for the latest server log.

## Provision the MVP users

Run this on the deployment host **after** the first deployment created the keys. Stop OneX before seeding because there must be only one SQLite writer process. This uses the key already on the host; do not print it or copy it back to the laptop.

```sh
export ONEX_HOME="$HOME/apps/onex"
bash "$ONEX_HOME/current/deploy/onex.sh" stop
ONEX_MASTER_KEY="$(<"$ONEX_HOME/secrets/master.key")" ONEX_DATA_DIR="$ONEX_HOME/data/server" \
  "$ONEX_HOME/deps/bin/bun" --no-env-file "$ONEX_HOME/current/server/src/seed-mvp.ts" owner@example.test employee@example.test
bash "$ONEX_HOME/current/deploy/onex.sh" start
bash "$ONEX_HOME/current/deploy/onex.sh" logs server
```

Use distinct test identities. Rerunning with the same identities returns the existing IDs without recharging. The owner also holds the explicit platform-admin grant. The employee can log in without an invite. The command creates one tenant with 1,000 prepaid rubbers and a `Qwen3.8-27B` OpenAI Chat route. Its wildcard is limited to this tenant’s one authorized model and maps every request model name to `Qwen3.8-27B` upstream. No command here probes or calls the upstream. The provider only holds an encrypted placeholder token.

The default binds are `127.0.0.1:18700` (Server), `127.0.0.1:18701` (Valkey) and `127.0.0.1:18702` (RustFS; console disabled). To override ports, put `ONEX_PORT`, `ONEX_VALKEY_PORT` and `ONEX_RUSTFS_PORT` assignments in the operator-owned `$ONEX_HOME/service.env`. MVP OTPs are printed only in development mode; the launcher refuses non-loopback development binds. For an operator laptop to access the remote MVP without exposing this login flow, use an SSH tunnel such as `ssh -N -L 18700:127.0.0.1:18700 root@192.168.3.211`, and use `http://127.0.0.1:18700` locally for both Web and Edge.
