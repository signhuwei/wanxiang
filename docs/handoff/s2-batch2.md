# S2 第二批移交（2026-11-20）

接手前先读 [AGENTS.md](../../AGENTS.md)、[HANDOFF.md](../../HANDOFF.md)、[S2 计划](../plan/sprint-2.md)「第二批」。本文记录第二批停下时的状态。

下文提到的 `coord/reports/s2/` 报告和交接说明，在仓库里有一份副本：[docs/handoff/s2b/](s2b/)（`quota-review.test.ts` 存为 `.txt`，避免被 `bun test` 捡到）。

## 基线

- 本地 `main` 是本文所在提交，比公开 `origin/main`（`0877496`）领先 70 多个提交，没有推送。原因见 Hulu 记录：GitHub 仓库是 public，内测源码是否外推要用户决定。
- 211 仍运行 `2dcf5d3`。第二批没有部署。
- `main` 全量回归：Server 82 通过 1 跳过、Web 48、Desktop 前端 1、Edge 246 通过 1 跳过，全部 0 失败（2026-11-20 11:25）。

## 已合入 main

| 内容 | 提交 |
| --- | --- |
| 租户审计查询（上一轮 Codex 候选） | `b47db7b` |
| Windows 原生移植（上一轮 Codex 候选，Windows 侧编译打包仍待 Windows 环境），以及合入后的 Mac 编译修复 | `f247de6`、`6594f4c` |
| 契约 v0.12：组和个人月配额，Codex 和 Kimi 接入 | `d514d95` |
| 契约 v0.13：断流后的恢复（S1 遗留缺陷）、断流优先级、配额口径、多 Agent 会话与 payload、Responses 计量和转 Chat | `cfeb824`、`61f66ac`、`2aad299`、`d8371d3`、`7e08d85` |
| Server 月配额：签发和续租时裁决、`/quota/usage`、台账 `month_used_milli`、`/me.quota`、上海月份、聚合查询 | `68132c7`、`351eb06`、`86e731e`、`edf7d79` |
| Server 断流恢复：`cutoff.settled_lease_id`、`lease_request` | `9ea17be` |
| 管理端配额：台账列、钻取、表单、个人菜单提示，真实 Server 联调脚本 `server/web/tests/quota-check.js` | `15e423a`、`913909e` |
| Edge：识别 `quota` 断流原因和 `quota_exhausted` 提示；按 Agent 分派受管启动 | `d514d95`、`3fc2410` |
| Edge 断流恢复：丢弃已结清租约、`used -= 快照`、`lease_request`；对真实 Bun Server 的端到端恢复用例通过 | `c552431`、`68b0572` |
| `onex run <claude-code\|codex\|kimi-code>`（onexd 端目前仍只放行 claude-code） | `16dd859` |

独立验收（Opus）签收了 Server 配额和 Server 一半的断流恢复，报告在 `/Users/HHH/Code/OneX/coord/reports/s2/quota-review.md`，反例脚本 `quota-review.test.ts` 可直接复用。

## 未合入的分支

各分支和工作树在 `/Users/HHH/Code/OneX/wt/s2b-<名>`。每条线的交接说明在 `/Users/HHH/Code/OneX/coord/reports/s2/handoff-s2b-<名>.md`。worker 没有该目录的写权限，所以 quota-api、codex、kimi 的是总督从邮件转存的；lease、quota-web 收尾时模型网关返回 429（额度用完），由总督按分支状态代写。

| 分支 | 状态 | 合入前必须做的 |
| --- | --- | --- |
| `dev/s2b-codex` | `0b488a9` 受管启动、`cda2c16` Responses 路由，都被独立验收退回，修复未开始。工作树里另有未提交、未测试的采集半成品 `codex_capture.rs` | 见下方“Codex 线退回项”。线程建议先定 session_id 再续写采集 |
| `dev/s2b-kimi` | `7e32dd6`、`eeccba1`、`19a7f02`。最后一次按真实 wire 1.5 重写了采集器，126 行样本得到 4/3/8/8/1 compact/0 gap，onexd 136 个库测试通过 | 独立验收用同一份样本复验；核对 payload 公共字段、UUID v5 session_id、不跟随符号链接、令牌配置在退出时删除是否都做了（见交接说明）；合并时 `launch.rs` 以 main 为准，只加 `"kimi-code" => kimi_launch::prepare_kimi_code(r)` 和 `LAUNCHABLE_AGENTS` |
| 监察页多 Agent | quota-web 工作树里未提交（`format.js`、`observation.js`），单测通过 | 先给 Server 的 `/observe/people`、`/observe/sessions` 加 Agent 字段和筛选（契约未写），再去掉客户端过滤 |

### Codex 线退回项

报告：`/Users/HHH/Code/OneX/coord/reports/s2/codex-review.md`。

- **X-H1 绕过计费（高）**：Codex 会合并项目的 `.codex/config.toml`，员工能自定义 provider 绕开 router。路由值全部用 `-c` 固定，关闭项目配置发现，cwd 含 `.codex` 时拒绝启动。
- **X-H2 令牌泄漏（高）**：本机令牌环境变量会被 Codex 的 shell 子进程继承。用 `shell_environment_policy` 排除。
- **R-H1/R-H2 计费（高）**：Responses 入口缺省预留为 0，流式期间不估算，中断记 0 费用。要复用 router 的 Meter。
- **R-H3/R-H4 转 Chat（高）**：输出条目不完整；`custom`、`local_shell` 工具不支持；并行调用序列不合法。MVP 上游 local qwen 是 Chat，Codex 第一轮就可能失败。
- 其余中低项和 6 条待补测试见报告。
- 会话采集（步骤 4）未开始。SIMA 没有 Codex rollout 样本，要按 SIMA `edge/src/journal/codex.rs`、`codex_tests.rs` 自己写合成样本。

### Kimi 线退回项

报告：`/Users/HHH/Code/OneX/coord/reports/s2/kimi-capture-review.md`。

- 字段路径改成真实形状（`message.message.{role,content}`，工具用 `toolCallId/name/args/result.*`）。
- 已知忽略清单按真实的 26 种顶层类型写全。
- 压缩、重放副本、空内容、私有块的处理。
- payload 公共字段、原生时间、UUID v5 的 session_id。
- 不跟随符号链接；令牌配置写 run 目录并在退出时删除。
- 验收：样本 126 行得到 4 条用户、3 条助手、8 次调用、8 个结果、1 条压缩、0 条缺口。

## 已知缺口（记录，不在本批）

- Windows 原生编译、测试、NSIS 打包：等 Windows 环境回执。
- Codex 0.164.0、Kimi 2.3.0 的真实制品行为（配置键、Responses 条目形状、wire 版本）没有在本机验证。
- `/members`、`/groups` 不返回组名，`group_admin` 调 `/groups` 得 403：留给组管角色批次。
- 验收标准 C2：配额耗尽前本机租约不足时先提示 `balance_exhausted`，续租拿到 `cutoff{quota}` 后才是 `quota_exhausted`。已写进 S2 计划。

## 开发环境注意

- 磁盘紧张（约 5 GB 可用）。Rust 线各用 `/Users/HHH/Code/OneX/coord/.build/s2b-<名>` 的独立编译缓存（APFS 克隆）。**不要让多棵 worktree 共用一个 `CARGO_TARGET_DIR`**：同名 crate 的编译产物会互相覆盖，导致跨分支的编译错误。
- `server/web/tests/quota-check.js`、`workspace-check.js`、`browser-check.js` 是独立脚本，用 `bun <文件>` 运行，不是 `bun test`。浏览器检查要先 `bun server/web/tests/serve.js 8123`。
- 停进程不要用 `pkill -f`，会误杀其他 Agent 进程。

## 多进程协作（可选沿用）

启动器 `/Users/HHH/Code/OneX/coord/bin/s2b-worker <角色>`，公共说明 `coord/briefs/s2b-common.md`。带 `RESUME=<会话 ID>` 可以接回原会话。tmux 会话 `onex` 已关闭，巡检定时任务已删除，邮箱记录保留在 `coord/mail/`。给 worker 的交接任务要让它写自己工作树内的文件，或者把 `coord/reports/` 加进启动器的写入范围。
