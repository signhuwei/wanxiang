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

### 网页个人登录令牌

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/auth/personal-tokens` | 已登录账号自己的令牌台账，使用通用分页，不返回令牌明文。 |
| POST | `/auth/personal-tokens` | 自己的网页会话创建 `{name}`，201，首次响应附 `token`。同一幂等请求重放仅返回记录。 |
| POST | `/auth/personal-tokens/:id/revoke` | `{revision}`，撤销自己的令牌，204。同时结束由该令牌签发的全局和租户网页会话。 |
| POST | `/auth/token-login` | `{token}`，200，与验证码登录相同的 `{token,user,tenants}`。输入为个人登录令牌，输出为普通网页会话。 |

台账记录返回 `id`、`name`、`created_at`、`expires_at`、`last_used_at`、`revoked_at`、`revision` 和 `actions`。网页会话的列表动作含 `create_personal_token`，有效记录含 `revoke`。服务器只存登录令牌的哈希。同一账号最多同时有 10 个有效令牌，每个最长有效 7 天。实体权限以登录时当前账号及租户为准，由令牌签发的会话不能换成 Desktop 会话或注册设备，且不会超过令牌原有效期。

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
| GET | `/quota/usage` | 本月配额用量（v0.12）。`?scope=member&id=` 或 `?scope=group&id=`，返回 `{scope, id, quota_milli, used_milli, reserved_milli, remaining_milli}`：`used_milli` 只含本月 `settle`，`reserved_milli` 是仍 active 的租约预留，`remaining_milli = quota_milli − used_milli − reserved_milli`（可为负，表示已被超出，上界是相关成员所有设备 active 租约之和）；`quota_milli` 为 null 时 `remaining_milli` 也为 null。台账行和 `/me.quota` 的 `month_used_milli` = `used_milli + reserved_milli`。owner、admin 可查全部；group_admin 只能查本组及子组；member 只能查自己。无权查看的对象与不存在的对象一律返回 404，不区分 |
| GET | `/ledger` | 橡皮流水。 `overage_pending` 单列超租约待核对的差额，`amount_milli` 不计入余额、预留或本月消耗。 |
| POST | `/platform/ledger/topup` | 平台管理员手工加分，全局令牌，`{tenant_id, amount_milli, note?}` |
| GET | `/devices`，`/devices/:id` | 设备台账 |
| POST | `/devices/:id/diag` | 租户 owner、admin 或平台管理员发起。`{kind}`，返回 `diag_id` |
| GET | `/diag/:id` | 查询状态。日志包可取回时返回 OneX 同源 `download_url` |
| PUT | `/diag/:id/upload` | 指定设备以有效设备令牌上送 `application/x-tar` 日志包 |
| GET | `/diag/:id/download` | 对发起诊断有权限的身份下载未过期日志包，通过 OneX API 鉴权。对象存储保持私有 |
| GET | `/audit` | 本租户审计台账。仅限持有本租户令牌的 owner。支持 `action` 精确筛选、`q` 在动作、操作者和目标上按字面搜索，以及通用分页。 |

审计按 `at` 倒序，再按 `id` 倒序。记录返回 `id`、`actor`、`action`、`target`、`at`、`revision: 1` 和 `actions: ["read"]`。列表和 `/me` 通过 `read_audit` 声明入口权限。读取台账不新增审计记录。详情字段、备注和对话内容不进入返回值或搜索范围。

## 监察

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/observe/people` | 人员台账：`session_count`、`cost_milli`（全部时间）、`month_cost_milli`（本月，Asia/Shanghai）、`last_active_at`、`last_agent`（最近会话的 Agent，无会话时为 null）、`quota_milli`、`month_used_milli`（个人配额口径，同 `/members`） |
| GET | `/observe/sessions` | 支持 `user_id` 和精确的 `agent` 筛选（`claude-code`、`codex`、`kimi-code`），筛选结果计算 `total` 和分页。按 `started_at` 倒序。字段含 `turn_count`（主会话中 `user_message` 的条数，不含子 Agent 和系统注入）、`event_count`、`cost_milli`、`pending_usage_count` |
| GET | `/observe/sessions/:id/events` | `?after_seq=`，对话事件；每次读取写审计。只有会话对象的 `actions` 含 `read_content` 时才能调用；`read` 只表示能看摘要 |
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

## 配额在台账中的展示（v0.12）

- `/members` 与 `/groups` 的每行加 `month_used_milli`（本月已结算 + 仍 active 的租约预留，口径同 `data-model.md` 配额一节）。不新增页面专用接口。
- `/me` 加 `quota`：`{quota_milli, month_used_milli, remaining_milli, limited_by}`，`limited_by` 为 `member`、`group:<id>` 或 null（不限），供 Desktop 与管理端提示。`limited_by` 是组时，三个数是该组的合计，普通成员也能看到；这是提示所需，允许（v0.13）。普通成员仍不能经 `/quota/usage` 查组。
