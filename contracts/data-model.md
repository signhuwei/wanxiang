# 数据模型 v0

## system.sqlite

| 表 | 主要字段 |
| --- | --- |
| `platform_users` | id、email、phone、name、created_at |
| `tenants` | id、name、owner_user_id、status（`active`、`suspended`）、db_file、created_at |
| `identities` | user_id、kind（`email`、`phone`）、value；同一个人可在多个租户 |
| `memberships` | tenant_id、user_id、role（`owner`、`admin`、`group_admin`、`member`）、status |
| `login_codes` | target、code_hash、expires_at、attempts |
| `invites` | code_hash、tenant_id、role、group_id、max_uses、used、expires_at、created_by |
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
| `ledger` | id、kind（`topup`、`reserve`、`settle`、`release`、`adjust`）、amount_milli、user_id、lease_id、request_ref、by、at |
| `leases` | id、device_id、user_id、budget_milli、used_milli、expires_at、status |
| `devices` | id、user_id、name、os、arch、edge_version、public_key、last_seen_at、status |
| `agent_sessions` | id、device_id、user_id、agent、agent_version、model、started_at、ended_at、event_count、cost_milli |
| `session_events` | device_id、seq、session_id、kind、at、payload_json；主键 (device_id, seq) |
| `usage` | device_id、seq、request_id、session_id、model_id、input/output/cache_read/cache_write_tokens、cost_milli、status、at |
| `diag_jobs` | id、device_id、kind、status、object_key、requested_by、at |
| `audit` | id、actor、action、target、detail_json、at |

余额 = `ledger` 中 topup + adjust − settle 的合计，再减去未结算租约的 reserve。Server 在单个事务里写 ledger 和 leases。

`session_events` 和 `usage` 用 (device_id, seq) 做主键，重复回流直接忽略，保证不重。
