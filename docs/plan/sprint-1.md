# S0 与 S1 任务清单

S0 搭骨架、冻结契约；S1 在 Mac 上跑通 Claude Code。总体背景见 [master-plan.md](master-plan.md)。

## S1 验收标准

1. 一名新员工在一台干净的 Mac 上，5 分钟内装好 OneX Desktop 并用验证码或邀请码登录。
2. 他在 Desktop 里点 Claude Code，OneX 下载、校验并启动它，模型流量经本机 router 到上游。
3. 他用 Claude Code 连续工作 2 小时，期间不掉线、不需要重新登录。人为断网 2 分钟后恢复，工作不中断，对话补传完整。
4. 管理员在网页上实时（延迟 ≤ 5 s）看到完整对话和 token 费用（橡皮）。
5. 橡皮余额用完时，下一次模型请求立即被拒绝，Claude Code 看到明确的错误信息。
6. 出故障时，一个 Agent 通过 Server API 让这台 Edge 打包上传日志，并下载到日志包。
7. 管理端页面遵守 SIMA UI 规则（台账、钻取、表单；钻取时台账左缩；不用弹窗；服务端分页），1280×720 和 1440×900 下无外层溢出。

## S0 任务（骨架与契约）

| 编号 | 负责 | 任务 | 完成标准 |
| --- | --- | --- | --- |
| S0-1 | magpie 分析员 | `docs/specs/magpie/` 四份规格 | 总督审阅通过 |
| S0-2 | sima 分析员 | `docs/specs/agents/` 五份规格和 `sima-lessons.md` | 总督审阅通过；`claude-code.md` 优先 |
| S0-3 | 总督 | `contracts/` v0：WS 协议、HTTP API、数据模型、错误码 | 三个开发进程确认可实现 |
| S0-4 | edge | Rust workspace：`onexd`、`onex-cli`；IPC 骨架；WS 客户端连上 Server、心跳、断线重连 | `cargo test` 通过；连本地 Server 能保持连接 |
| S0-5 | server | Bun/Hono 骨架；system 库和租户库迁移；验证码与邀请码登录；设备注册；WS 网关与心跳；Valkey 在线状态 | `bun test` 通过 |
| S0-6 | web | 管理端外壳和三种页面模式的公共组件；登录页；成员台账（读假数据或 S0-5 的 API） | 两种尺寸截图无溢出 |
| S0-7 | 总督 | `tests/e2e/fake-upstream`：假 Anthropic 和 OpenAI 上游，支持流式、慢速、断流、usage | e2e 用例可调用 |

## S1 任务（按依赖顺序）

| 编号 | 负责 | 任务 |
| --- | --- | --- |
| S1-E1 | edge | 本机 router：Anthropic Messages 透传到 Anthropic 兼容上游，流式转发，提取 usage |
| S1-E2 | edge | 计价与租约：按倍率实时计算橡皮；租约续期；余额或租约用完即断流并返回 Anthropic 格式错误 |
| S1-E3 | edge | 会话事件捕获：从请求和响应中提取增量事件，写本地 SQLite，带序号经 WS 回流，收到确认后标记，重连补传 |
| S1-E4 | edge | Claude Code 管理：按规格下载、校验、隔离 home、写配置、启动、退出检测 |
| S1-E5 | edge | 诊断：收到 Server 指令后打包日志上传 RustFS |
| S1-E6 | edge | Desktop（Tauri）：登录、Agent 列表、启动、托盘，与 onexd 走 IPC |
| S1-E7 | edge | Mac 安装包：pkg，含 Desktop 和 onexd，launchd 自启动 |
| S1-S1 | server | 租户、成员、组、合约（人数上限、可用 Agent、可用模型）、Provider 与倍率表 |
| S1-S2 | server | 橡皮账本：充值、预留、结算、余额；租约签发与续期 |
| S1-S3 | server | 配置下发：路由、加密的上游密钥、Agent 发行信息 |
| S1-S4 | server | 回流写入队列：按租户批量提交，返回确认序号；监察实时推送（SSE 给管理端） |
| S1-S5 | server | 诊断 API：给某台 Edge 下发日志收集指令，返回下载地址 |
| S1-S6 | server | 审计：所有查看对话、改合约、加橡皮的操作写审计 |
| S1-W1 | web | 成员与组；邀请码生成 |
| S1-W2 | web | Provider、模型与倍率；租户合约 |
| S1-W3 | web | 橡皮：充值、余额、流水 |
| S1-W4 | web | 监察：人员台账 → 会话台账 → 对话阅读，实时刷新；token 费用 |
| S1-W5 | web | 设备与诊断：设备台账、拉日志 |
| S1-T1 | test | 端到端：假上游下的 2 小时压缩测试（加速时钟）、断网恢复、余额用完、重复与乱序回流 |
| S1-T2 | 用户和测试员 | 真机验收：干净 Mac、真实上游、2 小时 |

## 断网验收口径（2026-11-19）

验收标准第 3 条的“断网 2 分钟”分两种情况测：

- **只断 Edge 与 Server 的连接**（上游 local qwen 仍可达）：Claude Code 继续正常对话，靠当前租约放行；恢复后补传完整，账本对上。
- **整机断网**（上游也不可达）：断网期间的模型请求失败是预期结果，Claude Code 显示网络错误即可，不要求完成远端模型轮次。要求是：恢复网络后不用重启、不用重新登录就能继续对话，断网前的对话补传完整，没有重复扣款。

## S1 范围决定（2026-11-19，回应 Magpie 分析报告）

| 问题 | 决定 |
| --- | --- |
| 协议 | S1 只做 Anthropic Messages 同协议透传。Anthropic → OpenAI Chat 转换放到 S2（Codex、Kimi 需要时）；Responses 和 Gemini 另列，“OpenAI 兼容”不代表两者都支持 |
| Claude Code 能力 | `count_tokens` 透传（不计费，不回流）；多模态和 beta 请求头原样透传；中断的工具回合不修补，原样转发，由上游报错 |
| 只在尾帧报用量 | 请求开始时按 `max_tokens × 输出单价 + 估算输入 × 输入单价` 预留，结束后按实际用量结算，多余部分释放。没有尾帧时按已见部分计价，标 `complete=false`，Server 记待结算，S1 不自动补结算，在监察中标出 |
| 重试与换路 | 只在没有收到上游任何响应头时重试一次，不换路。收到响应头以后一律不重试。已发往上游的尝试即使失败也记一条 usage（`status` 为 `upstream_*`） |
| 失联 | 只用租约签发时的路由快照，不切换 |
| Claude Code 隔离 | 隔离目录以 SIMA 规格为准，S0-2 交付后再定 |
| launchd | 用户级 LaunchAgent。Windows 在 S2 决定 |
| 卸载 | 先尝试补传，30 秒内未确认的回流打包进本地诊断目录，不直接删除 |
| 日志拉取 | 租户 owner、admin 和平台管理员可以发起；每台设备每 10 分钟最多 1 次；写审计；日志包保留 7 天 |
| 更新 | S1 只在没有进行中的流时更新 |

## 风险

| 风险 | 应对 |
| --- | --- |
| Claude Code 自动更新或改配置格式 | 固定版本，从 OneX 发行目录下载，禁用自更新；规格里记录版本 |
| SQLite 写入在回流高峰时排队 | S1 后半段用假 Edge 模拟 50 人并发回流压测，必要时提前拆库或引入批量写入优化 |
| 一人开发，五个进程的合并冲突 | 目录独占，契约只由总督改；每天至少合并一次 |
| 模型分工不合适 | S0 结束时按各进程实际产出复盘，调整分工 |
