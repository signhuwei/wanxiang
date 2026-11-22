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
| `quota_exhausted` | 402 | 本人或所在组本月配额已用完（v0.12） |
| `lease_expired` | 402 | Edge 租约过期且无法续约 |
| `agent_not_allowed` | 403 | 合约不允许该 Agent |
| `model_not_allowed` | 403 | 合约不允许该模型 |
| `rate_limited` | 429 | 请求过快，`detail.retry_after_ms` |
| `upstream_error` | 502 | 上游 Provider 出错，`detail.upstream_status` |
| `internal` | 500 | 服务内部错误，带 `detail.trace_id` |
| `unsupported_capability` | 409 | 设备连接未协商所需能力（如 `route_pool.v1`），运维显示“需升级设备”。仅在 WS ack 中出现 |

## 设备投影与应用回执的原因值

隔离阶段的 `route_pool.v1` 会话（[设备目标与应用回执](routing-projection.md)）在 ack 的 `error.detail.reason` 和目标台账的 `reason` 中使用下列稳定码。

| 位置 | code | `detail.reason` | 含义 |
| --- | --- | --- | --- |
| `config_applied` 的 ack | `invalid` | — | 已协商会话收到缺键、多键或枚举不合法的回执，`detail.fields` 列出字段；不降级为旧协议确认 |
| `config_applied` 的 ack | `conflict` | `receipt_changed` | 同一回执 ID 的内容与已持久回执不同 |
| `config_applied` 的 ack | `conflict` | `unknown_target` | 认证设备没有该配置修订的持久目标（含其他设备的投影） |
| `config_applied` 的 ack | `conflict` | `projection_mismatch` | 修订存在，但投影 ID 不是持久目标的投影 |
| `config_applied` 的 ack | `conflict` | `policy_revision_mismatch` | 策略修订与持久目标不一致 |
| `config_applied` 的 ack | `forbidden` | `device_unavailable` | 设备、成员或租户已停用，回执不入库 |
| `lease_request`/`lease_renew` 的 ack | `forbidden` | `route_pool_lease_pending` | 隔离测试会话不发放也不续租旧租约 |
| hello、`lease_*`、`config_applied` 的 ack | `unsupported_capability` | `route_pool_required` | 设备已登记隔离投影但 hello 缺能力；同时下发 `cutoff{reason:"contract"}`，不走旧发租和旧配置 |

目标台账 `reason` 另含：`awaiting_receipt`（已发送、等待回执）、`not_projected`（名册已登记、目标尚未生成）、`device_offline`、`pool_superseded`（跟随目标已被更新池取代）、`unsupported_capability`，以及投影先决条件或重发复核的失败原因 `missing_route_credential`、`missing_sales_rate`、`sales_rate_outside_window`、`signature_changed`、`agent_release_unavailable`、`no_eligible_deployment`、`no_active_pool`、`pool_revision_missing`、`device_unavailable`、`target_expired`、`revocation_changed`、`authorization_changed`。设备拒绝时为脱敏的 `error.detail.reason`。先决条件失败和重发复核失败不算设备拒绝。

本机 router 拒绝 Agent 的模型请求时，按 Agent 所用协议的错误格式返回（Anthropic 用 `{"type":"error","error":{"type":"...","code":"<本表 code>","message":"..."}}`，`code` 是扩展字段，Anthropic 客户端会忽略），`message` 里写明原因和处理方法，例如“OneX 橡皮余额已用完，请联系管理员充值”。
