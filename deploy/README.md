# OneX MVP deployment

Run these commands from the checkout root. The non-root dependency installer supports macOS arm64 and Ubuntu 22.04 x86_64. It verifies pinned SHA-256 checksums before extraction. Valkey uses the official Jammy binary on Linux and builds the official source with `make` and Xcode command-line tools on macOS. RustFS uses the Linux musl build. The runtime needs `bash`, `curl`, `tar`, `unzip` and a SHA-256 tool; macOS needs `make` and the Xcode CLI tools.

## Local verification (macOS)

Use Bun 1.4.5 for development, packaging, and deployment. [mise.toml](../mise.toml) pins development. [deploy/bun-version](bun-version) pins the installer and release tools. To run a development command with mise, use `mise install` and then `mise exec -- bun --version` from the checkout root.

Use a fresh `ONEX_HOME` for standalone verification. The installer puts Bun in `$ONEX_HOME/deps/bin` and the OneX services invoke it by absolute path. Set `HTTPS_PROXY` if the download requires it.

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

Before a Bun version change, preserve the private `$ONEX_HOME/deps/bin/bun` executable. OneX code rollback uses the runtime at that same path. Restore the preserved executable separately if the previous release requires it. On Linux, verify the running Server's Bun version with `/proc/$(systemctl show -p MainPID --value onex-server.service)/exe --version`.

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

The default binds are `127.0.0.1:18700` (Server), `127.0.0.1:18701` (Valkey) and `127.0.0.1:18702` (RustFS; console disabled). To override ports, put `ONEX_PORT`, `ONEX_VALKEY_PORT` and `ONEX_RUSTFS_PORT` assignments in the operator-owned `$ONEX_HOME/service.env`.

## Temporary LAN access for the MVP

On 211, add these lines to `~/apps/onex/service.env` before starting or deploying the release:

```sh
NODE_ENV=development
ONEX_HOST=192.168.3.211
ONEX_PORT=18700
ONEX_ALLOW_LAN_DEV=1
```

Only OneX Server binds the selected private address. Valkey and RustFS still listen on `127.0.0.1`. The startup warning appears in the Server log. Verification codes are written only to that log; never share access to it. Web and Edge can use `http://192.168.3.211:18700` directly. HTTP and WebSocket traffic are unencrypted in this setup: restrict access to the trusted MVP network or test Macs with the host firewall and do not expose the port outside the LAN.

To disable LAN development, set `ONEX_HOST=127.0.0.1` and remove `ONEX_ALLOW_LAN_DEV` (or set it to `0`), then run `bash ~/apps/onex/current/deploy/onex.sh stop` followed by `bash ~/apps/onex/current/deploy/onex.sh start`.

## Mac 安装 Git 前置检查

OneX 的 Mac `.pkg` 在写入安装文件前会实际检查 Git，支持 Apple 命令行工具、Xcode 和常用 Homebrew 安装路径。已安装可用 Git 时继续安装。缺少 Git 时会打开 Apple 的命令行工具安装窗口。用户确认并完成 Apple 安装后，重新打开 OneX 安装包。Apple 的安装独立完成，已有 OneX 安装不受这次中止影响。 [Apple 命令行工具安装流程](https://developer.apple.com/documentation/xcode/installing-the-command-line-tools)

安装完成后可从「应用程序」打开 OneX Desktop，也可以在终端运行 `onex status`、`onex login --tenant <租户简称> --username <用户名>` 或 `onex run codex --managed`。`/usr/local/bin/onex` 指向同一安装包内的 CLI。Desktop 和 CLI 使用当前 macOS 用户的同一个 `onexd`，由 LaunchAgent 在图形登录时启动。已有 Desktop 登录的用户可以直接使用 CLI。

## 平台维护与发布

平台管理员在「平台 → 维护与发布」上传已签名的 Server 清单和制品，查看部署状态。Edge 安装包也可以在该入口发布。接口以运行环境的 `/v1/openapi.json` 为准。

初次启用时，部署运维在受信任的打包机器生成 Ed25519 密钥，给 OneX 主机的 `~/apps/onex/secrets/server-release.pub` 安装公钥。安装含维护页和执行器的版本后，OneX 启用 `onex-release-worker.timer`。私钥仅在授权打包环境使用。已有的 SSH 发布命令保留用于首次启用和故障恢复。

Edge 先用 `deploy/mac/package.sh` 或 Windows 原生环境中的 `deploy/windows/build.ps1` 生成安装器。

Agent 在已提交且通过回归的源码目录运行：

```sh
ONEX_RELEASE_PRIVATE_KEY=/secure/onex-server-release.key bun deploy/release.ts pack-server /secure/output
ONEX_RELEASE_LOGIN_TOKEN_FILE=/secure/platform-login.token bun deploy/release.ts publish-server https://onex.example /secure/output/COMMIT.json /secure/output/COMMIT.tar.gz
ONEX_RELEASE_LOGIN_TOKEN_FILE=/secure/platform-login.token bun deploy/release.ts publish-edge https://onex.example darwin 1.2.3 /secure/output/OneX.pkg
ONEX_RELEASE_LOGIN_TOKEN_FILE=/secure/platform-login.token bun deploy/release.ts rollout https://onex.example roll_ID
```

`pack-server` 也可在输出目录之后指定已审核的 Git 提交。

`publish-edge` 的 Windows 对应参数为 `windows VERSION installer.exe`。如已有全局管理会话，使用 `ONEX_RELEASE_TOKEN_FILE`。命令将凭据从文件读入，标准输出返回一条 JSON。Server 发布可通过 `ONEX_EXPECTED_COMMIT` 固定当前版本，`ONEX_RELEASE_REQUEST_ID` 固定幂等键。完成后根据返回的任务状态和 `observed_commit` 验证运行版本。失败任务保留，确认原因后用新幂等键发起重试。

启用 Desktop 自动更新时，在签名环境保管独立的 Ed25519 Edge 更新私钥。更新公钥可通过 `ONEX_EDGE_UPDATE_PRIVATE_KEY=/secure/edge-update.key bun deploy/release.ts edge-update-public-key` 导出。将 JSON 字符串的内容设置为构建环境的 `ONEX_DESKTOP_UPDATE_KEY`，使安装后的 Desktop 能验证未来发行。分发引导包与后续更新制品需要使用同一信任公钥。

macOS 更新制品使用 `deploy/mac/package.sh` 的 `--preserve-daemon` 参数，应用包版本与发布号保持一致。Windows 使用构建输出的 `desktop_update` 指向的 `onex-desktop.exe`。发布时提供手动安装器和可选更新制品两条路径。

```sh
ONEX_EDGE_UPDATE_PRIVATE_KEY=/secure/edge-update.key \
ONEX_RELEASE_TOKEN_FILE=/secure/platform-session.token \
  bun deploy/release.ts publish-edge https://onex.example darwin 1.2.3 /secure/OneX.pkg /secure/OneX-preserve-daemon.pkg
```

主机日志可按任务 ID 查 `journalctl -u onex-release-worker.service`。业务库备份在 OneX 的 `backups/`。如果候选迁移使上一版无法启动，按备份恢复流程评估恢复时间点。发布制品密钥与 macOS 签名公证独立。
