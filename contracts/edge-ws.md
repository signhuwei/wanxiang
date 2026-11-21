# Edge ↔ Server WebSocket 协议 v0

模式化合约的 `hello` 协商、完整策略快照和 `config_applied` 见[能力合约 v2](capability-policy-v2.md#3-edge-设备协议)。

## 连接

- 地址：`wss://<server>/v1/edge/ws`。请求头 `Authorization: Bearer <device_token>`，`OneX-Edge-Version: <semver>`，`OneX-Protocol: 0`。
- `device_token` 在 Desktop 登录后由 `POST /v1/devices` 签发，存系统钥匙串。与用户会话令牌分开，有效期 30 天，滑动续期。
- 一台设备同时只能有一条连接。新连接建立后，Server 关闭旧连接（关闭码 4001 `replaced`）。
- 每条消息是一个 JSON 文本帧：`{"type": "...", "id": "<msg_id>", ...}`。需要应答的消息由对方回 `{"type": "ack", "re": "<msg_id>", "ok": true}` 或带 `error`（见 errors.md）。

## 握手

Edge 连上后第一条发 `hello`：

```json
{"type":"hello","id":"m1","edge_version":"0.1.0","os":"darwin","arch":"arm64",
 "config_revision":12,"lease_id":"lse_...","outbox_last_seq":4810}
```

Server 回 `welcome`：

```json
{"type":"welcome","re":"m1","device_id":"dev_...","user_id":"usr_...","tenant_id":"ten_...",
 "server_time":"2026-11-19T08:00:00Z","ack_seq":4790,"heartbeat_ms":15000}
```

`ack_seq` 是 Server 已持久化的最大回流序号，Edge 从 `ack_seq + 1` 开始补传。

## 心跳

双方每 `heartbeat_ms` 发 `{"type":"ping","id":"..."}`，对方回 `{"type":"pong","re":"<ping 的 id>"}`。应答类消息（`welcome`、`pong`、`ack`、`events_ack`）用 `re` 关联请求，不必带自己的 `id`。连续 3 次没有回应就断开重连。Edge 重连用指数退避：1 s 起，上限 30 s，加 ±20% 随机抖动。

## Server → Edge

v0.15 的 `config` 可携带平台合约和租户配置修订，字段和兼容规则见[能力合约接口](capability-contract.md#edge-下发)。

| type | 字段 | 作用 |
| --- | --- | --- |
| `config` | `revision`、`routes[]`、`agents[]`、`rates[]` | 全量配置。Edge 原子替换，回 ack；revision 不大于当前值时忽略。route 字段：`model`（精确名、`前缀*` 或 `*`，按精确、最长前缀、`*` 的顺序匹配）、`model_id`（对应 rates）、`provider_id`、`protocol`、`base_url`、`upstream_model?`、`auth`（`x_api_key` 或 `bearer`）、`proxy?`（见下方“网络代理”） |
| `secret` | `provider_id`、`ciphertext`、`nonce`、`key_id` | 加密的上游密钥，只在内存解密。算法见下方“密钥下发” |
| `lease` | `lease_id`、`expires_at`、`budget_milli`、`seq` | 额度租约。Edge 在 `expires_at` 前或已用 80% 时发 `lease_renew` |
| `cutoff` | `reason`（`balance`、`quota`、`disabled`、`contract`）、`settled_lease_id?` | 立即断流：拒绝新请求，中断进行中的流。带 `settled_lease_id` 表示该租约已在本次续租中结清（v0.13） |
| `diag` | `diag_id`、`kind`（`logs`、`status`）、`upload_url` | `logs` 将白名单日志打包，经当前控制连接同源的 `/v1/diag/:id/upload` 上传，使用该连接的设备令牌。`status` 直接回 `diag_result` |
| `agent_cmd` | `agent`、`action`（`stop`） | 管理指令 |

## Edge → Server

| type | 字段 | 作用 |
| --- | --- | --- |
| `events` | `batch[]`：`{seq, session_id, kind, at, payload}` | 会话事件回流。`seq` 每台设备单调递增、无空洞。Server 持久化后回 `events_ack{ack_seq}` |
| `usage` | `batch[]`：`{seq, request_id, session_id, lease_id, provider_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_milli, at, status, complete}` | 用量计量。与 events 共用 seq 空间。`status`：`ok`、`upstream_<HTTP 状态码>`、`upstream_error`、`client_cancelled`，以及 Edge 主动断流的 `lease_exhausted`、`lease_expired`、`cutoff`。条目带 `model_id`。`complete=false` 表示流中断、用量不全，cost 按已收到的部分计算，Server 记为待结算，不当作零 |
| `lease_renew` | `lease_id`、`used_milli`、`op_id` | 续租。`used_milli` 是该租约从签发起累计的绝对值（不是增量），Server 据此在租约上限内幂等扣款。签发新租约或回 `cutoff` |
| `diag_result` | `diag_id`、`ok`、`detail` | detail 可省略、为 null 或为序列化后最多 4096 个 UTF-8 字节的 JSON 对象。格式无效时回 invalid 并保留待处理状态；持久化时仅保留诊断字段白名单 |
| `lease_request` | `op_id` | 没有租约时申请新租约（v0.13）。Server 按签发规则回 `lease` 或 `cutoff`，不缓存结果，同一 `op_id` 可重发 |
| `agent_state` | `agent`、`session_id`、`state`（`started`、`exited`、`crashed`）、`exit_code` | Agent 生命周期 |

### 会话事件 kind

| kind | payload |
| --- | --- |
| `session_start` | `agent`、`agent_version`、`cwd_hash`、`model` |
| `user_message` | `content`（本轮新增的用户输入，不含重发的历史上下文） |
| `assistant_message` | `content`、`model`、`stop_reason` |
| `system_message` | `content`。Agent 原生记录明确标为用户可见的系统提示，不计用户轮次 |
| `tool_call` | `tool_call_id`、`tool`、`input` |
| `tool_result` | `tool_call_id`、`output`（超过 64 KB 截断，标 `truncated`） |
| `session_end` | `reason` |
| `gap` | `reason`、`offset`：采集缺口 |
| `compact` | `summary`：上下文压缩产生的摘要，不是用户输入，也不是模型回答 |

所有会话事件的 payload 另带原始行的 `uuid`、`parentUuid`，以及 `sidechain`（布尔）和 `agent_id`（子 Agent 的标识，主会话为 null）。图片只回元数据 `{type:"image", media_type, bytes}`，不回原图（S1）。

会话事件来自 Agent 自己写的会话记录（Claude Code 是 `$CLAUDE_CONFIG_DIR/projects/<项目>/<session-id>.jsonl`），按字节偏移增量读取；不从模型请求里拼接对话。router 只负责用量、时延和错误。两者通过 `session_id` 关联。见 `docs/specs/agents/claude-code.md` 第 5 节（v0.4）。

- `at` 使用原生时间。原生记录没有有效时间或事件由 Edge 生成时，使用 Edge 记录事件的 UTC 时间。旧版本已排队、缺少 `at` 的待传记录在升级时补时间，原有序号和游标保持不变。
- 事件带 `source_offset`（在会话文件中的字节偏移），读取游标、事件和 outbox 在一个本地事务里提交。
- 读到坏行、未知类型、文件被替换或截短时，发一条 `kind: "gap"` 事件，payload 为 `{reason, offset}`，不能把缺口显示为完整。
- 一个 `session_id` 只属于第一次上报它的那台设备。其他设备用同一个 `session_id` 上报，Server 拒绝整批（`conflict`）并记日志，不记正文。员工换电脑后 resume 会产生新的会话。
- thinking 内容、签名和凭据不回流。会话文件中的 `api-request`、`api-request-blob` 行含完整模型请求，也不回流。

## 密钥下发（v0.7）

- 设备注册时提交 32 字节 X25519 公钥（标准 base64）。没有公钥的设备不下发 secret。
- 每条 `secret` 由 Server 新生成一对临时 X25519 密钥。`key_id` 是临时公钥（32 字节，标准 base64）。
- 共享密钥经 HKDF-SHA256 派生：不加 salt，info 为 UTF-8 的 `onex-edge-secret-v1`，输出 32 字节。
- 用 XChaCha20-Poly1305 加密，`nonce` 为 24 字节；AAD 为 UTF-8 的 `provider_id`；`ciphertext` 是密文后接 16 字节 tag。所有二进制字段都用标准 base64。
- 只下发当前合约允许的模型所用的 Provider。

## 确认与保留

- `events_ack{ack_seq}` 是累计确认：seq ≤ ack_seq 的全部 events 和 usage 都已持久化。它是应答类消息，可带 `re`，不要求。
- Edge 收到确认后不立即删除，保留已确认条目 72 小时（且总量不超过 200 MB，超出时先删最旧的）。
- 如果 `welcome.ack_seq` 小于本地已确认的最大 seq，说明 Server 丢了数据。Edge 从 `ack_seq + 1` 重传仍保留的条目，并发一条 `diag_result`（`diag_id` 为 `"ack_regression"`），带本地已确认的 seq 和能重传的范围，同时写警告日志。

## OpenAI Chat 路由（v0.10）

- `protocol: "openai_chat"` 的路由由 Edge 把 Anthropic Messages 转成 OpenAI Chat。`base_url` 以 `/v1` 结尾时直接接 `/chat/completions`，否则先补 `/v1`。
- 用量按 OpenAI 口径：`prompt_tokens` 包含缓存，`input_tokens = prompt_tokens − cached_tokens − cache_write_tokens`；`reasoning_tokens` 是 `completion_tokens` 的子集，只作明细，不重复计费。
- Provider 以后可以声明 `usage_semantics` 覆盖口径，S1 不实现。

## 网络代理

Edge 连 Server 和上游时，默认使用环境变量中的代理设置（`HTTPS_PROXY`、`NO_PROXY`）。访问 `127.0.0.1` 和 `localhost` 一律不走代理。route 的 `proxy` 字段可以覆盖：`"none"` 表示直连，URL 表示指定代理。企业员工的电脑上常有公司代理，所以默认遵从代理。

## 离线

- 断线期间 Edge 继续使用当前租约，直到 `expires_at` 或 `budget_milli` 用完，先到先停。
- 事件和用量写本地 outbox，重连后按 seq 补传。outbox 超过 500 MB 时停止接受新请求并提示。
- Server 侧租约默认 10 分钟，额度取余额的 5% 与 2 块橡皮中的较小值，按毫橡皮向下取整，最低为 0.001 块橡皮（1 毫橡皮）。具体数字由合约配置，始终不超过可用余额。

## 租约生命周期（v0.5）

- `hello` 不带 `lease_id`，且租户有可用余额时，Server 在 `welcome` 之后发初始 `lease`。
- `hello` 带 `lease_id` 时，Server 不在握手时自动结算，等 Edge 发 `lease_renew` 报 `used_milli`。
- `lease_renew` 带 `op_id`（缺省时用消息 `id`），重复的 `op_id` 返回第一次的结果，不重复扣款。
- 每条 `usage` 带 `lease_id`，记的是放行这次请求时的租约。没有 `lease_id` 的条目只标“待核对”，不重复扣款。
- **续租用量快照是 `lease_renew.used_milli`**，租户扣款取实报与 `budget_milli` 的较小值。实报超过额度时，Server 在同一事务里按上限结清旧租约、单列差额待核对，并按剩余余额签发新租约或返回 `cutoff`。重放同一 `op_id` 返回原结果，沿用原始快照，扣款和差额各只入账一次。
- 超租约差额不转入下一份租约。新租约确认旧续租快照已处理，Edge 从本地累计用量中移除完整原始快照，只把快照后产生的实际用量计入新租约。
- `usage.cost_milli` 保留真实用量，跨租约的请求仍引用放行时的租约。Server 按设备比较实际用量与已结算金额，有差额时保留待结算状态。独立的待核对流水关联旧租约及续租操作。
- 租约过期后，它的预留一直保留，直到 Edge 回连并报 `used_milli`。S1 不自动释放，以免离线用量超发。监察页列出超过 24 小时未回连的租约，由管理员人工处理（S2 再设计自动处理）。

## 多 Agent 接入（v0.12，S2）

- `agent` 取值：`claude-code`、`codex`、`kimi-code`。合约 `allowed_agents` 与 `agent_releases.agent` 用同一组名字。
- 本机 router 按入口协议选路，共用租约、计价和 usage 上报。受管启动签发的本机令牌只能用于其 Agent 的协议入口。
  - `POST /v1/messages`：Claude Code 和 Kimi Code 使用。可选上游为 `anthropic` 和 `openai_chat`。`POST /v1/messages/count_tokens` 沿用 Messages 的选路结果，仅在该路由为 `anthropic` 时透传。
  - `POST /v1/responses`：Codex 使用。平台可下发 `openai_responses` 原生路由和 `openai_chat` 转换路由。只有不兼容的匹配路由时返回 `model_not_allowed`。
- 启动时只接受 Agent 协议支持的模型，默认从兼容路由的精确别名和可匹配的通配候选中依序选择。请求先筛兼容上游，再按精确名、最长前缀、`*` 的优先级匹配。匹配精度相同时优先同协议上游。
- Responses 用量口径：`input_tokens` 含缓存，计费输入 = `input_tokens − input_tokens_details.cached_tokens`；`output_tokens_details.reasoning_tokens` 是输出的子集，只作明细。
- 拒绝时按入口协议返回错误：Messages 用 Anthropic 错误体；Responses 未发响应头时用 `{"error":{"type","code","message"}}`，已发头时写 `response.failed` 事件。`code` 取 `errors.md`。
- 会话事件的 `kind` 和 payload 不变，`session_start.agent` 写实际 Agent 名。采集来源：
  - Codex：受管 `CODEX_HOME/sessions/**/rollout-*.jsonl`，只取 `response_item` 的 user/assistant 可见文本与 function/custom 调用及结果；`event_msg` 与 `compacted` 不生成发言（压缩生成 `compact`）。原生 thread id 只作来源标识。
  - Kimi Code：受管 `KIMI_CODE_HOME/sessions/**/agents/<agent>/wire.jsonl`，取 `agent.message.appended` 的公开消息与 `context.append_loop_event` 的 `tool.call`/`tool.result`；子 agent 写 `agent_id`。
  - 未知记录形状一律生成 `gap`，不猜测。细节见 `docs/specs/agents/codex.md`、`docs/specs/agents/kimi-code.md`。

## 断流后的恢复（v0.13）

S1 起存在的缺陷：续租回 `cutoff` 后，Edge 保留旧租约并重放同一 `op_id`，Server 返回缓存的 `cutoff`，充值、调高配额或跨月后都无法恢复。改为：

- Server 对 `lease_renew` 的回复如果是 `cutoff`，且旧租约已在这次操作中结清，`cutoff` 带 `settled_lease_id`。`lease_operations` 照常缓存这份回复，重放同一 `op_id` 仍返回它（含 `settled_lease_id`）。`disabled` 在结清前判定，不带该字段。
- Edge 收到带 `settled_lease_id` 且等于当前租约的 `cutoff`：在同一次落盘中删除当前租约和续租快照，累计用量减去快照的 `used_milli`（与 v0.5 收到新租约时一致，不清零），保留 `cutoff` 原因。快照之后结束的请求、被 cutoff 中断后才释放的流，花费继续累加在这份“无租约用量”里，拿到新租约后整体带入新租约。之后 `hello` 不再带 `lease_id`。
- 处于 `cutoff` 且**没有待发或待回的续租**的 Edge（无论是否还持有租约），在每次连上后和每隔 60 秒（加 ±20% 抖动）发一次 `lease_request`；`onex run` 启动 Agent 时也立即发一次。收到新租约即解除 `cutoff`；收到与当前相同的租约（Server 回已有 active 租约）走“重申”分支，只解除 `cutoff`、不结算。持有租约且 `used_milli > 0` 时，先按 v0.5 发续租结清，续租有了结果之后才轮到 `lease_request`。
- Server 处理 `lease_request`：设备不可用回 `cutoff{disabled}`；已有 active 租约直接回该租约；否则按签发规则回 `lease` 或 `cutoff`。不写 `lease_operations`。
- 不带 `settled_lease_id` 的 `cutoff`（例如 `disabled`、或 Server 主动推送）：旧租约和快照保留，恢复后重放续租结清；没有用量要结清时由上一条的 `lease_request` 恢复。

### 断流原因优先级

签发或续租时依次判断，取第一个命中的：`disabled` > `contract` > `balance` > `quota`。

## 多 Agent 接入补充（v0.13）

- **OneX session_id**：`session_id` = UUID v5（命名空间为设备 ID 的 UUID v5，名字为 `<agent>:<原生会话 ID>`）。同一原生会话无论第几次启动（Codex `resume`、Kimi `--session`）都得到同一个 `session_id`，只发一次 `session_start`。采集游标按原生会话文件持久保存在设备本地，续接时从旧游标往后读，不重报旧内容。原生会话 ID 未知前产生的模型请求，usage 的 `session_id` 用本次启动的 launch 级 UUID；拿到原生 ID 后，后续 usage 用该会话的 `session_id`。
- **费用归属**：一次启动里出现多个原生会话时，router 无法区分请求属于哪个会话，usage 记在该次启动最近活跃的原生会话上。S2 接受这个近似，监察页的会话费用以此为准。
- **payload 公共字段**：`uuid` 取原生记录 ID，没有就填 null；`parentUuid` 同理；`sidechain` 只有子 Agent 为 true；`agent_id` 主会话为 null，子 Agent 填原生子 Agent 名或 ID。Kimi 主 agent 的 `agent_id` 为 null。
- **系统注入不算发言**：Codex 的 `developer` 消息、`environment_context`、`user_instructions` 等注入，Kimi 的同类注入，不生成 `user_message`，不计入 `turn_count`。
- **已知忽略清单**：各采集器在代码里显式列出已识别、无需上报的记录类型（如 Codex `session_meta`、`turn_context`、`reasoning`，Kimi 流式分片和 context 重放），列表内的跳过且不生成 `gap`，列表外的未知类型生成 `gap`。清单要有测试。
- **压缩**：能读到压缩摘要时生成 `compact`；读不到摘要只知道发生过压缩时，生成 `compact` 且 `summary` 为 null。

### Responses 入口补充

- **预留**：有 `max_output_tokens` 时按它计输出；没有时按 4096 输出 token 预留，但不超过当前租约剩余额度（取较小值，最低 1 个 token），不因缺省值报 TooLarge。估算输入照旧。Responses 入口的 TooLarge 文案不提 max_tokens，写“这次请求预估花费超过单个额度租约的上限，请缩短上下文或联系管理员调高租约额度”。
- **错误**：未发响应头时，HTTP 状态按 `errors.md`，响应体 `{"error":{"type":"<kind>","code":"<errors.md code>","message":"..."}}`，`kind` 与 Anthropic 错误体同一组取值（`billing_error`、`permission_error`、`invalid_request_error`、`api_error`）。已发头时写一条 `response.failed` 事件（`response.status = "failed"`，`response.error = {code, message}`），然后结束流，不再发 `response.completed`。
- **字段处理**：同协议转发时原样透传 `previous_response_id`、`store`、`include`、`reasoning` 等字段。转 Chat 时：带 `previous_response_id` 的请求返回 `invalid` 并说明需要关闭服务端会话存储；`reasoning` 输入项丢弃；`include` 忽略；`store` 不转发。受管 Codex 的本机令牌固定使用 `store=false`，由 Edge 在原生 Responses 转发时落实。
- **计量**：与 `/v1/messages` 共用同一套实时计量（router 的 Meter）：放行前按预留检查租约，流式期间按已收到的输出增量估算花费并检查租约，超额时中断。流中断（取消、cutoff、上游断开）或缺 usage 时，按已收到的部分计价，`complete=false`。
- **转 Chat 的工具与条目**（v0.13）：`function` 工具照转；`custom` 工具（如 `apply_patch`）转成一个只有字符串参数 `input` 的 function，回传时还原成 `custom_tool_call`；`local_shell` 转成参数为 `{command: string[], workdir?, timeout_ms?}` 的 function，回传还原成 `local_shell_call`；`web_search` 等托管工具从请求中去掉（onexd 生成的 Codex 配置已禁用它们）。input 里的 `custom_tool_call`、`local_shell_call` 及其 output 按同样映射转成 tool_calls 和 tool 消息；`reasoning` 丢弃；`instructions` 和 `input` 内 `developer`、`system` 的文本按原顺序合并为首条 `system` 消息，其他对话和工具项沿用原顺序。同一轮的多个调用合并进一条 assistant 消息的 `tool_calls`。Codex 的 `namespace` 定义展开为唯一的 Chat 工具名，回传时恢复原始 `namespace` 和工具名。
- **转 Chat 的输出条目**：`response.output_item.done` 和 `response.completed.output` 必须带完整条目：message 条目有 `id`、`role:"assistant"`、`content:[{type:"output_text",text}]`；function 条目有 `id`、`call_id`、`name`、`arguments`。同一条目在 added 和 done 里的 `id` 一致。缺 call_id 时生成稳定 ID，不留空串。
- **同协议转发**：URL 拼接规则同 Chat（`base_url` 以 `/v1` 结尾时直接接 `/responses`）。只转发白名单请求头（`content-type`、`accept`、`openai-beta`、`user-agent`），认证头换成上游密钥。
- **仅匹配到 anthropic 上游**：返回 `model_not_allowed`，`message` 写明“该模型的上游协议暂不支持 Codex，请联系管理员调整路由”。

### 桌面 Agent 的 Chat Completions 入口

- `POST /v1/chat/completions` 校验受管桌面 Agent 专用本机 Bearer。关联会话以 daemon 签发时的绑定为准。仅允许合约生效的 `openai_chat` 路由，认证头由 daemon 按渠道重建。
- 支持单候选的 JSON 和 SSE，保留工具调用 ID、参数和原始输出帧。流式要求上游返回 usage，且由 `[DONE]` 结束；异常时返回 Chat 错误并结束流。共用租约预留、实时中断和用量结算。
- 平台暂存的完整安装包须先通过对应版本和操作系统的原生运行验证，之后才可进入 Edge 的可启动发行目录。

## Server 缓存制品（v0.14）

- 支持新缓存协议的 Edge 在 `hello` 加 `agent_cache: true`。Server 在对应 `config` 回传 `agent_cache: true`，且 `agents` 仅带当前设备平台、架构及能力合约允许的已缓存启用发行。
- 缓存协议的 `agents[].url` 是 `/v1/edge/agent-artifacts/<release_id>`。Edge 使用当前连接的 OneX Server 作为下载服务器，沿用同一协议、主机和端口，携带设备 Bearer，拒绝重定向。落入本机缓存前核对原始字节数及 SHA-256。缓存协议启用时，IPC 拒绝调用方指定的非受管可执行文件。
- 合约固定发行时只下发该发行的原始身份。停用、缺失缓存或换摘要的固定条目失效，不能自动改用同 Agent 的其他版本。
- 无固定发行的设备平台上，不带能力位的旧 Edge 继续收到登记的厂商地址。固定发行的平台要求新版 Edge，旧 Edge 收到空配置和 `cutoff{contract}`。旧 Server 可忽略新 `hello` 字段。


### 原生桌面发行协商

Apple Silicon Edge 在 hello 中声明 `agent_cache: true` 与 `mac_desktop_v1: true`。支持 Claude Desktop 或 Codex Desktop 的 Edge 另行声明相应的 `claude_desktop_v1: true` 或 `codex_desktop_v1: true`。缺少对应能力位时该发行从配置中省略。Server 同时核对设备注册平台、受管缓存、成员有效合约及精确发行资格。Edge 在私有目录验证完整 DMG、Apple 签名、bundle 标识与代码摘要后启动原厂窗口。桌面通过既有下载与启动 IPC 展示准备、下载、验证、启动和运行状态。

原厂 DeepSeek Cordis 适配器使用 `POST /v1/onex/desktop/ready` 标记本机适配器就绪。每次模型请求由 `POST /v1/onex/desktop/session` 携带本次私有启动凭据以及 `{native_id,bind_model:true,records:[]}` 换取有效期 60 秒、单次使用的会话模型凭据。适配器先按原生历史头核对工作区、真实 SID 及来源。上传公开记录时传 `bind_model:false`，以原生序号推进游标。上游计量与原生消息使用同一 OneX 会话编号，撤销启动立即丢弃其待用凭据。

WorkBuddy 的待验适配器为每次启动签发两个独立的本机凭据。受管 Hook 核对工作区、任务 SID 和厂商轮次号后，用控制端 Bearer 调用 `POST /v1/onex/workbuddy/turn` 提交 `{native_id,generation_id,event}`。`UserPromptSubmit` 登记映射，`Stop` 关闭映射。模型端携带独立凭据（Bearer 或厂商原生 `x-api-key`）和唯一的 `X-Conversation-Request-ID` 调用 Chat。一个已登记轮次可以有多笔模型请求，每笔费用归到对应原生会话。缺少映射、轮次归属冲突、头重复、轮次结束或设备退出时拒绝调用。原厂 `custom-local:` 模型名前缀在检查合约前还原。上游只接收路由指定的认证。该候选的真实桌面验收和启用状态以精确发行清单为准。

Codex Desktop 使用公开 App Server 的 thread 和 turn ID。私有启动控制端将 `{session:{thread_id,turn_id},started}` POST 到 `/v1/onex/desktop/codex-turn`。原生 Responses 请求携带模型凭据和 `x-codex-turn-metadata`，注册映射、真实线程 ID、轮次 ID 和本次分配的模型须一致。冷恢复使用同一原生 thread 派生 OneX 会话编号。归属冲突或发行从合约中移除时，请求在占用租约前被拒绝。

Claude Desktop Code 使用 3P gateway 的凭据助手与 Messages 接口。Edge 交叉核对请求中原生 `session_id`、受管工作区内原生 transcript 的首条完整用户记录和分配模型，之后将可见对话和用量归到同一 OneX 会话。退出时撤销窗口和任务凭据。重开后只能由新窗口以匹配的原生证据接续。模型、原生会话或发行不满足生效合约时，拒绝转发。
