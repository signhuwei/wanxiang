# Kimi Code CLI 受管适配规格

## 发行证据与安装

SIMA 在 Windows 实读版本 **2.3.0**，用原生 prompt 模式对两个回环假上游验证逐模型预算，共 8 次请求；并非真人 PTY 或真上游长跑。另有 Windows 2.3.0 真人运行中退出的记录（不算稳定性通过）。依据：`docs/reports/all-agent-model-output-windows-20261029.md:13-15,44-50`，`docs/reports/c-si-bus-poc-20261025/windows-kimi-daemon-lost-20261027.md:3-12`。以下路径相对 SIMA `b6df0bfe`。

从 `https://registry.npmjs.org/@moonshot-ai/kimi-code` 发现版本，冻结版本后读取 `https://code.kimi.com/kimi-code/binaries/{ver}/manifest.json`，按 `darwin-arm64`、`win32-x64` 等平台键取清单的 filename；是原生单文件，不解包。对齐官方 SHA-256、字节数和架构；私有 `.part` 校验完成后原子发布，候选获批方可安装。未发布的平台不能拿相近平台替代。依据：`contracts/poc-01/agent-sources.md:7-13,23-35`。

## 配置、环境与协议

Mac 写 `$KIMI_CODE_HOME/config.toml`，Windows 写 `%KIMI_CODE_HOME%\config.toml`，`KIMI_CODE_HOME` 固定为受管运行根下的 `kimi`；同目录 `mcp.json` 限授权资源。`HOME/USERPROFILE`、AppData、XDG、TEMP 均改用私有目录，Unix 大小写代理均清空并绕过回环代理。绝对路径启动；默认 `--skills-dir <私有目录>`，设置 `KIMI_CODE_NO_AUTO_UPDATE=1`、`KIMI_CLI_NO_AUTO_UPDATE=1`，Mac 隔离模式另设 `KIMI_CODE_WATCH=0`。不继承个人 Kimi 认证或把员工 home 当工作目录的资源根。依据：`edge/src/lifecycle/adapter.rs:526-543,640-664,746-782`。

`default_model` 指向生成的模型项；`providers.<id>.type="anthropic"`、`base_url="http://127.0.0.1:<port>"`（不加 `/v1`）、`api_key=<本机短期令牌>`。SIMA 旧固定版本不支持 `api_key_env`，此文件因而须按秘密文件处理；不得存上游渠道 Key。`models.<id>` 绑定 provider、获准 model、`max_context_size` 和能力，2.3.0 支持每个模型可选 `max_output_size`，省略交给原生推断。关遥测、自动标题及额外尝试，不把推理开关当作权限控制。依据：`edge/src/lifecycle/adapter.rs:768-781`；`docs/reports/all-agent-model-output-windows-20261029.md:13-20,30-31`。

Agent→router 是 **Anthropic Messages**，入口 `/v1/messages`，认证来自上述本机 `api_key`，不是 Kimi 品牌决定必须用 OpenAI Chat。上游可为 Messages 或 Chat；router 另行认证和转换，保留流式工具调用，拒绝不支持的语义。本机头的精确集合要在目标版本抓取脱敏形状再冻结。OneX 应按 launch 私有权限同目录临时写、fsync 后原子发布；退出撤销本机令牌并清理策略，保留待传历史。卸载只删除已核归属的文件，不动个人配置，无需恢复个人密钥。依据：上述输出报告 `:31,44-50`；`edge/src/lifecycle/adapter.rs:768-779`。

## 会话、增量和生命周期

原生对话取受管 `$KIMI_CODE_HOME/sessions/.../session_<uuid>/agents/<agent>/wire.jsonl`，并以 `state.json` 验证 native session、cwd 和目录归属；原生 ID 只作来源，不覆盖可信 launch 主体。依据：`contracts/poc-01/kimi-transcript.md:3-25`；`edge/src/lifecycle/session_history.rs:60-120,190,522`。2.2.0 wire 1.5 的契约不是 2.3.0 所有记录都兼容的证明。

对 `agent.message.appended` 只取公开 user/assistant 消息；以 `context.append_loop_event` 的 `tool.call`、`tool.result` 配对工具；原始 call ID 加 native session 与 agent 域。忽略已识别的流片、context 重放和压缩快照，未知形状显式报缺口。按文件偏移读完整行，记录来源、原生时间、稳定事件 ID；截断与 ID 冲突不覆盖已收记录。事件、游标、outbox 同事务，重启/重传不重发模型请求；只有同一主体重新登录才可补传。模型观察单列用量，不从 prompt token 反推轮数。依据：同契约 `:25-49`。

运行前登记身份和私有 home，以 PTY 承载交互；独立心跳，不让控制 RPC 等待前台输出。实际退出以 daemon 持有的进程状态、退出码、清理结果为准，断管不自动重启。正常退出后同 cwd、正确历史锁且为纯聊天会话，可用 `--session <原生ID>` 续聊；旧会话存在保存任务时不自动恢复，避免重放有副作用的工作；清理未知或占用时不得显式续入。同 `edge/src/lifecycle/session_history.rs:303-309,325-378,500`；`docs/reports/c-si-bus-poc-20261025/windows-kimi-daemon-lost-20261027.md:7-21`。

## 已知故障与待验

- Windows 报 daemon 丢失时，后台后来仍有心跳且确认收尾；五秒心跳过期可能是前台 IPC 失败的后果，不证明 daemon 崩溃。要分别注入握手失败、请求帧已发后断开、前台输出慢，验证只在确定未发送时重试。见上述 Windows 故障报告 `:7-27`。
- 工具结果同时出现在 wire 的多个表示中，双采会虚增轮数。用公开合成形状的预期数（4 用户、3 助手、8 调用、8 结果）验收，另测合法多 session、部分行及不同 agent 复用 call ID。`contracts/poc-01/kimi-transcript.md:25-43`。
- 待测：分别冻结 Mac、Windows 2.3.0 SHA 及实际 native wire 版本；验项目发现、个人凭据隔离、令牌文件残留、超时和跨租约长跑。Kimi CLI 的回环适配不证明某一 Kimi Code Plan 上游允许企业子密钥发放，采购/认证需另验。本文未运行服务、Agent 或模型。


