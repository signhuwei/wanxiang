# Codex CLI 受管适配规格

## 发行证据与安装

建议以 Windows 上实际测过的 **0.164.0** 为兼容性起点，不把它当作现行最新版。SIMA 用真实 app-server 对两个回环假上游做了 12 次请求，同一 thread 切模型；没有真实模型或 PTY，Mac 不能据此放行（`docs/reports/all-agent-model-output-windows-20261029.md:22-26,44-50`）。另有 Windows x64 **0.163.0** 的下载、解包入库证据，不是 0.164.0 的摘要（`docs/reports/poc-01/agent-source-20261020/README.md:13-19,30-34`）。下文路径均相对 SIMA `b6df0bfe`。

从 `https://registry.npmjs.org/@openai/codex` 发现版本，按确切版本的 `https://releases.openai.com/codex/releases/{ver}/release.json` 选择目标 triple。Windows 资产名含 `.exe.tar.gz`，归档成员可带 triple，不可只找短名 `codex.exe`。按官方 SHA-256 核归档，再在空私有目录仅提取清单指定的普通可执行文件，记录解包后大小与 SHA；Edge 启动前核对获准平台和可执行摘要。不执行安装脚本，不用系统 PATH 中的个人 Codex。依据：`contracts/poc-01/agent-sources.md:7-13,23-35` 与上述实拉报告。

## 配置、环境与协议

在授权 cwd 运行绝对路径的 CLI。Mac 使用 `$CODEX_HOME/config.toml`，Windows 使用 `%CODEX_HOME%\config.toml`；都是本次受管 profile 的 `codex` 子目录，不是个人 `.codex`。`HOME/USERPROFILE` 指向私有 home，AppData/XDG、缓存和 tmp 全部重定向；不复制个人 OAuth、供应商环境、代理或项目授权。macOS 对非受管 `/etc/codex` 配置应拒绝，不通过修改机器策略或关闭 Windows 沙箱解决冲突。依据：`edge/src/lifecycle/adapter.rs:508-515,526-543,640-664,674-695,797-825`。

SIMA 写 `model=<alias>`、`model_provider="sima"`、`model_providers.sima.{base_url,env_key,wire_api}`，分别为 `http://127.0.0.1:<port>/v1`、本机令牌环境名 `SIMA_MODEL_TOKEN`、`responses`；分别用 `-c key=value` 固定同值，不在参数或 TOML 放令牌值。关闭自动更新检查、请求和流重试。启用项目资源时原生 TOML 会递归合并，SIMA 为每次 launch 生成独立 provider 名，不让项目补入认证或 headers；基线不启用项目发现。依据：`edge/src/lifecycle/adapter.rs:670-745`。OneX 的生成策略应写入自有私有临时文件，flush/fsync 后同目录原子替换，跨窗口不共写；退出撤销令牌、卸载只收回有归属的文件。个人配置从未改写，不能用备份覆盖它。

客户端是 **OpenAI Responses**，`POST /v1/responses`，本机 bearer 由 router 消费；不是让 Codex 自己发 Chat。按获准模型映射到上游，保持 function/custom tool 调用 ID、历史、流式终态。若上游为 Chat 且未配置生成预算，保持省略；Messages 必须有 `max_tokens`，SIMA 的 8192 是特定转换兜底，不是 Codex 官方默认。缺用量不填零。依据：`docs/reports/all-agent-model-output-windows-20261029.md:15-26`。

## 原生记录、进程和恢复

对话取已登记 `CODEX_HOME/sessions/.../rollout-*.jsonl`，不是从网络请求重建，不读运行中的 Codex SQLite。`response_item` 取 user/assistant 可见文本，以及 function/custom 调用与结果；`event_msg` 是 UI 副本，`compacted.message` 是压缩快照，都不再生成发言。以原生 thread、行号、类型和文件游标识别事件，不能按文字或仅按 record ID 去重。半行等换行；轮转、截断、未知类型标缺口。工具、公开对话与模型请求计量分流；游标、事件、outbox 同事务，归档按稳定 ID 和耐久 ACK 重试。依据：`contracts/poc-01/codex-transcript.md:5-25`；`edge/src/lifecycle/codex_history.rs:209,531`。

先绑定授权身份、home/thread、cwd 和路由，再开 PTY；退出区分 leader 状态、后代清理、尾写与上传 ACK。进程树已完全退出时才排空旧源、冻结旧读者、交接游标，用 `resume <thread-id>` 精确续接；崩溃清理不确定或并行运行时改用隔离 profile，不猜“最近一次”，不自动执行上一轮输入。依据：同契约 `:10-23`；`edge/src/lifecycle/codex_history.rs:341,438-439`。

## 已知缺口及验收

- 0.164.0 的原生 `/new` 可在同进程另建 thread，SIMA 标 `CODEX_THREAD_UNBOUND`；子 Agent rollout 不支持时标 `CODEX_SUBAGENT_CAPTURE_UNSUPPORTED`。显示已观察或已 ACK 不等于对话完整。OneX 要覆盖新 thread 的登记或明确提示不支持，不能错归旧会话。`contracts/poc-01/codex-transcript.md:19-25`。
- 跨轮消息 ID 可复用，重启后同文两轮不得折叠；验同日两个 thread、压缩、工具取消、迟到结果和断网丢 ACK。另验进程崩溃后的旧读者隔离，不能将未确权旧 profile 补到新账户。`contracts/poc-01/codex-transcript.md:15-23`。
- 待测：两平台精确制品及 Mac 原生 TUI、项目/机器配置优先级、沙箱和工具子进程不继承令牌、不同上游的工具流和计费、应用卸载后个人目录字节不变。本文仅核对静态证据，没有运行 Codex、服务或模型。


