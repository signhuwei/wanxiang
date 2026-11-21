# 能力合约数据与接口 v1

本版交付平台签发、租户收窄、有效配置下发与存量确认。业务设计见[模块功能设计](../docs/design/capability-contract-modules.md)。

## 数据和权限

| 数据 | 位置和键 | 写入方 |
| --- | --- | --- |
| 条款定义 | Server 内置类型和作用域，本版的条款见下表 | 随服务端版本维护 |
| 合约模板 | `system.sqlite.contract_templates`，`(id, version)`，保存名称、完整权益 JSON、发布人和发布时间 | 平台管理员发布不可变版本 |
| 平台合约 | 租户库 `platform_contracts`，`revision`，保存模板 ID/版本、完整签发权益、经办人、原因及生效时间 | 平台管理员，使用全局会话 |
| 租户配置 | 租户库 `tenant_configurations`，`revision`，保存收窄选择、所基于的平台修订、操作者及时间 | 租户户主，使用该租户会话 |
| 有效投影 | 租户库 `contract`，保留现有字段与独立递增的 `revision`，追加 `platform_revision`、`tenant_revision` 和 `quota_distribution` | 从上述两层派生 |

平台合约和租户配置按版本追加，发布即生效。平台、租户和投影修订均独立，旧租户以平台修订 0 表示待确认，租户修订 0 表示尚未写入配置。写入和审计在同一租户库事务内完成，提交后通知在线设备，重连也读取最新投影。

| 权益字段 | 模板及平台合约 | 租户配置 |
| --- | --- | --- |
| `seat_limit` | 非负安全整数 | 平台专属 |
| `allowed_agents`、`allowed_models` | Agent 类型和平台模型 ID 列表 | 权益子集，空数组关闭全部 |
| `lease_minutes`、`lease_budget_milli` | 时长 1–1440 分钟，额度为非负整数毫橡皮 | 可降低，额度 0 禁用模型执行 |
| `visibility` | `{admin:{summary,content},group_admin:{summary,content}}` 布尔上限 | 可关闭获准项，按逐项 AND 派生，户主及组管范围仍依现行规则 |
| `quota_distribution` | 允许设置组和成员配额的布尔开关 | 平台专属，关闭时暂停已有分配的执行，而历史值保留 |
| `agent_release_ids` | 候选范围由所授 Agent 和现行发行目录确定 | 可为每个 Agent、系统、架构固定一项，须匹配当前有效 Agent |

平台合约带 `template_id`、`template_version`。签发用模板权益作为默认值，平台可按采购约定明确覆盖其中一项或多项。发布新模板版本不自动改变已签合约。首版用平台目录在指定时间生效的费率，保持交易代币现有计价约定。自有上游、主备路由、低余额兜底、差异定价、续充收款、定时签发和组/成员模型条款由后续执行契约引入。

租户配置 `configuration` 是整份选择，缺省字段（或 `null`）表示继承，`[]` 是显式空列表。监察可见性的四个布尔值可独立继承。平台收紧时裁剪被收回的显式选择并保留旧版历史，重新授权后须由户主确认才能恢复显式选择。当实体目录临时下线时保留选择，实际生效的模型、发行和密钥仍须通过现有目录与兼容校验。既有活跃成员可继续使用席位，新增、重新启用和接受邀请使用新上限。组和个人配额继续在签发及续租时实时计算。

## HTTP

除预览外写入需要 `Idempotency-Key`，权限及并发检查在提交时复核。并发冲突返回 `409 conflict`，字段类型或越界返回 `422 invalid`。每个管理视图按角色返回 `actions`。

| 方法和路径（均带 `/v1`） | 请求 | 结果与权限 |
| --- | --- | --- |
| GET `/platform/contract-templates` | `q, cursor, limit` | 模板版本台账，`items[]` 含 `id, version, name, entitlements` 及发布信息。平台管理员 |
| POST `/platform/contract-templates` | `{id,name,revision,entitlements}`，`revision` 为当前最新版本或 0 | 发布 `version = revision + 1`。平台管理员 |
| GET `/platform/capability-contracts` | `q, cursor, limit` | 租户合约台账，项目含 `tenant_id,name`。平台管理员 |
| GET `/platform/capability-contracts/:tenant_id` | 当前视图 | `{tenant_id,revision,platform_contract,tenant_revision,effective,seats,actions}`。未确认时 `platform_contract:null`、`revision:0`，可通过 `effective` 查看待核对值。平台管理员 |
| GET `/platform/capability-contracts/:tenant_id/history` | `cursor, limit` | 已签平台合约历史，按修订倒序分页。平台管理员 |
| POST `/platform/capability-contracts/:tenant_id/preview` | 同签发 | 返回 `{previous_effective,effective,configuration,seats}`。平台管理员 |
| PUT `/platform/capability-contracts/:tenant_id` | `{revision,tenant_revision,template_id,template_version,entitlements?,reason}`，`entitlements` 可部分覆盖模板 | 签发后返回 GET 视图。平台管理员 |
| GET `/contract/configuration` | 当前视图 | `{platform_revision,revision,entitlements,configuration,effective,seats,actions}`。户主可读写，管理员只读，未确认时 `entitlements:null` |
| POST `/contract/configuration/preview` | 同租户发布 | 返回 `{previous_effective,effective,configuration,seats}`。户主 |
| PUT `/contract/configuration` | `{platform_revision,revision,configuration}` | 发布后返回 GET 视图。户主 |

`platform_contract` 含 `revision,template_id,template_version,entitlements,reason,issued_by,effective_at`。`seats` 含 `limit,active,available,over_limit`。`effective` 含现行合约字段 `seat_limit,allowed_agents,allowed_models,lease_minutes,lease_budget_milli,visibility,agent_release_ids`，及 `quota_distribution`。平台详情返回 `publish`，已签发时还返回 `read_history`；租户配置可发布时返回 `update`。

配额分配关闭时，成员及组的配置视图返回 `quota_configurable:false`，变更其配额返回 `403 forbidden`（`reason:"quota_distribution_disabled"`）。配额用量接口返回 `quota_distribution:false`，同时有效配额及剩余额度取 `null`，账本用量和预留仍按实际结果显示。

`GET /contract`、`GET /contract/effective` 和发行候选读取继续可用。存量在平台签发前保留旧投影和业务行为，旧 `PUT /contract` 冻结权益扩张，只允许在原有值内收窄。完成签发后，旧 `PUT /contract` 返回 `409 conflict`（`reason: "use_tenant_configuration"`）。第一次签发时按核准权益保留并收窄存量选择，生成租户配置修订 1，旧修订与历史用量保留。

## Edge 下发

支持本契约的 Edge 在 `hello` 同时发送 `agent_cache:true` 和 `capability_contract_v1:true`。已签合约的设备必须支持这两项，才能收到有效路由、发行、密钥并获得新租约。旧设备收到空快照和 `cutoff(contract)`，仍可上报并结清原租约。尚未签发的租户继续支持原协议。

`config` 新增可选字段 `"capability_contract":{"platform_revision":7,"tenant_revision":3}`。平台修订为正整数，租户修订为非负整数。历史 Server 或未确认租户可省略。既有 `config.revision` 仍是设备快照的唯一顺序，Edge 原子替换快照及两层修订，旧版本和重放忽略。收到更高的设备版本且未携带两层修订时，状态回到未知。

`routes`、`agents`、`rates` 继续携带完整有效列表。空列表撤下相应能力，新的路由请求、启动选择和已缓存发行均需依据当前快照。密钥只对有效路由发放，租约及既有结算沿用现行协议。两层修订可通过本机状态接口读取，可选字段名与下发一致。
