# 数据模型 v0

## system.sqlite

| 表 | 主要字段 |
| --- | --- |
| `platform_users` | id、email、phone、name、created_at |
| `tenants` | id、name、owner_user_id、status（`active`、`suspended`）、db_file、created_at |
| `identities` | user_id、kind（`email`、`phone`）、value；同一个人可在多个租户 |
| `memberships` | tenant_id、user_id、role（`owner`、`admin`、`group_admin`、`member`）、status |
| `login_codes` | target、code_hash、expires_at、attempts |
| `sessions` | token_hash、user_id、tenant_id、kind（`web`、`desktop`）、expires_at |
| `providers` | id、name、protocol（`anthropic`、`openai_chat`、`openai_responses`）、base_url、secret_ciphertext、status |
| `models` | id、provider_id、upstream_name、display_name、context_window、status |
| `rates` | model_id、input_milli_per_mtok、output_milli_per_mtok、cache_read_milli_per_mtok、cache_write_milli_per_mtok、effective_from |
| `agent_releases` | id、agent、version、os、arch、url、sha256、size、status |
| `platform_audit` | id、actor、action、target、detail_json、at |

## tenant-<id>.sqlite

| 表 | 主要字段 |
| --- | --- |
| `members` | user_id、role、group_id、status、quota_milli（null 为不限） |
| `groups` | id、name、parent_id、quota_milli |
| `contract` | revision、seat_limit、allowed_agents_json、allowed_models_json、lease_minutes、lease_budget_milli、visibility_json、updated_by、updated_at |
| `ledger` | id、kind（`topup`、`reserve`、`settle`、`release`、`adjust`、`overage_pending`）、amount_milli、user_id、lease_id、request_ref、by、at、note |
| `leases` | id、device_id、user_id、budget_milli、used_milli（已从租户扣款）、expires_at、status |
| `lease_operations` | device_id、op_id、lease_id、used_milli（实报续租快照）、result_json |
| `devices` | id、user_id、name、os、arch、edge_version、public_key、token_hash、token_expires_at、last_seen_at、status |
| `invites` | code_hash、role、group_id、max_uses、used、expires_at、created_by |
| `agent_sessions` | id、device_id、user_id、agent、agent_version、model、started_at、ended_at、event_count、cost_milli |
| `session_events` | device_id、seq、session_id、kind、at、payload_json；主键 (device_id, seq) |
| `usage` | device_id、seq、request_id、session_id、model_id、input/output/cache_read/cache_write_tokens、cost_milli、status、at |
| `diag_jobs` | id、device_id、kind、status、object_key、requested_by、at |
| `audit` | id、actor、action、target、detail_json、at |

`ledger.kind=overage_pending` 只记录超过租约额度的正差额。该行用相同的 `lease_id` 和 `request_ref` 关联本次结算，可单独核对，不计入租户余额、已预留或本月消耗。单请求的真实金额仍保存在 `usage.cost_milli`。

## 权威与索引（v0.1）

租户内的事实以租户库为准。system 库中与租户有关的表只是路由索引，可以从各租户库重建：

| 索引表 | 字段 | 来源 |
| --- | --- | --- |
| `memberships` | tenant_id、user_id、role、status | 租户库 `members` |
| `invite_directory` | code_hash、tenant_id | 租户库 `invites` |
| `device_directory` | device_id、token_hash、tenant_id | 租户库 `devices` |

因此 `invites` 从 system 库移到租户库（字段不变）；`devices` 增加 `token_hash`、`token_expires_at`（滑动续期）。

接受邀请时，校验邀请、检查 `seat_limit`、增加使用次数、写 `members`，在租户库的一个事务里完成。提交成功后再幂等写 system 索引。索引缺失或不一致时以租户库为准修复：Server 启动时全量核对，查询未命中时按需回查。这样不需要跨库事务。

S0 和 S1 只运行一个 Server 写进程（SQLite 本身也要求单节点写）。水平扩展另行设计。

## 监察可见范围（v0.11）

依据访谈：户主（owner）决定给管理员和组管开放哪些可见范围，户主自己全部可见；所有正文查看都写审计。

`contract.visibility_json` 的结构：

```json
{
  "admin":       {"summary": true,  "content": false},
  "group_admin": {"summary": true,  "content": false}
}
```

- `summary`：人员台账、会话台账、token 和橡皮费用，不含对话正文。
- `content`：对话正文（`/observe/sessions/:id/events`）。
- owner 始终两者都可见，不受此字段影响。
- `group_admin` 只能看本组及子组的成员。
- 新租户的默认值：admin 和 group_admin 的 `summary` 为 true，`content` 为 false。理由是费用透明是付费的主要理由之一，而正文是最敏感的数据。
- 只有 owner 能修改 visibility，修改写审计。
- 每次读取正文写一条审计（读者、会话、时间）。SSE `/observe/stream` 只推摘要，不推正文。
- 成员本人可以看自己的会话正文。

余额 = `ledger` 中 topup + adjust − settle 的合计，再减去未结算租约的 reserve。Server 在单个事务里写 ledger 和 leases。

`session_events` 和 `usage` 用 (device_id, seq) 做主键，重复回流直接忽略，保证不重。

## 组和个人配额（v0.12，S2）

依据访谈“租户可以把额度分到组和个人，也可以选择不限制”。

- `members.quota_milli`、`groups.quota_milli` 都是**每个自然月**的橡皮上限（毫橡皮），`null` 表示不限。月份按租户时区，S2 仍固定 Asia/Shanghai，与 `month_cost_milli` 同口径。
- 一个成员的有效上限同时受本人配额、所在组配额、所有祖先组配额约束，先到先停。组配额计的是该组及其全部子组成员的合计。
- 本月已用 = 本月 `settle` 金额加上**仍在 active 的租约**的 `budget_milli`（按租约的 `user_id` 归属）。也就是预留计入配额，与租户余额同理，保证配额最多被超出一个租约。`overage_pending` 不计入。
- 签发租约时，额度取 `min(租户可用余额, 合约 lease_budget_milli, 余额的 5%（最低 1）, 本人剩余, 每一级组的剩余)`。任意一级剩余 ≤ 0 时返回 `cutoff{reason:"quota"}`；租户余额 ≤ 0 仍返回 `balance`，两者都满足时报 `balance`。
- 续租走同样的规则。配额被调低后，已签发的租约照常用完，下一次续租按新值裁决。配额调高或进入新月份后，Edge 下一次续租即可恢复。Server 不主动推送新租约。
- 配额只限制员工的模型用量，不改变租户扣款、`overage_pending` 或租约结清逻辑。
