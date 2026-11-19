# OneX 移交说明

移交时间：2026-11-19 16:40。移交时 `main` 已包含全部开发分支，测试全部通过（Server 27 通过 1 跳过、管理端 26、Desktop 前端 1、Edge 161）。开发规则和测试命令见 [AGENTS.md](AGENTS.md)。

## 一句话现状

**MVP 的代码已经齐了，但还没有部署，也没有人工跑通过。** 下一步就是部署到 211，按 [MVP 人工验收步骤](docs/plan/mvp-walkthrough.md) 跑一遍。

## MVP 是什么

用户在 2026-11-19 要求“最短时间先达成一个可人工操作的 MVP，不要再深入”。定义见 [docs/plan/mvp.md](docs/plan/mvp.md)：

1. 管理员在 211 的管理端登录，看到租户、成员、Provider（local qwen）、倍率、橡皮余额。
2. 员工在本机 Mac 用 `onex login` 登录并注册设备，onexd 连上 211，收到配置、密钥和租约。
3. 员工运行 `onex run claude-code`，用本机已装的 Claude Code，模型流量经本机 router 转成 OpenAI Chat 发到 local qwen。
4. 对话几轮后，有正文权限的 owner 在监察页实时看到正文和橡皮费用。按契约 v0.11，普通 admin 默认只看摘要，每次读正文都记审计。
5. 余额用完后，下一次请求被拒绝。

## 各部分状态

| 部分 | 状态 | 详细说明 |
| --- | --- | --- |
| Server：租户、账本、配置下发、回流、监察 | 已完成，S1-S1 至 S1-S4 经独立监督员三轮验收**签收** | [roles/server.md](docs/handoff/roles/server.md)、[reviews/review-s1-server-3.md](docs/handoff/reviews/review-s1-server-3.md) |
| Server：MVP seed、部署脚本、局域网开关 | 已完成，本机安装和启停已验证；**未部署到 211** | [deploy/README.md](deploy/README.md) |
| 管理端 | 已完成，真实本地 Server 联调通过 | [roles/web.md](docs/handoff/roles/web.md) |
| Edge：router、Chat 转换、计价租约、密钥解密、CLI 登录、启动 Claude Code、会话采集 | 代码已完成，自动测试通过；计费三项阻塞已修，复验因 MVP 暂停；**本机整链没有跑过** | [roles/edge.md](docs/handoff/roles/edge.md)、[roles/magpie.md](docs/handoff/roles/magpie.md) |
| Desktop（Tauri） | 只有前端 mock 和 IPC 方案，推迟到 MVP 之后 | `desktop-ui/IPC.md`、`desktop-ui/PACKAGING.md` |

## 接手后第一件事：部署并跑 MVP

### 1. 部署到 211

211 是 `192.168.3.211`，Ubuntu 22.04，`ssh root@192.168.3.211` 用证书登录。上面还跑着 SIMA 和很多其他服务，**不要碰 `sima.service` 和 `~/apps/sima`**。根分区只剩约 20 GB。

用户决定 MVP 走局域网直连（不用 SSH 隧道）。第一次部署前，在 211 上写好 `~/apps/onex/service.env`：

```sh
ONEX_HOST=192.168.3.211
ONEX_ALLOW_LAN_DEV=1
```

然后在本机仓库根目录执行（要先提交，脚本只打包 `HEAD`）：

```sh
bash deploy/deploy.sh root@192.168.3.211
```

部署完，按 `deploy/README.md` 的“Provision the MVP users”一节：停服、在 211 上跑 `seed-mvp.ts`、再启动。验证码只打印在 211 的 Server 日志里（`bash ~/apps/onex/current/deploy/onex.sh logs server`），不通过任何接口返回。

注意：开发模式的 HTTP 和 WS 都没有加密，只能在受控局域网内用。

### 2. 本机跑 Edge

```sh
cargo build --manifest-path edge/Cargo.toml --workspace
export ONEX_HOME="$HOME/Library/Application Support/OneX-MVP"
export ONEX_SERVER=ws://192.168.3.211:18700/v1/edge/ws
./edge/target/debug/onexd          # 终端 A，保持运行
./edge/target/debug/onex login <员工账号> --server http://192.168.3.211:18700   # 终端 B
cd <一个空的项目目录>
<仓库>/edge/target/debug/onex run claude-code
```

包名是 `onex-cli`，可执行文件叫 `onex`。onexd 每次重启后都要重新 `onex login`（设备私钥只在内存里，MVP 的取舍）。

### 3. 按验收步骤走一遍

[docs/plan/mvp-walkthrough.md](docs/plan/mvp-walkthrough.md) 写于 CLI 命令定名之前，**以上面的命令为准**。余额耗尽要用单独的小额租户测，不要耗光主测试租户的 1000 橡皮。

local qwen：`http://192.168.3.212:11516/v1`，模型 `Qwen3.8-27B`，vLLM，只有 OpenAI 接口，不需要密钥。自动测试一律用假上游，不调用真实模型。

## MVP 之后的待办（按优先级）

1. **Edge 计费复验**：去掉 `edge/onexd/tests/e2e_lease_server.rs` 的 `#[ignore]`，跑通真实 Server 的续租回包丢失场景。另有一处静态发现需要联验：实际用量略超租约额度时（例如 31 对 30），Server 对 `used_milli > budget` 返回校验错误，Edge 能否正常续租和对账。见 [roles/magpie.md](docs/handoff/roles/magpie.md)。
2. **Edge router 三项小修**：HTTP 200 里的业务错误终态、`message_stop` 后不等 EOF；禁用 reqwest 自动重定向；SSE 行和事件的字节上限。见 [reviews/review-s1-edge-1.md](docs/handoff/reviews/review-s1-edge-1.md)。
3. **完整 S1**（[docs/plan/sprint-1.md](docs/plan/sprint-1.md)、[docs/plan/s1-acceptance.md](docs/plan/s1-acceptance.md)）：Tauri Desktop、设备私钥存 Keychain、Mac 安装包、Claude Code 下载与校验、诊断与日志拉取、审计查询、子 Agent 和压缩的采集、两小时与断网真机验收。
4. S2 起：Windows、Codex、Kimi Code，再到 WorkBuddy、DeepSeek Desktop。5 个 Agent 的适配规格已写好，在 `docs/specs/agents/`。

## 文档地图

| 想了解 | 看这里 |
| --- | --- |
| 为什么做、用户做过哪些决定 | [docs/kickoff/goal-interview-20261119.md](docs/kickoff/goal-interview-20261119.md)、[docs/plan/master-plan.md](docs/plan/master-plan.md) 第 7 节 |
| 接口 | `contracts/`，有版本号，改动都记在文件里 |
| Claude Code 怎样被接管 | [docs/specs/agents/claude-code.md](docs/specs/agents/claude-code.md) |
| SIMA 踩过的坑 | [docs/specs/sima-lessons.md](docs/specs/sima-lessons.md) |
| Magpie 的网关和协议转换 | `docs/specs/magpie/` |
| 每个角色交接时的详细状态 | `docs/handoff/roles/` |
| 监督员的验收报告 | `docs/handoff/reviews/` |
| Claude Code 会话文件结构、依赖版本与校验值 | `docs/handoff/samples/` |

## 本机环境注意

- 本机访问 GitHub 要经 FlClash 代理 `http://127.0.0.1:7890`；`install-deps.sh` 下载失败时设置 `HTTPS_PROXY`。
- 本机磁盘很紧（移交时约 8 GB 可用），Rust 编译产物会占好几 GB。
- 参考仓库：SIMA 在 `/Users/HHH/Code/SA/SIMA`，Magpie 在 `/Users/HHH/Code/OneX/refs/magpie`（提交 `0e3d093611e8bd226e3136113aafd75f5d7f4914`）。
- 用户的个人助理 Skill “葫芦”（Hulu）有跨项目记忆，找 SIMA 等项目的资料可以先查它：`bun ~/.codex/skills/hulu/scripts/hulu_memory_index.mjs lookup --query '<线索>'`。

## 附录：多进程协作机制（可选）

到移交为止，开发用的是一个“总督”加五个 Claude Code 进程，跑在 tmux 里。接手者可以不用，直接在 `main` 上开发即可。如果想沿用，材料在 `docs/handoff/coordination/`：

- **分工**：总督负责计划、契约、审查合并、把需要裁决的问题提给用户；server、edge、web 三个开发进程各自在 `/Users/HHH/Code/OneX/wt/<角色>` 的 worktree 和 `dev/<角色>` 分支上工作，只改自己的目录；magpie、sima 两个监督员只读，用不同于开发者的模型独立验收。监督员查出过多个开发者自测没覆盖到的计费和权限缺陷，这是这套机制最有价值的部分。
- **通信**：文件邮箱。`mail-send <收件人> <发件人> '<正文>'` 写入 `coord/mail/<收件人>/`，`mail-wait <角色> <秒>` 等信并归档。不用 Claude Code 的 SendMessage，因为权限模式不同的会话之间消息会被扣住，要人工放行。
- **启动**：`launch.sh`（开发进程）、`supervisor-launch.sh`（监督员），都起在 `tmux -L onex` 会话里，用户用 `tmux -L onex attach -t onex` 查看。权限用允许列表控制：开发进程禁止 push、合并到 main、`rm -rf`、`pkill -f`。文件写入的权限规则要写 `Edit(...)`，`Write(...)` 不是有效的规则名。
- **合并**：`verify-main --push` 先装依赖、跑全部测试，全部通过才推送。
- **Codex 下的对应**：这套脚本是给 Claude Code 写的。Codex Desktop 有自己的多任务方式，可以只借用分工和“开发者与验收者分开”的原则，邮箱脚本是纯 Bash，任何工具都能调用。
