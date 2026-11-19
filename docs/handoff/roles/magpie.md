# OneX Edge 验收移交（magpie）

交接时间：2026-11-19。角色：Edge 独立验收监督员，不写产品代码。交接核对时 `main` 为 `4301de6`（合并 Edge MVP）；`wt/review-magpie` 为 detached `0e4123d`，无待提交改动。共享清单与手册也无待提交改动。下述运行结果只适用于所列提交，不代表当前 MVP 已验收。

## 已完成及已合并

| 交付 | 位置 / 提交 | 状态 |
| --- | --- | --- |
| Magpie 网关、转换、可靠性和 Agent 规格 | `wanxiang/docs/specs/magpie/`；`af71b70`、`38f2038` | 已合入；`gateway.md` 区分参考实现和 OneX 约定；`anthropic-to-chat-test-cases.md` 有 AC-01～18。 |
| S1 Edge 验收清单与断网口径 | `wanxiang/docs/plan/s1-acceptance.md`；`5dc1898`、`430da9d` | 已合入；只断控制链路但上游可达时继续工作；整机断网时请求失败正常，恢复后无需重启/登录，补传完整且不重复扣款。 |
| S1-E2 首验及 S1-E1 静态审查 | `coord/reports/review-s1-edge-1.md` | 已送达总督；不在产品仓。记录旧版 E2 三个结算阻塞、E1 的路径/终态/重定向等问题，以及当时的测试底稿。 |
| MVP 人工验收步骤 | `wanxiang/docs/plan/mvp-walkthrough.md`，`6834643`；原稿 `coord/reports/mvp-walkthrough.md` | 已由总督合入。手册按交付前的 CLI/地址命名写成；执行时必须用下方现行入口。 |
| MVP 产品实现 | `4301de6`、`6868918` | Edge 的密钥解密、验证码 CLI、受管启动、主会话采集；Server 的 MVP seed 等已进 `main`。合并不是人工实跑证据。 |

## 进行中：停在哪一步

- **S1-E2 本地复验被 MVP 排期暂停，未签收，也未出 `review-s1-edge-2.md` 正式报告。** 我在 `0e4123d` 确认 Edge 源码与 `adf76e9` 无差异，独立跑了 `cargo test --manifest-path edge/Cargo.toml --workspace --locked --offline --target-dir /tmp/onex-magpie-s1-e2-target`：**143 通过、0 失败**（含 Chat 路由测试 19 项和假上游端到端 1 项）；定向跑 router `budget` **6 通过、0 失败**。以下三项是本地证据，不是 Server 真实结算签收：
  - `edge/onexd/tests/router.rs` 的 `reservation_over_lease_budget_is_rejected_before_upstream`：402 / `balance_exhausted`，上游调用数为 **0**，本地用量和在途占用均为 0；并发夹具也断言额度已占满后不再出站。
  - `edge/onexd/tests/ws.rs` 的 `committed_renew_with_lost_reply_is_replayed_unchanged_after_more_spend`：假 Server 丢回包，离线后又花 5，重连仍上报原金额 80 与 `op_id`，新租约已用为 5；独立的 Ledger 重启夹具也验证原快照持久化。这里的 WS 对端不是真实 Server。
  - `edge/onexd/tests/router.rs` 的 `stream_without_final_usage_is_priced_on_seen_part_only`：有正文、无有效尾用量（含空对象），正常协议终态、`complete=false`、只计已见 20 并释放预留；`non_streaming_success_without_usage_is_pending_not_reservation` 验证无已见值时为 0 且不标完整。
- `main` 已有 `edge/onexd/tests/e2e_lease_server.rs` 和 `tests/e2e/lease-server.ts`：真实 Bun Server + 控制链路故障夹具，用于「服务端提交→丢回包→继续消费→Edge 重启→回连」。它不是上述 143 项的证据，我未独立运行其主线版本。
- **MVP 人工联验未由 magpie 执行。** 我未部署 211、未确认部署实际版本、未请求真实上游。无真实 Mac CLI→local qwen→管理端或余额耗尽的签收证据。S1-E1 的 `count_tokens` 和同协议终态/断流、Chat 能力边界也未做新主线签收。

## 下一步（按优先级）

1. **P0：先跑 MVP。** 对齐最新 `main`、实际部署 SHA 与同批 Mac 二进制。按人工手册校验平台/租户配置、员工验证码和设备注册、WS config/secret/lease、受管终端三轮合成对话、打开的监察页实时更新正文与费用。单独测试小余额租户：首轮有回复与消费，余额及可花租约都耗尽后，下一轮 402、上游调用数不增、流水不重复。基准租户的 1000 橡皮不拿来耗尽；不以配置关停或租约过期代替余额拒绝。把手册里的旧 CLI 名与默认直连地址更新为实际操作方法。
2. **P1：MVP 跑通后恢复 E2 复验。** 在同一提交执行跨进程夹具并对照真实流水，确认结算一次、快照后资金正确结转。再覆盖超预算实际用量：`0e4123d` 的 router 已断流/拦回包，但保留 31 用量对 30 额度（`edge/onexd/tests/router.rs` 的 `non_streaming_cost_at_and_over_budget`）；同版本 Server 对 `used_milli > budget` 返回校验错误（`server/src/billing.ts`）。在最新提交复查，联验这类用量能否续租/对账，以及完全耗尽得到 cutoff 时如何收尾。现为静态对照，不是已跑失败的用例。
3. **P2：补签其他 S1 项。** 按原报告回归同协议 HTTP 200 业务错误终态、收到响应头后不重发/不跟随重定向、`message_stop` 不等 EOF、SSE 字节限制和离线路由快照。用 Edge 清单验证 `count_tokens` 不计费、不回流、Chat AC 用例范围、两类断网和两小时真机；不把假上游结果代签。Tauri、安装包、下载校验、诊断、完整会话采集等依 `docs/plan/mvp.md` 与后续排期。

## 在本机运行和测试

以下从接手者自己的仓库根目录运行。验收 worktree 可安全 `git checkout --detach <要验的 main SHA>`；主 checkout 已占用 `main`，无需强行在第二个 worktree 切同一分支。先看 `git status --short --branch`，记录所验 SHA，发现他人改动不要覆盖。

```sh
cargo test --manifest-path edge/Cargo.toml --workspace --locked
cargo test --manifest-path edge/Cargo.toml --locked -p onexd --test router budget
cargo test --manifest-path edge/Cargo.toml --locked -p onexd --test chat
cargo test --manifest-path edge/Cargo.toml --locked -p onexd --test e2e_fake_upstream
bun install --cwd server --frozen-lockfile
cargo test --manifest-path edge/Cargo.toml --locked -p onexd --test e2e_lease_server -- --nocapture
```

- Rust 依赖已缓存的环境可加 `--offline --target-dir /tmp/onex-magpie-s1-e2-target`，避免写入只读 worktree。跨进程测试要求 `bun` 在 PATH 且 `server` 依赖已安装；缺 Bun 时测试会跳过，不能把显示绿色当作实跑。`--nocapture` 用于确认没跳过；别分享测试进程的原始凭据或完整日志。自动化只用假上游；跨进程续租场景也不访问真实模型。
- **候选 Mac 实操（`4301de6` 的 CLI）**：先 `cargo build --manifest-path edge/Cargo.toml --workspace --locked`，优先用候选二进制的绝对路径（默认在 `edge/target/debug`）避免 PATH 指向旧版。Package 叫 `onex-cli`，可执行文件叫 **`onex`**。`deploy/README.md` 默认 Server 绑定 211 的 loopback，不要照旧手册直接访问 `http://192.168.3.211:18700` 或放开开发验证码监听。经总督/运维授权可用 `ssh -N -L 18700:127.0.0.1:18700 root@192.168.3.211`，Web 用 `http://127.0.0.1:18700`，以下 Edge 命令用同一隧道。若实际部署已有另一个批准入口，用实配 URL。启动和真实对话由操作者运行，不是本报告已执行的步骤。

```sh
# 终端 A：从仓库根启动独立 daemon，保持运行
export ONEX_HOME="$HOME/Library/Application Support/OneX-MVP"
export ONEX_SERVER=ws://127.0.0.1:18700/v1/edge/ws
./edge/target/debug/onexd

# 终端 B：同一 ONEX_HOME；先从仓库根记录二进制路径
export ONEX_HOME="$HOME/Library/Application Support/OneX-MVP"
ONEX_BIN="$PWD/edge/target/debug/onex"
command -v claude
claude --version
"$ONEX_BIN" login '<员工测试邮箱或手机号>' --server http://127.0.0.1:18700
"$ONEX_BIN" status
DEMO_DIR="$(mktemp -d)"
cd "$DEMO_DIR"
"$ONEX_BIN" run claude-code
```

- CLI 不要在命令行传验证码或 device token；按交互提示输入验证码。开发 OTP 由有权限的操作者在 211 私下读取。`onexd` 重启后 MVP 需要重新执行 `onex login`；这与 S1 原进程断网恢复不重新登录是两件事。两终端必须共用 `ONEX_HOME`，小余额测试改用另一个独立目录。launch 只用本机 PATH 的 `claude`，不是安装/校验流程。
- **日志**：Mac `$ONEX_HOME/logs/onexd.*.log` 和 CLI stderr；211 以 `deploy/README.md` 为准，可查看 `bash ~/apps/onex/current/deploy/onex.sh logs server`，`systemctl status onex-server` 用来确认单元状态。日志、HAR、受管策略文件、SQLite 及诊断资料不要整包转交；用脱敏关联 ID、提交、时间和结果。
- **权限和进程**：监督员原会话只能写共享清单与 `coord/reports/`，人工手册已由总督从报告目录放到 `docs/plan/` 后提交。不绕过权限从其他工具写产品文件。部署、seed、真实上游由有权限的操作者安排；不得改 211 上的 SIMA。不用 `pkill -f` 或其他宽匹配结束进程；用专用终端 Ctrl+C、已知子进程句柄或先核对单个 PID。不同 worktree 共用 stash，不用裸 `git stash`/`pop`。
