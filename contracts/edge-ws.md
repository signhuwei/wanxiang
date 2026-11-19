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
| `secret` | `provider_id`、`ciphertext`、`nonce`、`key_id` | 加密的上游密钥。用设备注册时交换的 X25519 公钥加密（XChaCha20-Poly1305），只在内存解密 |
| `lease` | `lease_id`、`expires_at`、`budget_milli`、`seq` | 额度租约。Edge 在 `expires_at` 前或已用 80% 时发 `lease_renew` |
| `cutoff` | `reason`（`balance`、`disabled`、`contract`） | 立即断流：拒绝新请求，中断进行中的流 |
| `diag` | `diag_id`、`kind`（`logs`、`status`）、`upload_url` | 诊断指令。`logs` 打包日志上传到 `upload_url`（预签名 PUT）；`status` 直接回 `diag_result` |
| `agent_cmd` | `agent`、`action`（`stop`） | 管理指令 |

## Edge → Server

| type | 字段 | 作用 |
| --- | --- | --- |
| `events` | `batch[]`：`{seq, session_id, kind, at, payload}` | 会话事件回流。`seq` 每台设备单调递增、无空洞。Server 持久化后回 `events_ack{ack_seq}` |
| `usage` | `batch[]`：`{seq, request_id, session_id, lease_id, provider_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_milli, at, status, complete}` | 用量计量。与 events 共用 seq 空间。`status`：`ok`、`upstream_<HTTP 状态码>`、`upstream_error`、`client_cancelled`。`complete=false` 表示流中断、用量不全，cost 按已收到的部分计算，Server 记为待结算，不当作零 |
| `lease_renew` | `lease_id`、`used_milli` | 续租。Server 结算已用额度，签发新租约或回 `cutoff` |
| `diag_result` | `diag_id`、`ok`、`detail` | 诊断结果 |
| `agent_state` | `agent`、`session_id`、`state`（`started`、`exited`、`crashed`）、`exit_code` | Agent 生命周期 |

### 会话事件 kind

| kind | payload |
| --- | --- |
| `session_start` | `agent`、`agent_version`、`cwd_hash`、`model` |
| `user_message` | `content`（本轮新增的用户输入，不含重发的历史上下文） |
| `assistant_message` | `content`、`model`、`stop_reason` |
| `tool_call` | `tool`、`input` |
| `tool_result` | `tool_call_id`、`output`（超过 64 KB 截断，标 `truncated`） |
| `session_end` | `reason` |
| `gap` | `reason`、`offset`：采集缺口 |

会话事件来自 Agent 自己写的会话记录（Claude Code 是 `$CLAUDE_CONFIG_DIR/projects/<项目>/<session-id>.jsonl`），按字节偏移增量读取；不从模型请求里拼接对话。router 只负责用量、时延和错误。两者通过 `session_id` 关联。见 `docs/specs/agents/claude-code.md` 第 5 节（v0.4）。

- 事件带 `source_offset`（在会话文件中的字节偏移），读取游标、事件和 outbox 在一个本地事务里提交。
- 读到坏行、未知类型、文件被替换或截短时，发一条 `kind: "gap"` 事件，payload 为 `{reason, offset}`，不能把缺口显示为完整。
- thinking 内容、签名和凭据不回流。

## 确认与保留

- `events_ack{ack_seq}` 是累计确认：seq ≤ ack_seq 的全部 events 和 usage 都已持久化。它是应答类消息，可带 `re`，不要求。
- Edge 收到确认后不立即删除，保留已确认条目 72 小时（且总量不超过 200 MB，超出时先删最旧的）。
- 如果 `welcome.ack_seq` 小于本地已确认的最大 seq，说明 Server 丢了数据。Edge 从 `ack_seq + 1` 重传仍保留的条目，并发一条 `diag_result`（`diag_id` 为 `"ack_regression"`），带本地已确认的 seq 和能重传的范围，同时写警告日志。

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
- 每条 `usage` 带 `lease_id`。Server 对账时按 lease 汇总；没有 `lease_id` 的条目只标“待核对”，不重复扣款。
- 租约过期后，它的预留一直保留，直到 Edge 回连并报 `used_milli`。S1 不自动释放，以免离线用量超发。监察页列出超过 24 小时未回连的租约，由管理员人工处理（S2 再设计自动处理）。
