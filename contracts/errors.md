# 错误码 v0

HTTP 和 WS 共用。HTTP 返回 `{"error": {"code": "...", "message": "...", "detail": {...}}}`；WS 在 ack 里带同样的 `error` 对象。`message` 写给人看（中文），`code` 给程序判断。

| code | HTTP | 含义 |
| --- | --- | --- |
| `unauthenticated` | 401 | 令牌缺失、过期或被吊销 |
| `forbidden` | 403 | 身份有效，但没有这个操作或这个对象的权限 |
| `not_found` | 404 | 对象不存在，或调用者无权知道它存在 |
| `conflict` | 409 | `revision` 不一致 |
| `too_large` | 413 | 上传内容超出大小上限 |
| `invalid` | 422 | 参数校验失败，`detail.fields` 列出字段 |
| `seat_limit` | 403 | 租户人数已达合约上限 |
| `balance_exhausted` | 402 | 橡皮余额不足 |
| `lease_expired` | 402 | Edge 租约过期且无法续约 |
| `agent_not_allowed` | 403 | 合约不允许该 Agent |
| `model_not_allowed` | 403 | 合约不允许该模型 |
| `rate_limited` | 429 | 请求过快，`detail.retry_after_ms` |
| `upstream_error` | 502 | 上游 Provider 出错，`detail.upstream_status` |
| `internal` | 500 | 服务内部错误，带 `detail.trace_id` |

本机 router 拒绝 Agent 的模型请求时，按 Agent 所用协议的错误格式返回（Anthropic 用 `{"type":"error","error":{"type":"...","code":"<本表 code>","message":"..."}}`，`code` 是扩展字段，Anthropic 客户端会忽略），`message` 里写明原因和处理方法，例如“OneX 橡皮余额已用完，请联系管理员充值”。
