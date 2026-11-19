# HTTP API v0

前缀 `/v1`。认证用 `Authorization: Bearer <token>`。管理端、Desktop 和外部 Agent 使用同一套 API；Web 页面不得调用页面专用接口。

列表接口统一：`?q=&cursor=&limit=`（limit 默认 50，最大 200），返回 `{"items": [...], "next_cursor": "..." | null, "total": n}`。

每个对象返回 `actions` 数组，列出当前调用者对它能执行的操作（例如 `["read","update","disable"]`）。页面按 `actions` 显示按钮，不自己推导权限。

所有公开对象带 `revision` 和 `actions`。

创建类操作没有对象可挂，放在 `/me` 的 `actions` 里，命名为 `create_<资源单数>`：`create_member`、`create_group`、`create_invite`、`update_contract`、`topup`（平台管理员）。列表响应也带 `actions`，内容与 `/me.actions` 中该资源相关的部分一致，空列表时同样返回。

## 登录与设备

验证码是登录的必要条件；邀请码只用于加入租户。`target` 是邮箱或手机号。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/auth/code` | `{target}`，202。发送验证码（开发环境打印到 Server 日志） |
| POST | `/auth/login` | `{target, code, invite_code?, kind?}`，`kind` 为 `web`（默认）或 `desktop`。返回全局令牌 `{token, user, tenants[]}` |
| POST | `/auth/select-tenant` | `{tenant_id, kind?}`，`kind` 不传时继承当前令牌。返回新的租户范围令牌 |
| POST | `/auth/logout` | 204 |
| GET | `/me` | `{user, tenant, role, agents, is_platform_admin, actions}`；未选租户时 `tenant`、`role` 为 null |
| POST | `/devices` | `{name, os, arch, public_key}`，201，返回 `{device_id, device_token}` |

## 写入与角色（v0.3）

- 新建用 `POST /<资源>`；更新用 `POST /<资源>/:id`（`PATCH` 同义），请求体带 `revision`。
- 平台管理员由 system 库的 `platform_admins` 表显式授权，不继承任何租户角色；用全局令牌调用 `/platform/*`。
- 租户 owner 可以改合约、任免 admin；admin 管普通成员和组，不能任免 admin 或 owner。
- 邀请码只在第一次创建时返回明文；同一 `Idempotency-Key` 重放时返回同一对象，带 `code_returned: false`。

S0 不提供邀请管理 API，用本地 seed 命令创建租户、成员和邀请码；`POST /invites` 在 S1 实现。

## 租户管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/members`，`/members/:id` | 成员台账与详情 |
| GET/POST | `/groups`，`/groups/:id` | 组 |
| POST | `/invites` | `{role, group_id, max_uses, expires_in_ms}`，返回邀请码（只返回一次） |
| GET/PUT | `/contract` | 当前租户合约 |
| GET | `/balance` | 余额、已预留、本月消耗 |
| GET | `/ledger` | 橡皮流水 |
| POST | `/platform/ledger/topup` | 平台管理员手工加分，全局令牌，`{tenant_id, amount_milli, note?}` |
| GET | `/devices`，`/devices/:id` | 设备台账 |
| POST | `/devices/:id/diag` | `{kind}`，返回 `diag_id` |
| GET | `/diag/:id` | 状态和日志包下载地址 |
| GET | `/audit` | 审计 |

## 监察

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/observe/people` | 人员台账：`session_count`、`cost_milli`（全部时间）、`month_cost_milli`（本月，按租户时区，S1 固定 Asia/Shanghai）、`last_active_at` |
| GET | `/observe/sessions` | `?user_id=`，会话台账，按 `started_at` 倒序。字段含 `turn_count`（主会话中 `user_message` 的条数，不含子 Agent 和系统注入）、`event_count`、`cost_milli`、`pending_usage_count` |
| GET | `/observe/sessions/:id/events` | `?after_seq=`，对话事件；每次读取写审计 |
| GET | `/observe/stream` | SSE，推送新会话和新事件的摘要 |

## 平台

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/platform/tenants` | 租户 |
| GET/POST | `/platform/providers`，`/platform/models`，`/platform/rates` | Provider、模型、倍率。`/platform/models?provider_id=`、`/platform/rates?model_id=` 在服务端过滤，`total` 和 `cursor` 都按过滤后的结果计算 |
| GET/POST | `/platform/agent-releases` | Agent 发行目录 |

## 运维

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | 健康，含版本和提交 |
| GET | `/openapi.json` | 机器可读接口描述，供 Agent 调用 |
