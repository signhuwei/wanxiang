# Edge ↔ Server WebSocket 协议 v0

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
| `diag_result` | `diag_id`、`ok`、`detail` | 诊断结果 |
| `lease_request` | `op_id` | 没有租约时申请新租约（v0.13）。Server 按签发规则回 `lease` 或 `cutoff`，不缓存结果，同一 `op_id` 可重发 |
| `agent_state` | `agent`、`session_id`、`state`（`started`、`exited`、`crashed`）、`exit_code` | Agent 生命周期 |

### 会话事件 kind

| kind | payload |
| --- | --- |
| `session_start` | `agent`、`agent_version`、`cwd_hash`、`model` |
| `user_message` | `content`（本轮新增的用户输入，不含重发的历史上下文） |
| `assistant_message` | `content`、`model`、`stop_reason` |
| `tool_call` | `tool_call_id`、`tool`、`input` |
| `tool_result` | `tool_call_id`、`output`（超过 64 KB 截断，标 `truncated`） |
| `session_end` | `reason` |
| `gap` | `reason`、`offset`：采集缺口 |
| `compact` | `summary`：上下文压缩产生的摘要，不是用户输入，也不是模型回答 |

所有会话事件的 payload 另带原始行的 `uuid`、`parentUuid`，以及 `sidechain`（布尔）和 `agent_id`（子 Agent 的标识，主会话为 null）。图片只回元数据 `{type:"image", media_type, bytes}`，不回原图（S1）。

会话事件来自 Agent 自己写的会话记录（Claude Code 是 `$CLAUDE_CONFIG_DIR/projects/<项目>/<session-id>.jsonl`），按字节偏移增量读取；不从模型请求里拼接对话。router 只负责用量、时延和错误。两者通过 `session_id` 关联。见 `docs/specs/agents/claude-code.md` 第 5 节（v0.4）。

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
- Server 侧租约默认 10 分钟、额度为“余额的 5% 与 2 橡皮中较小者”（向下取整，最低 1 毫橡皮）。具体数字由合约配置，始终不超过可用余额。

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
- 本机 router 入口按 Agent 协议区分，共用同一个本机令牌、租约、计价和 usage 上报：
  - `POST /v1/messages`（及 `/v1/messages/count_tokens`）：Anthropic Messages，Claude Code 与 Kimi Code 使用。
  - `POST /v1/responses`：OpenAI Responses，Codex 使用。上游 route 为 `openai_responses` 时同协议转发；为 `openai_chat` 时由 Edge 转换为 Chat；为 `anthropic` 时 S2 首批返回 `model_not_allowed`，不做 Responses→Messages。
- Responses 用量口径：`input_tokens` 含缓存，计费输入 = `input_tokens − input_tokens_details.cached_tokens`；`output_tokens_details.reasoning_tokens` 是输出的子集，只作明细。
- 拒绝时按入口协议返回错误：Messages 用 Anthropic 错误体；Responses 未发响应头时用 `{"error":{"type","code","message"}}`，已发头时写 `response.failed` 事件。`code` 取 `errors.md`。
- 会话事件的 `kind` 和 payload 不变，`session_start.agent` 写实际 Agent 名。采集来源：
  - Codex：受管 `CODEX_HOME/sessions/**/rollout-*.jsonl`，只取 `response_item` 的 user/assistant 可见文本与 function/custom 调用及结果；`event_msg` 与 `compacted` 不生成发言（压缩生成 `compact`）。原生 thread id 只作来源标识。
  - Kimi Code：受管 `KIMI_CODE_HOME/sessions/**/agents/<agent>/wire.jsonl`，取 `agent.message.appended` 的公开消息与 `context.append_loop_event` 的 `tool.call`/`tool.result`；子 agent 写 `agent_id`。
  - 未知记录形状一律生成 `gap`，不猜测。细节见 `docs/specs/agents/codex.md`、`docs/specs/agents/kimi-code.md`。

## 断流后的恢复（v0.13）

S1 起存在的缺陷：续租回 `cutoff` 后，Edge 保留旧租约并重放同一 `op_id`，Server 返回缓存的 `cutoff`，充值、调高配额或跨月后都无法恢复。改为：

- Server 对 `lease_renew` 的回复如果是 `cutoff`，且旧租约已在这次操作中结清，`cutoff` 带 `settled_lease_id`。`lease_operations` 照常缓存这份回复，重放同一 `op_id` 仍返回它（含 `settled_lease_id`）。`disabled` 在结清前判定，不带该字段。
- Edge 收到带 `settled_lease_id` 且等于当前租约的 `cutoff`：在同一次落盘中删除当前租约、累计用量和续租快照，保留 `cutoff` 原因。之后 `hello` 不再带 `lease_id`。
- 处于 `cutoff` 且没有租约的 Edge，在每次连上后和每隔 60 秒（加 ±20% 抖动）发一次 `lease_request`；`onex run` 启动 Agent 时也立即发一次。收到 `lease` 即解除 `cutoff`。
- Server 处理 `lease_request`：设备不可用回 `cutoff{disabled}`；已有 active 租约直接回该租约；否则按签发规则回 `lease` 或 `cutoff`。不写 `lease_operations`。
- 不带 `settled_lease_id` 的 `cutoff`（例如 `disabled`、或 Server 主动推送）保持 v0.5 行为：旧租约和快照保留，恢复后重放续租结清。

### 断流原因优先级

签发或续租时依次判断，取第一个命中的：`disabled` > `contract` > `balance` > `quota`。

## 多 Agent 接入补充（v0.13）

- **OneX session_id**：每次受管启动由 onexd 生成一个 UUID，作为该次启动第一个原生会话（Codex thread、Kimi session）的 `session_id`。同一次启动里出现的其他原生会话，`session_id` 取 UUID v5（命名空间为首个 `session_id`，名字为原生 ID），各自先发 `session_start`。router 的本机令牌绑定启动；usage 的 `session_id` 用首个 `session_id`。
- **payload 公共字段**：`uuid` 取原生记录 ID，没有就填 null；`parentUuid` 同理；`sidechain` 只有子 Agent 为 true；`agent_id` 主会话为 null，子 Agent 填原生子 Agent 名或 ID。Kimi 主 agent 的 `agent_id` 为 null。
- **系统注入不算发言**：Codex 的 `developer` 消息、`environment_context`、`user_instructions` 等注入，Kimi 的同类注入，不生成 `user_message`，不计入 `turn_count`。
- **已知忽略清单**：各采集器在代码里显式列出已识别、无需上报的记录类型（如 Codex `session_meta`、`turn_context`、`reasoning`，Kimi 流式分片和 context 重放），列表内的跳过且不生成 `gap`，列表外的未知类型生成 `gap`。清单要有测试。
- **压缩**：能读到压缩摘要时生成 `compact`；读不到摘要只知道发生过压缩时，生成 `compact` 且 `summary` 为 null。

### Responses 入口补充

- **预留**：有 `max_output_tokens` 时按它计输出；没有时按 4096 输出 token 预留。估算输入照旧。
- **错误**：未发响应头时，HTTP 状态按 `errors.md`，响应体 `{"error":{"type":"<kind>","code":"<errors.md code>","message":"..."}}`，`kind` 与 Anthropic 错误体同一组取值（`billing_error`、`permission_error`、`invalid_request_error`、`api_error`）。已发头时写一条 `response.failed` 事件（`response.status = "failed"`，`response.error = {code, message}`），然后结束流，不再发 `response.completed`。
- **字段处理**：同协议转发时原样透传 `previous_response_id`、`store`、`include`、`reasoning` 等字段。转 Chat 时：带 `previous_response_id` 的请求返回 `invalid` 并说明需要关闭服务端会话存储；`reasoning` 输入项丢弃；`include` 忽略；`store` 不转发。onexd 生成的 Codex 配置固定关闭服务端存储。
- **anthropic 上游**：返回 `model_not_allowed`，`message` 写明“该模型的上游协议暂不支持 Codex，请联系管理员调整路由”。
