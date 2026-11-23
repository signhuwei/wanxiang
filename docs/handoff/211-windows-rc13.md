# 211 Server 与 Windows Edge RC13 交接

## macOS 侧部署 Server

- 从 `origin/fix/windows-edge-rc13-acceptance` 取得代码，锁定 `b20bcfe798252a1efbd626516d727175487b4445`。本地 Windows NSIS 使用同一个代码提交。交接文档提交只用于传递操作信息。
- 目前 `http://mapcan.xyz:18700/v1/healthz` 返回 `3bc69a64ff53007574c14b1990e96465603046f1`。部署前重新查当前版本，以实际返回值作为发布的 `expected_commit`。记录 OneX 各单元状态和可用空间。
- OneX 使用 `~/apps/onex/deps/bin/bun`，部署脚本固定为 **Bun 1.3.5**。已用 1.3.5 对候选 Server 执行 `bun --no-env-file test server/test tests/e2e/fake-upstream`，183 项通过，0 项失败，1 项 Valkey 测试按默认配置跳过。仓库 `mise.toml` 的 1.4.5 用于开发机。211 的 SIMA 使用自己的服务与目录。
- 优先用 [`deploy/release.ts`](../../deploy/release.ts) 的 `pack-server` 和 `publish-server`，使用管理员已有的私密签名和会话文件。打包需固定为 Linux x64 并核对 DuckDB 的 `duckdb.node` 和 `libduckdb.so`。直接 SSH 部署时，要检查 `deploy/deploy.sh` 的本机依赖安装步骤，确保归档带 Linux x64 生产依赖。可复用签名发布脚本中的冻结安装参数 `--frozen-lockfile --production --ignore-scripts --os=linux --cpu=x64`。
- Server 改动包括受管制品 Range 下载、SQLite 句柄释放，以及 Windows x64 DeepSeek 能力位的服务端识别。相对目前健康接口报告的提交，迁移文件和生产依赖锁无变化。
- `remote-release.sh` 会在停止 OneX 后备份 system 和租户 SQLite，原子切换 `current`，对新版本做健康检查，失败时尝试恢复上一个程序版本。维护发布数据库 `data/server/maintenance/releases.sqlite` 不在脚本的 SQLite 备份列表内。部署检查限 OneX 服务和目录，保持 SIMA 服务与目录原状。

部署完成后，从 211 本机和 Windows 使用的访问地址分别确认 `/v1/healthz` 返回 `status=ok` 和目标提交。把验收结果与回滚提交回填给 Windows 侧，以便继续发布。 [OneX 部署说明](../../deploy/README.md) · [Server 发布协议](../../contracts/maintenance-releases.md)

## Windows 侧交接

- 目标安装器为 Windows x64 普通用户 NSIS。发布使用 `windows / x64` 的测试发行号 `0.1.0-rc13`，安装器内嵌应用版本为 `0.1.0`。发布前核对同平台同发行号是否已有私有草稿或历史记录。
- 本轮标准安装包面向 Claude Code、Codex CLI 和 Kimi Code 测试。Windows DeepSeek GUI 的下载、原厂启动、两轮对话和实际测试账本结算已在独立回环调试环境验证。Windows DeepSeek 的正式受管发行资格和生产安装路径仍待完成，标准 NSIS 不含该入口。
- 211 目标提交生效后，Windows 侧使用平台管理员的短期会话文件发布经过实测的 NSIS，从公开下载接口重新下载并核对字节数和 SHA-256，同时复核 macOS ARM64 下载仍在列表中。 [Windows RC13 完整指南](https://github.com/signhuwei/wanxiang/blob/docs/windows-edge-rc13/deploy/windows/README.md)
