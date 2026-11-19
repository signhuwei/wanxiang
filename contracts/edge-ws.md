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

双方每 `heartbeat_ms` 发 `{"type":"ping","id":...}`，对方回 `pong`。连续 3 次没有回应就断开重连。Edge 重连用指数退避：1 s 起，上限 30 s，加 ±20% 随机抖动。

## Server → Edge

| type | 字段 | 作用 |
| --- | --- | --- |
| `config` | `revision`、`routes[]`、`agents[]`、`rates[]` | 全量配置。Edge 原子替换，回 ack；revision 不大于当前值时忽略 |
| `secret` | `provider_id`、`ciphertext`、`nonce`、`key_id` | 加密的上游密钥。用设备注册时交换的 X25519 公钥加密（XChaCha20-Poly1305），只在内存解密 |
| `lease` | `lease_id`、`expires_at`、`budget_milli`、`seq` | 额度租约。Edge 在 `expires_at` 前或已用 80% 时发 `lease_renew` |
| `cutoff` | `reason`（`balance`、`disabled`、`contract`） | 立即断流：拒绝新请求，中断进行中的流 |
| `diag` | `diag_id`、`kind`（`logs`、`status`）、`upload_url` | 诊断指令。`logs` 打包日志上传到 `upload_url`（预签名 PUT）；`status` 直接回 `diag_result` |
| `agent_cmd` | `agent`、`action`（`stop`） | 管理指令 |

## Edge → Server

| type | 字段 | 作用 |
| --- | --- | --- |
| `events` | `batch[]`：`{seq, session_id, kind, at, payload}` | 会话事件回流。`seq` 每台设备单调递增、无空洞。Server 持久化后回 `events_ack{ack_seq}` |
| `usage` | `batch[]`：`{seq, request_id, session_id, provider_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_milli, at, status}` | 用量计量。与 events 共用 seq 空间 |
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

Edge 通过比对同一会话前后两次请求的 `messages` 数组，只提取新增部分作为事件。具体规则在 Claude Code 适配规格确定后补充。

## 离线

- 断线期间 Edge 继续使用当前租约，直到 `expires_at` 或 `budget_milli` 用完，先到先停。
- 事件和用量写本地 outbox，重连后按 seq 补传。outbox 超过 500 MB 时停止接受新请求并提示。
- Server 侧租约默认 10 分钟、额度为“余额的 5% 与 2 橡皮中较小者”。具体数字由合约配置。
