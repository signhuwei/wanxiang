# Edge 移交说明

2026-11-19，edge 进程写。分支 `dev/edge`（worktree `/Users/HHH/Code/OneX/wt/edge`），最新提交 `c9659fd`，已全部合并到 main，没有未提交改动。代码在 `edge/`（Rust workspace：`onex-core`、`onexd`、`onex-cli`）。

## 已完成并已合并

| 内容 | 主要提交 | 位置 |
| --- | --- | --- |
| WS 控制连接：hello/welcome、心跳、退避重连、config、outbox 回流、events_ack、ack 回退补传 | 第一批 | `onexd/src/ws.rs`、`outbox.rs` |
| 本机 router：Anthropic Messages 透传、SSE 计量、只在没收到响应头时重试一次 | 第一批 | `onexd/src/router.rs`、`sse.rs` |
| Anthropic → OpenAI Chat 转换（`protocol: "openai_chat"`，AC-01～16、18） | `0da9ca4` | `onexd/src/chat.rs`，测试 `tests/chat.rs` |
| 计价、租约、续租、cutoff、lastgood 落盘 | S1-E2 | `onexd/src/pricing.rs`、`lease.rs`、`lastgood.rs` |
| magpie 的三项计费阻塞：预留和实际花费分开记；续租快照落盘后原样重放；用量不完整时只按已见部分计价，标 `complete=false` | `adf76e9` | `lease.rs`、`router.rs` |
| secret 解密（契约 v0.7）：X25519 + HKDF-SHA256 + XChaCha20-Poly1305，AAD 为 provider_id | `e32d850` | `onexd/src/secret.rs` |
| `onex login`：验证码登录、选租户、注册设备（提交公钥），device_token 交给 onexd，会话令牌用完即注销 | `fcb0872` | `onex-cli/src/login.rs` |
| `onex run claude-code`（S1-E4 最小版）：用 PATH 里的 claude；隔离 CLAUDE_CONFIG_DIR、HOME、TMPDIR；每次启动一份 0600 的 settings.json，Agent 退出时删除；环境从空开始 | `24a5aa4`、`c9659fd` | `onexd/src/launch.rs`、`onex-cli/src/main.rs` |
| 会话采集（S1-E3 最小版）：只读主会话 jsonl，产出 session_start、user_message、assistant_message、tool_call、tool_result、session_end，其余记 gap | `888f6cf` | `onexd/src/capture.rs` |

161 个测试通过（总督在 main 上复核过），`cargo clippy --workspace --all-targets -- -D warnings` 无警告。

## 进行中

- **本机整链冒烟（还没开始）**：总督要求先用本机 seed 和假上游跑一遍 onexd → onex login → onex run claude-code。代码已经齐了，但还没有在真机上跑过。
- **跨进程续租用例（草稿，按 MVP 计划暂停）**：`onexd/tests/e2e_lease_server.rs`（`4381300`），标了 `#[ignore]`，**一次都没跑过**。它通过 `bun tests/e2e/lease-server.ts` 启动真实 Server，在中间人处丢掉续租回包。

## 下一步（按优先级）

1. 本机整链冒烟（假上游），步骤见下文「本机运行」。
2. 211 部署好以后：总督会给出 ws 地址和测试账号，并从 211 日志里读出验证码转交；然后用 `claude -p` 对 local qwen 做冒烟（总督已同意，但只能在部署之后跑）。真正的多轮对话需要真人在终端里操作。
3. 按 MVP 计划推迟的事项（`docs/plan/mvp.md`）：
   - router 的三项小修：HTTP 200 里的业务错误和 `message_stop` 之后不等 EOF 就收尾；禁用 reqwest 自动重定向，3xx 记为上游错误；SSE 行和事件的字节上限。见 `coord/reports/review-s1-edge-1.md` 的 S1-E1 部分。
   - 去掉跨进程用例的 `#[ignore]`，跑通。
   - count_tokens 透传（不计费、不回流）。
   - 设备私钥存进 Keychain（目前每次启动新生成），然后接 Tauri Desktop（S1-E6），审 `desktop-ui/IPC.md`、`PACKAGING.md`。
   - S1-E3 完整版：子 Agent 文件、compact、图片元数据、system/away_summary；按版本维护的忽略行白名单。设计见 `edge/docs/session-capture.md`。
   - S1-E4 完整版：Claude Code 下载、SHA-256 校验、resume。

## 容易踩的坑

- **登录不持久**：设备私钥和 device_token 都只在 onexd 内存里，onexd 每次重启都要重新 `onex login`。
- **本机令牌文件**：`$ONEX_HOME/router.token` 是凭据，不要读、不要打印。每次 launch 的 `run/<launch_id>/settings.json` 里也有本机令牌。
- **代理**：测试环境里可能有 HTTP 代理。访问 127.0.0.1 必须绕开代理：router 里回环地址一律直连，`onex login` 遇到回环地址时用 `no_proxy()`，测试客户端用 `reqwest::Client::builder().no_proxy()`。忘了这一点会拿到 502。
- **别用 `pkill -f`**：同一台机器上的其他 Claude 进程命令行里也带 onex，`pkill -f onex` 曾经把它们一起杀掉了。测试里起的子进程用句柄结束（`kill_on_drop`），或者用 `lsof -ti:<端口>` 查出 PID 后单独结束。
- **磁盘空间**：本机磁盘紧张，`edge/target` 曾被删除，之后的第一次构建会全量重新编译。不要另开 `--target-dir`。
- **Bash 权限**（原 Claude 进程的限制）：每条命令单独执行，不能用 `&&`、`;`、`|`；命令前不能带环境变量前缀，`git stash` 也被拒绝过。换成 Codex 后以新环境为准。
- **测试依赖 bun 的地方**：`tests/ws.rs::secret_from_server_is_decrypted_into_memory` 调用 `bun` 执行 server 的 `encryptEdgeSecret`，没装 bun 时跳过。`server/` 需要先 `bun install --cwd server --frozen-lockfile`。`tests/e2e_fake_upstream.rs` 需要 127.0.0.1:3456 上有假上游，没有时跳过。
- **契约边界**：Edge 不改 `contracts/`、`docs/plan/`。契约缺内容时先给总督写信，按自己的提议实现，并在代码里标 `// CONTRACT-PENDING`。
- **seed 的路由形状**：server 的 MVP seed 下发 `route.model="*"`、`upstream_model="Qwen3.8-27B"`。`onex run` 默认用通配路由的 upstream_model 作 `--model` 别名。
- **测试不调用真实模型**：local qwen（`http://192.168.3.212:11516/v1`）只用于人工验收。
- **计费不变量**：预留永远不能进入 `used_milli`。续租快照在收到更高 seq 的租约之前原样重放。cutoff 不清快照。修改 `lease.rs` 之后，先跑 `cargo test -p onexd --lib lease` 和 `--test router`。

## 本机运行

```sh
# 构建与测试（仓库根目录）
cargo test --manifest-path edge/Cargo.toml --workspace
cargo clippy --manifest-path edge/Cargo.toml --workspace --all-targets -- -D warnings
cargo fmt --manifest-path edge/Cargo.toml --all

# 本机 Server（开发模式会把验证码打印到 Server 日志），具体 seed 命令见 server/ 的说明和 dev/server 535d348
# 假上游：bun tests/e2e/fake-upstream/index.ts   （默认 127.0.0.1:3456）

# daemon
ONEX_HOME=/tmp/onex-home ONEX_SERVER=ws://127.0.0.1:<port>/v1/edge/ws ./edge/target/debug/onexd
# CLI（同一个 ONEX_HOME）
ONEX_HOME=/tmp/onex-home ./edge/target/debug/onex login <邮箱> [--invite <邀请码>]
ONEX_HOME=/tmp/onex-home ./edge/target/debug/onex status
cd <项目目录>
ONEX_HOME=/tmp/onex-home <仓库>/edge/target/debug/onex run claude-code [--model Qwen3.8-27B]
ONEX_HOME=/tmp/onex-home ./edge/target/debug/onex shutdown
```

- onexd 的日志在 `$ONEX_HOME/logs/onexd.*.log`。
- `onex status` 显示连接状态、租约、上游的最近结果和 outbox 的 seq。
- 受管 Claude Code 的数据在 `$ONEX_HOME/agents/claude-code/`，会话文件在 `claude/projects/*/<session_id>.jsonl`。

## 参考文档

- 契约：`contracts/edge-ws.md`（v0.10）、`contracts/http-api.md`、`contracts/errors.md`
- 计划：`docs/plan/mvp.md`、`docs/plan/sprint-1.md`、`docs/plan/s1-acceptance.md`
- 规格：`docs/specs/agents/claude-code.md`、`docs/specs/sima-lessons.md`
- 审查：`coord/reports/review-s1-edge-1.md`（magpie）
- 样本：`coord/samples/claude-code-2.1.311-transcript-shape.md`
