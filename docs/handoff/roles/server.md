# OneX Server 移交

## 当前状态

- Server worktree：`/Users/HHH/Code/OneX/wt/server`，分支 `dev/server`。移交时工作区干净。已用 `git log main..HEAD` 核对：仅 `0316b8a` 不在当时的 `main`（`ddc591e`），已发邮件请 governor 合并和部署。接手时重新核对，避免重复合入。
- `0316b8a` 已完成开发局域网开关：只有部署目录 `service.env` 里的 `ONEX_ALLOW_LAN_DEV=1` 才允许开发模式绑定具体私网 IPv4；启动会记警告。只有 Server 的监听地址变化，Valkey/RustFS 仍绑回环；部署和启动的健康检查随 Server 绑定地址走。代码测试及类型检查通过；本次 Shell 修改尚未在 211 验证。Server 进程没有连接 211 或真实 Qwen，也没有读取实际密钥文件。

## 已完成并合并

| 范围 | 提交与结果 |
|---|---|
| S1-S1 管理 | `fb446ac`、`5f34ca4`、`16fd03c`：租户、成员、组、邀请、合约、平台目录；revision、幂等、筛选与权限动作；Provider 凭据加密落库，邀请码仅首次返回。 |
| S1-S2 账本 | `ccd33fa`、`1dacd06`：事务内预留、结算、余额硬上限，离线租约保留预留，重放同一续租操作返回原结果，不重复扣费；按设备对账。 |
| S1-S3 配置 | `0aaf85c`：单调配置版本；仅下发合同许可的路由和匹配倍率；Provider 密钥按设备 X25519 公钥封装。 |
| S1-S4 监察 | `8550a45`、`e8b07dc`、`dddf169`、`2e207ae`：事件和用量共用持久累计 ACK；拒绝并记录跨设备会话事件；监察 SSE 只推摘要；正文访问写审计，`read_content` 反映实际权限；月费用按 Asia/Shanghai、会话轮次排除子 Agent 和标为系统注入的消息。 |
| MVP 部署与数据 | `894d659`、`535d348`、`a41dfda`：依赖安装、进程管理、部署/回退、同源 Web；`seed:mvp` 建立租户、owner 与员工、OpenAI Chat 的 `Qwen3.8-27B` 路由和倍率，预充 1,000 橡皮。同一对账号重复执行不再充值。 |

最近一次 `bun test server/test tests/e2e/fake-upstream` 为 **27 通过、1 跳过、0 失败**；`bun run --cwd server typecheck` 通过。含累计 ACK、乱序回流、续租重放和权限检查的 Server 套件曾连续通过 30 轮。S1-S4 本机合成回流：50 台 × 每秒 20 条 × 60 秒，共 60,000 条，ACK p50 10.679 毫秒、p99 43.009 毫秒，无 `SQLITE_BUSY`。总督另外用真正的本地 Valkey 验证了较早快照（Server 19/19），并验证了 macOS 依赖安装幂等、三个进程启停。不要把这些结果当成 211 部署或真实上游验收。

## 接手后优先级

1. **核对 `0316b8a` 是否合入并部署。** 若还没有，先审合该提交。部署和启停命令见 `deploy/README.md`；部署只打包 `HEAD` 里的文件。核对 211 的 `/v1/healthz` 返回预期提交，Server 只听选定私网地址，Valkey/RustFS 只听回环；验证关闭开关后能恢复回环。未经明确授权不要操作 211。
2. **人工跑完 MVP。** 依 `docs/plan/mvp-walkthrough.md`：部署后停服运行 MVP seed（不要启动第二个 SQLite 写进程），再启动；owner 用 Web、员工用 Edge CLI。核查设备拿到 `lease`、`config`、`secret`，再由获授权的验收人员完成真实 Qwen 对话，核查正文、费用和余额耗尽。Server 本机测试只验证到了路由下发，未跑真实 Qwen。
3. **MVP 验收后再恢复后续工作。** 诊断/日志拉取、审计查询等是 `docs/plan/mvp.md` 明确延期的事项。不要把 `docs/plan/sprint-1.md` 中的完整 S1 目标视为已交付。

## 本机运行与测试

以下命令在 OneX checkout 根目录执行。默认只监听 `127.0.0.1`；使用新目录，不复用 211 或其他开发进程的数据。

```sh
bun install --cwd server --frozen-lockfile
bun test server/test tests/e2e/fake-upstream
bun run --cwd server typecheck
bun tests/e2e/ingest-load.ts
```

快捷运行（不用安装 Valkey/RustFS；使用内存 presence，不验证持久在线状态）：

```sh
export ONEX_DATA_DIR="$(mktemp -d)"
bun run --cwd server seed owner@example.test 10 'OneX Local' --platform-admin
bun run --cwd server start
```

另开终端访问 `http://127.0.0.1:3000/` 或 `/v1/healthz`。如需跑三进程，按 `deploy/README.md` 使用独立 `ONEX_HOME` 执行 `install-deps.sh` 和 `onex.sh start`；验证 Valkey 时使用 `ONEX_TEST_VALKEY_URL=redis://127.0.0.1:18701 bun test server/test`，并在结束后 `onex.sh stop`。`tests/e2e/lease-server.ts` 是本机跨进程续租夹具，仅接受临时空目录和 `127.0.0.1` 的假上游地址。

## 易踩的坑

- 开发与部署使用 Bun 1.4.5。此前在 1.3.5 观察到，Server 发起 WebSocket close 后内部连接计数可能仍有残留，导致 `server.stop()` 的 Promise 等待。Server 用实际 `onClose`、进行中的工作和 SQLite 队列控制关闭。测试按帧类型读取，心跳后还可能收到配置。
- 依赖安装校验固定 SHA-256。macOS 的 Valkey 需 Xcode 命令行工具编译；若 GitHub 需代理，设置 `HTTPS_PROXY`。上一个开发会话的外网下载和 Bash 脚本执行受限，验证由 governor 完成。没有预先授权不要换工具绕开权限。
- 数据、密钥和 release 分离；升级或回退前确认 SQLite schema 兼容。部署脚本会依赖远端既有的主密钥解密 Provider 凭据，不能重建或把它复制回本地。开发验证码不会通过 API 返回，只在 Server 日志中可见。LAN MVP 的 HTTP/WS 无加密，仅限受控局域网，不要对公网开放。
- 同一会话属于最先上报的设备，序号在该设备内递增。`welcome.ack_seq` 和 `events_ack` 只推进到事件、用量已共同持久化的连续位置。
- 不要用 `pkill -f onex`；它曾终止其他开发会话。用具体进程句柄、服务管理脚本或核实后的 PID。不要触碰 211 上的 SIMA 服务、目录或数据。
