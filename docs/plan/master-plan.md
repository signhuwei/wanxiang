# 万象 OneX 总体计划

2026-11-19 起草。依据是[立项目标访谈记录](../kickoff/goal-interview-20261119.md)。本文定架构、数据层、冲刺划分和多进程分工；第一轮冲刺的任务清单见 [sprint-1.md](sprint-1.md)，接口见 `contracts/`。

## 1. 目标

万象是企业 AI Agent 的纳管与统一管控基座，以 SaaS 形态交付。第一版只做纳管，要求可用、稳定：

- 员工装好 OneX Desktop 并登录，就自动拿到 AI 能力配置，点一下即可启动获准的 Agent。Agent 只能由 OneX 下载和启动。
- 模型额度统一采购，租户预付费购买橡皮，余额用完立即中断。
- 管理员实时看到完整对话和 token 费用；户主决定管理员和组管的可见范围；所有查看都记审计。
- 万象本身对 AI 友好：所有状态都能通过 API 查询，所有操作都能由 Agent 执行，每台 Edge 都能远程诊断并回传日志。

## 2. 架构

```
员工电脑                                          OneX SaaS
┌──────────────────────────────────┐            ┌────────────────────────────────┐
│ OneX Desktop（Tauri，托盘）        │            │ Server（Bun / TypeScript / Hono）│
│   │ 本机 IPC                       │            │  ├ 认证、租户、组、成员、合约      │
│ onexd（Rust / Tokio，后台 daemon） │ WebSocket  │  ├ Provider、路由、橡皮账本、租约 │
│  ├ 本机 router 127.0.0.1           │◄─────────►│  ├ Edge 网关（WS）、诊断命令      │
│  ├ 用量计价、租约执行、断流         │            │  ├ 会话回流写入队列               │
│  ├ 会话事件捕获、本地暂存、补传     │            │  ├ 监察 API、审计                 │
│  ├ Agent 下载、校验、隔离启动       │            │  └ 管理端 Web（原生 ESM，无构建）  │
│  └ 日志、远程诊断                  │            ├────────────────────────────────┤
│ Agent（Claude Code 等）            │            │ system.sqlite、tenant-*.sqlite    │
│   └ 模型请求 → 本机 router ────────┼──► 上游 Provider（Kimi、OpenRouter 等）       │
└──────────────────────────────────┘            │ Valkey、RustFS、DuckDB（后期）     │
                                                └────────────────────────────────┘
```

关键决定，来源均在访谈记录中：

| 决定 | 内容 |
| --- | --- |
| 模型流量 | 只经本机 router 直连上游，不经 Server 中继。Edge 必须拦截模型流量 |
| 上游密钥 | Server 加密下发给 onexd，只在 daemon 内存中解密使用，Agent 配置里只写本机地址和本机令牌。后期每人配一个 Provider，作用相当于子密钥 |
| 计价与断流 | onexd 按模型倍率（输入、输出分开）实时计算橡皮，在租约额度内放行，超出即断流 |
| 离线 | 短时额度租约：时间上限和橡皮上限先到先停，超支最多一个租约。对话先存本地，恢复后补传 |
| 回流 | 回流单位是增量会话事件，带序号，断线重连后不丢、不重。token 用量作为计量数据单独记录 |
| 通信 | Edge 与 Server 之间一条 WebSocket 长连接，承载配置、租约、回流、断流和诊断 |
| Desktop | Tauri，带托盘、可隐藏；Mac 和 Windows |
| 管理端 UI | 沿用 SIMA 的 UI 规则：台账、钻取、表单三种页面；钻取时台账左缩；主表单不用弹窗；服务端分页。规则写进每轮验收 |
| 利旧 | 利旧知识，不利旧代码。SIMA 的 Agent 接管细节和 Magpie 的协议转换整理成规格后重写 |

## 3. 数据层

| 存储 | 放什么 | 何时引入 |
| --- | --- | --- |
| `system.sqlite` | 平台账号、租户目录、Provider 与模型、倍率表、发行目录、平台审计 | S1 |
| `tenant-<id>.sqlite` | 成员、组、合约、橡皮账本、设备、会话、会话事件、用量、租户审计 | S1 |
| Valkey | 在线状态、WS 连接归属、会话状态、租约 | S1。Server 频繁发版，状态不能放进程内存 |
| RustFS（sidecar） | Agent 安装包、大段附件、Edge 日志包、Parquet 导出 | S1 只存日志包和安装包 |
| DuckDB（嵌入） | 读 Parquet 做监察统计和报表，不承担在线写入 | S3 |

SQLite 每库一个写者，全部用 WAL。Server 内为每个租户库维护一个写入队列，回流事件按批提交（目标：每批 ≤ 50 ms 或 ≤ 500 条）。

规模估算：每人每天 2000 万至 3000 万 token 主要是重发的上下文，需要存储的新增内容远小于此。按每会话 50 轮、每轮新增 5 至 20 KB 估算，每人每天新增约 5 至 50 MB 文本。S1 期间实测后修正这个数字，再决定附件和长正文何时转存 RustFS。

## 4. 仓库布局

```
wanxiang/
  contracts/          接口契约（总督独占）：Edge↔Server WS、HTTP API、数据模型
  docs/               计划、规格、决策、报告
  edge/               Rust workspace
    onexd/            daemon：router、租约、回流、Agent 管理、诊断
    onex-cli/         命令行（调试、诊断）
    desktop/          Tauri 应用
  server/             Bun / Hono
    src/              API、WS 网关、账本、写入队列
    web/              管理端，原生 HTML/CSS/ESM，无构建
  tests/e2e/          端到端测试和假上游
```

## 5. 冲刺划分

| 冲刺 | 内容 | 退出标准 |
| --- | --- | --- |
| S0 规格与骨架（进行中） | Magpie 与 SIMA 规格、契约 v0、三端骨架、CI、假上游 | 契约冻结；三端骨架能互通“登录 → 下发配置 → 心跳” |
| S1 Claude Code 跑通（Mac） | 详见 [sprint-1.md](sprint-1.md) | 新员工在干净 Mac 上 5 分钟内装好并登录，用 Claude Code 连续工作 2 小时不掉线、不重新登录；管理员实时看到完整对话和 token 费用；Agent 能通过 API 拉取这台 Edge 的日志 |
| S2 Windows 与 CLI Agent | Windows 版 Desktop 和 onexd；Codex、Kimi Code；橡皮分到组和个人；组管角色；可见范围设置；审计查询 | 测试员在 Windows 上完成 S1 同样的验收；三个 CLI Agent 各连续工作 2 小时 |
| S3 桌面 Agent 与分析 | WorkBuddy、DeepSeek Harness Desktop；DuckDB 和 Parquet 导出；监察统计；能力合约补全 | 5 个 Agent 全部可用；监察统计页在 100 人、30 天数据量下 p95 < 1 s |
| S4 上线准备 | 租户开通流程、备份与恢复、升级与回退、监控告警、压测 | 第一个外部租户试用 |
| 之后 | Magpie 覆盖的其他 Agent、合约模板、MCP/Skill 分发、c-si-bus 分发与协作、Linux 桌面 | 按客户需求排序 |

每轮冲刺结束时由用户验收，通过后才开下一轮。

## 6. 多进程分工

总督是当前会话（Claude Opus 5.5），负责计划、契约、任务分发、审查合并、汇总报告，并把需要裁决的问题提给用户。其他进程是独立的 Claude Code 进程，跑在 tmux 里，用户可以随时连进去看：

```
tmux -L onex attach -t onex        # 进入后 Ctrl-b w 选窗口，Ctrl-b d 脱离
tmux -L onex attach -r -t onex     # 只读观看
```

| 窗口 | 角色 | 模型 | 分配理由（假设，S1 结束后按实际表现调整） |
| --- | --- | --- | --- |
| `magpie` | Magpie 分析员 | GPT-6.2 Sol | 约 62 万行 Go 代码，要逐行抠协议转换和流式细节 |
| `sima` | SIMA 分析员 | Kimi K3 | SIMA 文档以中文为主、体量大、分散在多个分支，需要长上下文通读 |
| `edge` | Edge 开发 | Claude Opus 5.5 | Rust 异步流式转发、租约、断线补传，正确性要求最高 |
| `server` | Server 开发 | GPT-6.2 Sol | 账本、WS 网关、写入队列，规则明确、测试密集 |
| `web` | 管理端开发 | Kimi K3 | 按 SIMA UI 规则写原生 ESM 页面，中文界面 |
| `test` | 独立测试（S1 后半段启动） | 与被测代码的写者不同 | 新上下文，不复用写者自测结论 |

协作规则：

- 每个开发进程在自己的 git worktree 和分支上工作（`/Users/HHH/Code/OneX/wt/<角色>`，分支 `dev/<角色>`），只改自己独占的目录。`contracts/` 只有总督能改，其他进程要改契约就给总督发消息。
- 总督审查后把分支合并到 `main` 并推送。开发进程不推送。
- 进程之间用 SendMessage 通信，总督的地址是 `wanxiang-bb`。任务说明放在 `/Users/HHH/Code/OneX/coord/briefs/`，完成报告放在 `coord/reports/`，总进度在 `coord/status.md`（总督单写）。
- 开发进程不调用真实模型；端到端测试用 `tests/e2e/` 的假上游。真实模型调用由总督协调，事先告知用户。
- 不能确定的判断交给总督，总督汇总后提给用户裁决。

## 7. 用户裁决（2026-11-19）

| 问题 | 决定 |
| --- | --- |
| 依赖安装 | 用一致的安装脚本，本机（macOS）和 Ubuntu 服务器都能自安装（Valkey、RustFS、Bun 等），不依赖手工步骤 |
| 分析员 | 两个调研完成后转为验收监督员 |
| S1 范围 | 包括 Tauri Desktop |
| 部署 | Server 部署在 `192.168.3.211`（Ubuntu 22.04），用户 root，本机证书直连 ssh，目录 `~/apps/onex` |
| 真机验收上游 | local qwen：`http://192.168.3.212:11516/v1`，模型 `Qwen3.8-27B`，免 API Key，vLLM，只有 OpenAI 兼容接口 |
| 模型分工 | Kimi K3 限流严重，原分给 K3 的 sima 和 web 改用 GPT-6.2 Astra |

由此带来的计划变化：

- **S1 需要 Anthropic → OpenAI Chat 协议转换。** local qwen 没有 `/v1/messages`（实测 404），Claude Code 只说 Anthropic 协议。原计划放在 S2 的转换提前到 S1，用 magpie 已写好的 `docs/specs/magpie/anthropic-to-chat-test-cases.md` 作为验收用例。
- **211 的根分区已用 95%（剩 20 GB）。** OneX 的数据目录要设容量告警，日志按天滚动并限总量；回流数据量在 S1 实测后再定是否另挂磁盘。
- 211 上已有 SIMA（`sima.service`）、端口 30000、18000 等服务在跑。OneX 用独立的 systemd 服务名 `onex-*` 和独立端口，不碰 SIMA。
