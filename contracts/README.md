# 契约 v0

2026-11-19 草案，S0 结束时冻结。只有总督能修改本目录；要改契约，经文件邮箱给总督（`governor`）发信说明理由。当前版本 v0.13（2026-11-20）。

| 文件 | 内容 |
| --- | --- |
| [edge-ws.md](edge-ws.md) | Edge 与 Server 之间的 WebSocket 协议 |
| [http-api.md](http-api.md) | Server HTTP API（管理端、Desktop 登录、Agent 调用共用） |
| [desktop-releases.md](desktop-releases.md) | S2 内测安装包发布与员工下载 |
| [data-model.md](data-model.md) | system 库和租户库的表 |
| [errors.md](errors.md) | 错误码 |

通用约定：

- ID 用带前缀的 ULID，例如 `ten_01J...`、`usr_`、`dev_`、`ses_`、`evt_`。
- 时间用 RFC 3339 UTC 字符串；时长用毫秒整数。
- 橡皮金额用整数，单位是“毫橡皮”（1 橡皮 = 1000），避免浮点误差。
- 所有写操作接受 `Idempotency-Key` 请求头（HTTP）或 `op_id` 字段（WS），重复提交返回第一次的结果。
- 所有对象带 `revision` 整数，更新时传入期望值，不一致返回 `conflict`。
