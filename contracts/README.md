# 契约 v0

2026-11-19 草案，S0 结束时冻结。只有总督能修改本目录；要改契约，经文件邮箱给总督（`governor`）发信说明理由。当前版本 v0.15（2026-11-21）。

| 文件 | 内容 |
| --- | --- |
| [edge-ws.md](edge-ws.md) | Edge 与 Server 之间的 WebSocket 协议 |
| [http-api.md](http-api.md) | Server HTTP API（管理端、Desktop 登录、Agent 调用共用） |
| [desktop-releases.md](desktop-releases.md) | S2 内测安装包发布与员工下载 |
| [data-model.md](data-model.md) | system 库和租户库的表 |
| [capability-policy-v2.md](capability-policy-v2.md) | 模式化能力条目、签发流程、充值凭证及设备应用确认 |
| [capability-contract.md](capability-contract.md) | 平台合约、租户配置、有效投影和下发 |
| [errors.md](errors.md) | 错误码 |

通用约定：

- ID 用带前缀的 ULID，例如 `ten_01J...`、`usr_`、`dev_`、`ses_`、`evt_`。
- 时间用 RFC 3339 UTC 字符串；时长用毫秒整数。
- 橡皮是平台交易的计价代币，以“块”为单位，数量可以是小数。当前 1 块橡皮对应人民币 1 元。平台用橡皮为服务标价，便于交易和后续调价。界面录入与展示的余额、配额、用量和费用均以块为单位，例如 0.5 块橡皮。
- 账本和协议中的 `*_milli` 字段以整数记录毫橡皮，1 块橡皮 = 1,000 毫橡皮。费率字段 `*_milli_per_mtok` 以毫橡皮/百万 token 为单位，例如每百万 token 0.5 块橡皮对应字段值 500。
- 所有写操作接受 `Idempotency-Key` 请求头（HTTP）或 `op_id` 字段（WS），重复提交返回第一次的结果。
- 所有对象带 `revision` 整数，更新时传入期望值，不一致返回 `conflict`。
