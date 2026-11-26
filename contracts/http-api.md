# HTTP API v0

前缀 `/v1`。认证用 `Authorization: Bearer <token>`。管理端、Desktop 和外部 Agent 使用同一套 API；Web 页面不得调用页面专用接口。

列表接口统一：`?q=&cursor=&limit=`（limit 默认 50，最大 200），返回 `{"items": [...], "next_cursor": "..." | null, "total": n}`。

每个对象返回 `actions` 数组，列出当前调用者对它能执行的操作（例如 `["read","update","disable"]`）。页面按 `actions` 显示按钮，不自己推导权限。

所有公开对象带 `revision` 和 `actions`。

客户端按块录入和展示橡皮数量。充值 0.5 块橡皮时向接口提交 `amount_milli: 500`，查询得到 `cost_milli: 1` 时展示为 0.001 块橡皮。金额和费率的字段单位见[通用约定](README.md)。

条目库、合约版本、租户配置和充值凭证使用[能力合约 v2](capability-policy-v2.md#2-http-协议)。

创建类操作没有对象可挂，放在 `/me` 的 `actions` 里，命名为 `create_<资源单数>`：`create_member`、`create_group`、`create_invite`、`update_contract`、`topup`（平台管理员）。列表响应也带 `actions`，内容与 `/me.actions` 中该资源相关的部分一致，空列表时同样返回。

## 登录与设备

验证码是登录的必要条件；邀请码只用于加入租户。`target` 是邮箱或手机号。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/auth/code` | `{target}`，202。发送验证码（开发环境打印到 Server 日志） |
| POST | `/auth/login` | `{target, code, invite_code?, kind?}`，`kind` 为 `web`（默认）或 `desktop`。返回全局令牌 `{token, user, tenants[]}` |
| POST | `/auth/password-login` | `{tenant, username, password, kind?}`，`kind` 为 `web`（默认）或 `desktop`。返回立即可用的租户范围令牌 `{token, user, tenants[]}`，数组只含本次登录的租户。 |
| POST | `/auth/select-tenant` | `{tenant_id, kind?}`，`kind` 不传时继承当前令牌。返回新的租户范围令牌 |
| POST | `/auth/logout` | 204 |
| GET | `/me` | `{user, tenant, role, agents, is_platform_admin, actions}`；未选租户时 `tenant`、`role` 为 null |
| POST | `/devices` | `{name, os, arch, public_key}`，201，返回 `{device_id, device_token}` |
| POST | `/devices/:id/resume-challenge` | `{}`，200，返回 `{key_id, nonce, ciphertext}`。需要当前账号的 Desktop 租户会话，且设备和所属成员均有效。 |
| POST | `/devices/:id/resume` | `{proof}`，必须带 `Idempotency-Key`。使用同一个 Desktop 租户会话，200，返回 `{device_id, device_token}`。 |

`tenant` 可填完整租户 ID 或简称。简称、用户名按 Unicode NFKC 归一并忽略大小写，允许多个租户共享简称，密码按原样校验。简称须唯一匹配有效成员的用户名和密码才可登录。若匹配结果不确定，用户可用完整租户 ID 指定租户。凭据错误统一为 401，频率超限返回 429。密码会话的 `/me` 含 `tenant_password_login: true`，只在所选租户内操作。平台管理员沿用个人令牌入口。

设备恢复使用和 Edge 密钥下发一致的 X25519、HKDF-SHA256 和 XChaCha20-Poly1305 信封。将 UTF-8 `onex-device-resume-v1` 用作附加认证数据，用当前设备私钥解开信封，然后将完整 UTF-8 明文作为 `proof` 发送。挑战两分钟内可用于当前会话，成功后重新签发设备令牌，保留设备 ID、已有会话和回传确认序号。设备令牌过期时仍可恢复有效设备。旧令牌和对应的 WebSocket 在成功后失效。请求超时可用相同幂等键重试同一请求以取回已签发的令牌。

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

平台合约签发、租户配置和旧写入入口的兼容规则见[能力合约 HTTP 接口](capability-contract.md#http)。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/members`，`/members/:id` | 成员台账与详情 |
| GET/POST | `/groups`，`/groups/:id` | 组 |
| POST | `/invites` | `{role, group_id, max_uses, expires_in_ms}`，返回邀请码（只返回一次） |
| GET/PUT | `/contract` | 当前租户合约 |
| GET | `/balance` | 余额、已预留、本月消耗 |
| GET | `/quota/usage` | 本月配额用量（v0.12）。`?scope=member&id=` 或 `?scope=group&id=`，返回 `{scope, id, quota_milli, used_milli, reserved_milli, remaining_milli}`：`used_milli` 只含本月 `settle`，`reserved_milli` 是仍 active 的租约预留，`remaining_milli = quota_milli − used_milli − reserved_milli`（可为负，表示已被超出，上界是相关成员所有设备 active 租约之和）；`quota_milli` 为 null 时 `remaining_milli` 也为 null。台账行和 `/me.quota` 的 `month_used_milli` = `used_milli + reserved_milli`。owner、admin 可查全部；group_admin 只能查本组及子组；member 只能查自己。无权查看的对象与不存在的对象一律返回 404，不区分 |
| GET | `/ledger` | 橡皮流水。 `overage_pending` 单列超租约待核对的差额，`amount_milli` 不计入余额、预留或本月消耗。 |
| POST | `/platform/ledger/topup` | 平台管理员为租户充值橡皮，全局令牌，`{tenant_id, amount_milli, note?}` |
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
| GET/POST | `/platform/tenants` | 租户，列表与创建支持可选 `short_name` |
| GET/POST/PATCH | `/platform/tenants/:id` | 租户详情、更新，`short_name: null` 清除简称，省略保留；简称允许重复 |
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

## 能力合约的 Agent 制品

- `GET /v1/contract` 增加 `agent_releases`。每项含固定发行 ID、Agent、版本、系统、架构、SHA-256、大小及 `available`。
- `GET /v1/contract/agent-releases?q=&cursor=&limit=` 向租户 owner/admin 分页返回启用且已缓存的可选发行。
- 户主在 `PUT /v1/contract/configuration` 的 `configuration.agent_release_ids` 中可按 Agent、系统、架构各固定一项，发行须属于已启用的 Agent。清除固定项后跟随平台目录。尚未签发的租户可经旧 `PUT /v1/contract` 为原有范围增加固定限制，现有固定项在对应 Agent 仍开启时须保留。
- 保存合约时冻结原始发行身份并写审计。没有固定版本的目标跟随平台已启用的缓存发行。固定发行不可用时该目标暂停供给。固定发行的平台要求支持 Server 制品缓存的 Edge。
- `GET /v1/contract/effective?os=&arch=` 向已选择租户的成员返回合约修订、指定平台实际可用的受管发行及当前生效的模型和倍率。Agent 状态为 `available`、`unavailable` 或 `qualification_required`。模型及倍率与 Edge 下发使用同一解析，响应省略上游 URL、代理和密钥。
- 设备下载及平台管理接口见 [维护与发布](maintenance-releases.md)。

## 监察统计与 Parquet

- `GET /v1/observe/statistics?from=YYYY-MM-DD&to=YYYY-MM-DD&agent=`。按北京时间自然日（两端含当日），缺省为最近 30 天，支持近 90 天以内不超过 30 日的区间。返回 `totals`、`daily`、`agents`、`as_of` 和 `actions`。计量包括新增会话、事件、用户轮次、请求、输入输出与缓存 token、毫橡皮及待结算请求。孤立用量归到 `unknown`。活跃人数按查询范围内去重，不能相加合计。
- `GET /v1/observe/statistics/parquet` 使用相同过滤条件，返回按日期及 Agent 汇总的 Parquet。成功导出写入租户审计 `observe.statistics.export`。
- 统计与会话摘要使用相同的当前可见范围。统计和导出只提供汇总字段，不返回正文、身份标识或原始用量单据。私有快照按租户隔离，从 SQLite 生成。配置 RustFS 时，每 15 分钟将活跃租户的最新快照同步至私有存储。DuckDB 执行 Parquet 查询，在线事件及计费仍写 SQLite。

## Desktop 用户反馈

- `GET /v1/edge/issues?q=&cursor=&limit=` 使用活动设备令牌，按设备所属租户和用户返回本人记录。
- `POST /v1/edge/issues` 使用活动设备令牌，JSON `{text,images:[{mime,data}],logs}`；最多 3 张 base64 图片，MIME 为 PNG/JPEG/WebP，每张不超过 1 MiB；日志最多 28 条、总大小不超过 100 KiB。提交文本不超过 20,000 字符。每用户每小时最多 20 条。
- `GET /v1/platform/issues?q=&cursor=&limit=`、`GET /v1/platform/issues/:id` 与 `GET /v1/platform/issues/:id/images/:index` 仅平台管理员 token 可访问。图片响应经鉴权，设置 no-sniff。
- 图片在平台管理界面呈现；日志只存诊断白名单字段，并由 master 展开查看。
