//! `route_pool.v1` 设备应用的本地持久层（`contracts/routing-projection.md` 设备协议第 2、3 条）。
//!
//! 一个作用域 `(server_origin, tenant_id, user_id, device_id)` 有一行设备生效索引、一组已见通知和
//! 一组回执记录。新投影的生效索引、通知去重和待发成功回执在同一个 SQLite 事务里提交，之后调用方
//! 才切换内存视图、发送成功回执。这里不存明文密钥、信封或完整配置；重启后靠 Server 同身份重封恢复。

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result, bail};
use onex_core::route_pool::ApplyResult;
use onex_core::ws::ConfigApplied;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::route_stage::AppliedIdentity;

/// 2：加隔离租约表（`contracts/routing-lease-gate.md`）。1 的库打开时就地升级。
const SCHEMA_VERSION: i64 = 2;

/// 配置域：服务、租户、成员、设备。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Scope {
    pub server_origin: String,
    pub tenant_id: String,
    pub user_id: String,
    pub device_id: String,
}

impl Scope {
    /// `server_url` 取 scheme、host 和端口作为服务标识。
    pub fn new(server_url: &str, tenant_id: &str, user_id: &str, device_id: &str) -> Option<Self> {
        let url = reqwest::Url::parse(server_url).ok()?;
        let host = url.host_str()?;
        let origin = match url.port() {
            Some(port) => format!("{}://{host}:{port}", url.scheme()),
            None => format!("{}://{host}", url.scheme()),
        };
        Some(Self {
            server_origin: origin,
            tenant_id: tenant_id.into(),
            user_id: user_id.into(),
            device_id: device_id.into(),
        })
    }
}

/// 已持久的设备生效索引。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedRecord {
    pub identity: AppliedIdentity,
    pub policy_revision: u64,
    pub signature_id: String,
    pub revocation_revision: u64,
    pub expires_at_ms: i64,
    pub applied_at_ms: i64,
}

/// 尚未收到成功 ACK、也未被更高投影取代的成功回执。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingReceipt {
    pub id: String,
    pub config_revision: u64,
    pub projection_id: String,
    pub policy_revision: u64,
    /// 最近一次失败 ACK 的脱敏错误码。保留记录，等 Server 重发或新目标。
    pub last_failure: Option<String>,
}

impl PendingReceipt {
    pub fn to_message(&self) -> ConfigApplied {
        ConfigApplied {
            id: self.id.clone(),
            config_revision: self.config_revision as i64,
            policy_revision: self.policy_revision,
            projection_id: Some(self.projection_id.clone()),
            result: Some(ApplyResult::Applied),
            error: None,
        }
    }
}

/// 测试用的真实故障点：事务内（写入后、提交前）或提交后（切换内存视图前）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    /// 写入完成但事务回滚，等同提交前崩溃或磁盘写失败。
    BeforeCommit,
    /// 已提交，但向调用方报错，等同提交后、切换前崩溃。
    AfterCommit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AckMatch {
    /// 本作用域的回执，已记录。
    Recorded,
    /// 不是本作用域的回执 ID。
    Unknown,
}

pub struct Store {
    conn: Mutex<Connection>,
    fault: Mutex<Option<Fault>>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).with_context(|| format!("open route apply store {}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS applied (
                 server_origin TEXT NOT NULL, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
                 config_revision INTEGER NOT NULL,
                 projection_id TEXT NOT NULL,
                 digest BLOB NOT NULL,
                 policy_revision INTEGER NOT NULL,
                 signature_id TEXT NOT NULL,
                 revocation_revision INTEGER NOT NULL,
                 expires_at_ms INTEGER NOT NULL,
                 applied_at_ms INTEGER NOT NULL,
                 PRIMARY KEY (server_origin, tenant_id, user_id, device_id)
             );
             CREATE TABLE IF NOT EXISTS notices_seen (
                 server_origin TEXT NOT NULL, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
                 notice_id TEXT NOT NULL,
                 first_config_revision INTEGER NOT NULL,
                 PRIMARY KEY (server_origin, tenant_id, user_id, device_id, notice_id)
             );
             CREATE TABLE IF NOT EXISTS receipts (
                 server_origin TEXT NOT NULL, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
                 receipt_id TEXT NOT NULL,
                 result TEXT NOT NULL,
                 config_revision INTEGER NOT NULL,
                 projection_id TEXT NOT NULL,
                 policy_revision INTEGER NOT NULL,
                 digest BLOB NOT NULL,
                 error_code TEXT,
                 error_reason TEXT,
                 created_at_ms INTEGER NOT NULL,
                 acked_at_ms INTEGER,
                 last_failure TEXT,
                 superseded_at_ms INTEGER,
                 PRIMARY KEY (server_origin, tenant_id, user_id, device_id, receipt_id)
             );
             -- 隔离租约：只记账面身份，不进生产 lease.json，也不放行任何请求。
             CREATE TABLE IF NOT EXISTS pool_leases (
                 server_origin TEXT NOT NULL, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
                 lease_id TEXT NOT NULL,
                 state TEXT NOT NULL CHECK (state IN ('accepted', 'refused', 'settled')),
                 config_revision INTEGER NOT NULL,
                 projection_id TEXT NOT NULL,
                 signature_id TEXT NOT NULL,
                 commerce_plan_id TEXT,
                 expires_at_ms INTEGER NOT NULL,
                 budget_milli INTEGER NOT NULL,
                 model_budgets TEXT NOT NULL,
                 reason TEXT,
                 updated_at_ms INTEGER NOT NULL,
                 PRIMARY KEY (server_origin, tenant_id, user_id, device_id, lease_id)
             );
             -- 发送前持久化的续租操作；重发沿用同一 msg_id、op_id 和数值。
             CREATE TABLE IF NOT EXISTS pool_lease_ops (
                 server_origin TEXT NOT NULL, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
                 op_id TEXT NOT NULL,
                 msg_id TEXT NOT NULL,
                 lease_id TEXT NOT NULL,
                 release_only INTEGER NOT NULL,
                 used_milli INTEGER NOT NULL,
                 model_used_milli TEXT NOT NULL,
                 created_at_ms INTEGER NOT NULL,
                 done_at_ms INTEGER,
                 last_failure TEXT,
                 PRIMARY KEY (server_origin, tenant_id, user_id, device_id, op_id)
             );",
        )?;
        let version: Option<i64> =
            conn.query_row("SELECT v FROM meta WHERE k = 'schema'", [], |r| r.get(0)).optional()?;
        match version {
            None => {
                conn.execute("INSERT INTO meta (k, v) VALUES ('schema', ?1)", [SCHEMA_VERSION])?;
            }
            // 1 → 2 只新增表，上面已建好。
            Some(1) => {
                conn.execute("UPDATE meta SET v = ?1 WHERE k = 'schema'", [SCHEMA_VERSION])?;
            }
            Some(SCHEMA_VERSION) => {}
            Some(other) => bail!("route apply store schema {other} is newer than {SCHEMA_VERSION}"),
        }
        Ok(Self { conn: Mutex::new(conn), fault: Mutex::new(None) })
    }

    /// 让下一次 [`Store::commit_applied`] 在指定位置失败一次。
    #[doc(hidden)]
    pub fn inject_fault(&self, fault: Fault) {
        *self.fault.lock().unwrap() = Some(fault);
    }

    pub fn load(&self, scope: &Scope) -> Result<Option<AppliedRecord>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT config_revision, projection_id, digest, policy_revision, signature_id, revocation_revision,
                    expires_at_ms, applied_at_ms
             FROM applied WHERE server_origin = ?1 AND tenant_id = ?2 AND user_id = ?3 AND device_id = ?4",
            scope_params(scope),
            |r| {
                let digest: Vec<u8> = r.get(2)?;
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    digest,
                    r.get::<_, i64>(3)?,
                    r.get(4)?,
                    r.get::<_, i64>(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            },
        )
        .optional()?
        .map(|(revision, projection_id, digest, policy, signature_id, revocation, expires_at_ms, applied_at_ms)| {
            let digest: [u8; 32] = digest.try_into().map_err(|_| anyhow::anyhow!("stored digest is not 32 bytes"))?;
            Ok(AppliedRecord {
                identity: AppliedIdentity { revision: revision as u64, projection_id, digest },
                policy_revision: policy as u64,
                signature_id,
                revocation_revision: revocation as u64,
                expires_at_ms,
                applied_at_ms,
            })
        })
        .transpose()
    }

    /// 一次提交：生效索引、通知去重、待发成功回执，并让本作用域较低修订的未确认成功回执停止发送。
    /// 返回本次首次见到的通知 ID（按输入顺序）。生效索引只能单调前进。
    pub fn commit_applied(
        &self,
        scope: &Scope,
        record: &AppliedRecord,
        notice_ids: &[&str],
        receipt: &ConfigApplied,
    ) -> Result<Vec<String>> {
        let fault = self.fault.lock().unwrap().take();
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<i64> = tx
            .query_row(
                "SELECT config_revision FROM applied
                 WHERE server_origin = ?1 AND tenant_id = ?2 AND user_id = ?3 AND device_id = ?4",
                scope_params(scope),
                |r| r.get(0),
            )
            .optional()?;
        let revision = record.identity.revision as i64;
        if current.is_some_and(|c| c >= revision) {
            bail!("applied index for this device is already at revision {}", current.unwrap_or_default());
        }
        let [origin, tenant, user, device] = scope_params(scope);
        tx.execute(
            "INSERT INTO applied (server_origin, tenant_id, user_id, device_id, config_revision, projection_id, digest,
                 policy_revision, signature_id, revocation_revision, expires_at_ms, applied_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT (server_origin, tenant_id, user_id, device_id) DO UPDATE SET
                 config_revision = excluded.config_revision, projection_id = excluded.projection_id,
                 digest = excluded.digest, policy_revision = excluded.policy_revision,
                 signature_id = excluded.signature_id, revocation_revision = excluded.revocation_revision,
                 expires_at_ms = excluded.expires_at_ms, applied_at_ms = excluded.applied_at_ms",
            params![
                origin,
                tenant,
                user,
                device,
                revision,
                record.identity.projection_id,
                &record.identity.digest[..],
                record.policy_revision as i64,
                record.signature_id,
                record.revocation_revision as i64,
                record.expires_at_ms,
                record.applied_at_ms,
            ],
        )?;
        let mut fresh = Vec::new();
        for id in notice_ids {
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO notices_seen (server_origin, tenant_id, user_id, device_id, notice_id,
                     first_config_revision) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![origin, tenant, user, device, id, revision],
            )?;
            if inserted == 1 {
                fresh.push((*id).to_owned());
            }
        }
        tx.execute(
            "UPDATE receipts SET superseded_at_ms = ?5
             WHERE server_origin = ?1 AND tenant_id = ?2 AND user_id = ?3 AND device_id = ?4
               AND result = 'applied' AND acked_at_ms IS NULL AND superseded_at_ms IS NULL
               AND config_revision < ?6",
            params![origin, tenant, user, device, record.applied_at_ms, revision],
        )?;
        insert_receipt(&tx, scope, receipt, record.applied_at_ms)?;
        if fault == Some(Fault::BeforeCommit) {
            drop(tx); // 回滚
            bail!("injected fault before commit");
        }
        tx.commit()?;
        if fault == Some(Fault::AfterCommit) {
            bail!("injected fault after commit");
        }
        Ok(fresh)
    }

    /// 同身份的未确认成功回执。已确认或已被取代时为 None。
    pub fn pending_receipt(&self, scope: &Scope, revision: u64, projection_id: &str) -> Result<Option<PendingReceipt>> {
        let conn = self.conn.lock().unwrap();
        let [origin, tenant, user, device] = scope_params(scope);
        conn.query_row(
            "SELECT receipt_id, policy_revision, last_failure FROM receipts
             WHERE server_origin = ?1 AND tenant_id = ?2 AND user_id = ?3 AND device_id = ?4
               AND result = 'applied' AND config_revision = ?5 AND projection_id = ?6
               AND acked_at_ms IS NULL AND superseded_at_ms IS NULL
             ORDER BY created_at_ms DESC LIMIT 1",
            params![origin, tenant, user, device, revision as i64, projection_id],
            |r| {
                Ok(PendingReceipt {
                    id: r.get(0)?,
                    config_revision: revision,
                    projection_id: projection_id.to_owned(),
                    policy_revision: r.get::<_, i64>(1)? as u64,
                    last_failure: r.get(2)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
    }

    /// 同身份最近一条成功回执的 ID，不论是否已确认。供诊断和联验记录。
    pub fn applied_receipt_id(&self, scope: &Scope, revision: u64, projection_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let [origin, tenant, user, device] = scope_params(scope);
        conn.query_row(
            "SELECT receipt_id FROM receipts
             WHERE server_origin = ?1 AND tenant_id = ?2 AND user_id = ?3 AND device_id = ?4
               AND result = 'applied' AND config_revision = ?5 AND projection_id = ?6
             ORDER BY created_at_ms DESC LIMIT 1",
            params![origin, tenant, user, device, revision as i64, projection_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(Into::into)
    }

    /// 本作用域某回执是否已收到过成功 ACK。
    pub fn receipt_acked(&self, scope: &Scope, receipt_id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let [origin, tenant, user, device] = scope_params(scope);
        Ok(conn
            .query_row(
                "SELECT acked_at_ms IS NOT NULL FROM receipts
                 WHERE server_origin = ?1 AND tenant_id = ?2 AND user_id = ?3 AND device_id = ?4 AND receipt_id = ?5",
                params![origin, tenant, user, device, receipt_id],
                |r| r.get::<_, bool>(0),
            )
            .optional()?
            .unwrap_or(false))
    }

    /// 记录拒绝回执。同一稳定 ID 重复写入时保持首条。
    pub fn record_rejection(&self, scope: &Scope, receipt: &ConfigApplied, now_ms: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        insert_receipt(&tx, scope, receipt, now_ms)?;
        tx.commit()?;
        Ok(())
    }

    /// 收到 `ack{re, ok:true}`。只有这一步清除待发成功回执。
    pub fn ack_ok(&self, scope: &Scope, receipt_id: &str, now_ms: i64) -> Result<AckMatch> {
        self.update_receipt(
            scope,
            receipt_id,
            "acked_at_ms = coalesce(acked_at_ms, ?6), last_failure = NULL",
            now_ms.into(),
        )
    }

    /// 收到 `ack{re, ok:false}`：保留记录和脱敏错误码，不清除待发状态。
    pub fn ack_failed(&self, scope: &Scope, receipt_id: &str, code: &str) -> Result<AckMatch> {
        self.update_receipt(scope, receipt_id, "last_failure = ?6", code.to_owned().into())
    }

    fn update_receipt(
        &self,
        scope: &Scope,
        receipt_id: &str,
        set: &str,
        value: rusqlite::types::Value,
    ) -> Result<AckMatch> {
        let conn = self.conn.lock().unwrap();
        let [origin, tenant, user, device] = scope_params(scope);
        let sql = format!(
            "UPDATE receipts SET {set}
             WHERE server_origin = ?1 AND tenant_id = ?2 AND user_id = ?3 AND device_id = ?4 AND receipt_id = ?5"
        );
        let n = conn.execute(&sql, params![origin, tenant, user, device, receipt_id, value])?;
        Ok(if n == 0 { AckMatch::Unknown } else { AckMatch::Recorded })
    }
}

/// 隔离租约的状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PoolLeaseState {
    /// 首次接受时与当时已确认应用视图精确匹配。
    Accepted,
    /// 本认证代次明确拒用、从未接纳或放行过请求。
    Refused,
    /// 已按原租约结清或释放。
    Settled,
}

impl PoolLeaseState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Refused => "refused",
            Self::Settled => "settled",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "accepted" => Some(Self::Accepted),
            "refused" => Some(Self::Refused),
            "settled" => Some(Self::Settled),
            _ => None,
        }
    }
}

/// 一份隔离租约的账面身份。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolLease {
    pub lease_id: String,
    pub state: PoolLeaseState,
    pub config_revision: u64,
    pub projection_id: String,
    pub signature_id: String,
    pub commerce_plan_id: Option<String>,
    pub expires_at_ms: i64,
    pub budget_milli: i64,
    pub model_budgets: BTreeMap<String, i64>,
}

/// 已持久、等待回复的续租操作。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolLeaseOp {
    pub op_id: String,
    pub msg_id: String,
    pub lease_id: String,
    pub release_only: bool,
    pub used_milli: i64,
    pub model_used_milli: BTreeMap<String, i64>,
    pub last_failure: Option<String>,
}

impl PoolLeaseOp {
    /// 每个已分配型号报零用量（Server 结清要求逐键上报）。
    pub fn zero(lease: &PoolLease, release_only: bool) -> Self {
        Self {
            op_id: crate::id::new("op"),
            msg_id: crate::id::new("msg"),
            lease_id: lease.lease_id.clone(),
            release_only,
            used_milli: 0,
            model_used_milli: lease.model_budgets.keys().map(|k| (k.clone(), 0)).collect(),
            last_failure: None,
        }
    }

    pub fn to_frame(&self) -> Value {
        let mut frame = serde_json::json!({
            "type": "lease_renew", "id": self.msg_id, "op_id": self.op_id, "lease_id": self.lease_id,
            "used_milli": self.used_milli, "model_used_milli": self.model_used_milli,
        });
        if self.release_only {
            frame["release_only"] = true.into();
        }
        frame
    }
}

impl Store {
    pub fn pool_lease(&self, scope: &Scope, lease_id: &str) -> Result<Option<PoolLease>> {
        let conn = self.conn.lock().unwrap();
        let [origin, tenant, user, device] = scope_params(scope);
        conn.query_row(
            "SELECT lease_id, state, config_revision, projection_id, signature_id, commerce_plan_id, expires_at_ms,
                    budget_milli, model_budgets
             FROM pool_leases WHERE server_origin = ?1 AND tenant_id = ?2 AND user_id = ?3 AND device_id = ?4
               AND lease_id = ?5",
            params![origin, tenant, user, device, lease_id],
            read_pool_lease,
        )
        .optional()?
        .transpose()
    }

    /// 本作用域仍未结清的已接受租约（最多一份）。
    pub fn accepted_pool_lease(&self, scope: &Scope) -> Result<Option<PoolLease>> {
        let conn = self.conn.lock().unwrap();
        let [origin, tenant, user, device] = scope_params(scope);
        conn.query_row(
            "SELECT lease_id, state, config_revision, projection_id, signature_id, commerce_plan_id, expires_at_ms,
                    budget_milli, model_budgets
             FROM pool_leases WHERE server_origin = ?1 AND tenant_id = ?2 AND user_id = ?3 AND device_id = ?4
               AND state = 'accepted' ORDER BY updated_at_ms DESC LIMIT 1",
            params![origin, tenant, user, device],
            read_pool_lease,
        )
        .optional()?
        .transpose()
    }

    /// 尚未得到结清回复的续租操作，按创建顺序。每份租约最多一份。
    pub fn pending_pool_ops(&self, scope: &Scope) -> Result<Vec<PoolLeaseOp>> {
        let conn = self.conn.lock().unwrap();
        let [origin, tenant, user, device] = scope_params(scope);
        let mut stmt = conn.prepare(
            "SELECT op_id, msg_id, lease_id, release_only, used_milli, model_used_milli, last_failure
             FROM pool_lease_ops WHERE server_origin = ?1 AND tenant_id = ?2 AND user_id = ?3 AND device_id = ?4
               AND done_at_ms IS NULL ORDER BY created_at_ms, op_id",
        )?;
        let rows = stmt.query_map(params![origin, tenant, user, device], |r| {
            let models: String = r.get(5)?;
            Ok((
                PoolLeaseOp {
                    op_id: r.get(0)?,
                    msg_id: r.get(1)?,
                    lease_id: r.get(2)?,
                    release_only: r.get::<_, i64>(3)? != 0,
                    used_milli: r.get(4)?,
                    model_used_milli: BTreeMap::new(),
                    last_failure: r.get(6)?,
                },
                models,
            ))
        })?;
        rows.map(|row| {
            let (mut op, models) = row?;
            op.model_used_milli = serde_json::from_str(&models).context("stored model_used_milli")?;
            Ok(op)
        })
        .collect()
    }

    /// 某租约的在途续租操作。
    pub fn pending_pool_op(&self, scope: &Scope, lease_id: &str) -> Result<Option<PoolLeaseOp>> {
        Ok(self.pending_pool_ops(scope)?.into_iter().find(|op| op.lease_id == lease_id))
    }

    /// 本作用域当前视图的成功回执是否已获得成功 ACK（含重启前持久的确认）。
    pub fn view_receipt_acked(&self, scope: &Scope, revision: u64, projection_id: &str) -> Result<bool> {
        match self.applied_receipt_id(scope, revision, projection_id)? {
            Some(id) => self.receipt_acked(scope, &id),
            None => Ok(false),
        }
    }

    /// 接受一份与当前已确认应用视图精确匹配的租约。`settled` 是同一回复里结清的旧操作。
    pub fn accept_pool_lease(
        &self,
        scope: &Scope,
        lease: &PoolLease,
        settled: Option<&PoolLeaseOp>,
        now_ms: i64,
    ) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(op) = settled {
            settle_op(&tx, scope, op, now_ms)?;
        }
        upsert_pool_lease(&tx, scope, lease, PoolLeaseState::Accepted, None, now_ms)?;
        tx.commit()?;
        Ok(())
    }

    /// 拒用一份从未接纳的租约：拒用标记和零用量的 release_only 操作在同一事务里落盘，之后才发送。
    pub fn refuse_pool_lease(
        &self,
        scope: &Scope,
        lease: &PoolLease,
        reason: &str,
        settled: Option<&PoolLeaseOp>,
        now_ms: i64,
    ) -> Result<PoolLeaseOp> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(op) = settled {
            settle_op(&tx, scope, op, now_ms)?;
        }
        let [origin, tenant, user, device] = scope_params(scope);
        let existing: Option<String> = tx
            .query_row(
                "SELECT state FROM pool_leases WHERE server_origin = ?1 AND tenant_id = ?2 AND user_id = ?3
                   AND device_id = ?4 AND lease_id = ?5",
                params![origin, tenant, user, device, lease.lease_id],
                |r| r.get(0),
            )
            .optional()?;
        if existing.as_deref().and_then(PoolLeaseState::parse) == Some(PoolLeaseState::Accepted) {
            bail!("lease {} was already accepted; it must be settled normally", lease.lease_id);
        }
        upsert_pool_lease(&tx, scope, lease, PoolLeaseState::Refused, Some(reason), now_ms)?;
        let op = PoolLeaseOp::zero(lease, true);
        insert_op(&tx, scope, &op, now_ms)?;
        tx.commit()?;
        Ok(op)
    }

    /// 为已接受租约开始常规结清。该租约已有在途操作时返回它，不新开。
    pub fn begin_settlement(&self, scope: &Scope, lease: &PoolLease, now_ms: i64) -> Result<PoolLeaseOp> {
        if let Some(op) = self.pending_pool_op(scope, &lease.lease_id)? {
            return Ok(op);
        }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let op = PoolLeaseOp::zero(lease, false);
        insert_op(&tx, scope, &op, now_ms)?;
        tx.commit()?;
        Ok(op)
    }

    /// 回复确认旧租约已结清：只按在途操作的 `re` 和匹配的旧租约 ID 完成，不动之后接受的租约。
    pub fn complete_settlement(&self, scope: &Scope, op: &PoolLeaseOp, now_ms: i64) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        settle_op(&tx, scope, op, now_ms)?;
        tx.commit()?;
        Ok(())
    }

    /// 续租收到失败 ACK：保留操作和原数值，记脱敏错误码。
    pub fn pool_op_failed(&self, scope: &Scope, msg_id: &str, code: &str) -> Result<AckMatch> {
        let conn = self.conn.lock().unwrap();
        let [origin, tenant, user, device] = scope_params(scope);
        let n = conn.execute(
            "UPDATE pool_lease_ops SET last_failure = ?6
             WHERE server_origin = ?1 AND tenant_id = ?2 AND user_id = ?3 AND device_id = ?4 AND msg_id = ?5
               AND done_at_ms IS NULL",
            params![origin, tenant, user, device, msg_id, code],
        )?;
        Ok(if n == 0 { AckMatch::Unknown } else { AckMatch::Recorded })
    }
}

fn read_pool_lease(r: &rusqlite::Row<'_>) -> rusqlite::Result<Result<PoolLease>> {
    let state: String = r.get(1)?;
    let models: String = r.get(8)?;
    let lease = (|| {
        Ok(PoolLease {
            lease_id: r.get(0)?,
            state: PoolLeaseState::parse(&state).context("stored lease state")?,
            config_revision: r.get::<_, i64>(2)? as u64,
            projection_id: r.get(3)?,
            signature_id: r.get(4)?,
            commerce_plan_id: r.get(5)?,
            expires_at_ms: r.get(6)?,
            budget_milli: r.get(7)?,
            model_budgets: serde_json::from_str(&models).context("stored model_budgets")?,
        })
    })();
    Ok(lease)
}

fn upsert_pool_lease(
    tx: &rusqlite::Transaction<'_>,
    scope: &Scope,
    lease: &PoolLease,
    state: PoolLeaseState,
    reason: Option<&str>,
    now_ms: i64,
) -> Result<()> {
    let [origin, tenant, user, device] = scope_params(scope);
    tx.execute(
        "INSERT INTO pool_leases (server_origin, tenant_id, user_id, device_id, lease_id, state, config_revision,
             projection_id, signature_id, commerce_plan_id, expires_at_ms, budget_milli, model_budgets, reason,
             updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT (server_origin, tenant_id, user_id, device_id, lease_id) DO UPDATE SET
             state = excluded.state, reason = excluded.reason, updated_at_ms = excluded.updated_at_ms",
        params![
            origin,
            tenant,
            user,
            device,
            lease.lease_id,
            state.as_str(),
            lease.config_revision as i64,
            lease.projection_id,
            lease.signature_id,
            lease.commerce_plan_id,
            lease.expires_at_ms,
            lease.budget_milli,
            serde_json::to_string(&lease.model_budgets)?,
            reason,
            now_ms,
        ],
    )?;
    Ok(())
}

fn insert_op(tx: &rusqlite::Transaction<'_>, scope: &Scope, op: &PoolLeaseOp, now_ms: i64) -> Result<()> {
    let [origin, tenant, user, device] = scope_params(scope);
    let pending: i64 = tx.query_row(
        "SELECT count(*) FROM pool_lease_ops WHERE server_origin = ?1 AND tenant_id = ?2 AND user_id = ?3
           AND device_id = ?4 AND lease_id = ?5 AND done_at_ms IS NULL",
        params![origin, tenant, user, device, op.lease_id],
        |r| r.get(0),
    )?;
    if pending > 0 {
        bail!("lease {} already has a lease_renew waiting for its reply", op.lease_id);
    }
    tx.execute(
        "INSERT INTO pool_lease_ops (server_origin, tenant_id, user_id, device_id, op_id, msg_id, lease_id,
             release_only, used_milli, model_used_milli, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            origin,
            tenant,
            user,
            device,
            op.op_id,
            op.msg_id,
            op.lease_id,
            op.release_only as i64,
            op.used_milli,
            serde_json::to_string(&op.model_used_milli)?,
            now_ms,
        ],
    )?;
    Ok(())
}

fn settle_op(tx: &rusqlite::Transaction<'_>, scope: &Scope, op: &PoolLeaseOp, now_ms: i64) -> Result<()> {
    let [origin, tenant, user, device] = scope_params(scope);
    tx.execute(
        "UPDATE pool_lease_ops SET done_at_ms = coalesce(done_at_ms, ?6)
         WHERE server_origin = ?1 AND tenant_id = ?2 AND user_id = ?3 AND device_id = ?4 AND op_id = ?5",
        params![origin, tenant, user, device, op.op_id, now_ms],
    )?;
    tx.execute(
        "UPDATE pool_leases SET state = 'settled', updated_at_ms = ?6
         WHERE server_origin = ?1 AND tenant_id = ?2 AND user_id = ?3 AND device_id = ?4 AND lease_id = ?5",
        params![origin, tenant, user, device, op.lease_id, now_ms],
    )?;
    Ok(())
}

fn scope_params(scope: &Scope) -> [&str; 4] {
    [&scope.server_origin, &scope.tenant_id, &scope.user_id, &scope.device_id]
}

fn insert_receipt(tx: &rusqlite::Transaction<'_>, scope: &Scope, receipt: &ConfigApplied, now_ms: i64) -> Result<()> {
    let [origin, tenant, user, device] = scope_params(scope);
    let result = match receipt.result {
        Some(ApplyResult::Applied) => "applied",
        Some(ApplyResult::Rejected) => "rejected",
        None => bail!("route_pool receipt needs a result"),
    };
    let projection = receipt.projection_id.as_deref().context("route_pool receipt needs projection_id")?;
    let (code, reason) = match &receipt.error {
        Some(e) => (
            Some(e.code.as_str()),
            e.detail.as_ref().and_then(|d| d.get("reason")).and_then(Value::as_str).map(str::to_owned),
        ),
        None => (None, None),
    };
    let digest = receipt_digest(receipt);
    let existing: Option<Vec<u8>> = tx
        .query_row(
            "SELECT digest FROM receipts
             WHERE server_origin = ?1 AND tenant_id = ?2 AND user_id = ?3 AND device_id = ?4 AND receipt_id = ?5",
            params![origin, tenant, user, device, receipt.id],
            |r| r.get(0),
        )
        .optional()?;
    match existing {
        Some(d) if d == digest => return Ok(()),
        Some(_) => bail!("receipt {} already stored with different content", receipt.id),
        None => {}
    }
    tx.execute(
        "INSERT INTO receipts (server_origin, tenant_id, user_id, device_id, receipt_id, result, config_revision,
             projection_id, policy_revision, digest, error_code, error_reason, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            origin,
            tenant,
            user,
            device,
            receipt.id,
            result,
            receipt.config_revision,
            projection,
            receipt.policy_revision as i64,
            &digest[..],
            code,
            reason,
            now_ms,
        ],
    )?;
    Ok(())
}

/// 键排序后的 JSON，用于摘要和稳定 ID。
fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let sorted: BTreeMap<&String, Value> = map.iter().map(|(k, v)| (k, canonical(v))).collect();
            Value::Object(sorted.into_iter().map(|(k, v)| (k.clone(), v)).collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

/// 整个合法回执（含 `type` 和 `id`）的规范化摘要。
pub fn receipt_digest(receipt: &ConfigApplied) -> [u8; 32] {
    let mut value = serde_json::to_value(receipt).expect("receipt serializes");
    value.as_object_mut().expect("receipt is an object").insert("type".into(), "config_applied".into());
    Sha256::digest(serde_json::to_vec(&canonical(&value)).expect("canonical json")).into()
}

/// 拒绝回执的稳定 ID：由作用域、投影身份和脱敏错误决定。同一目标同一原因重发得到同一 ID。
pub fn rejection_id(
    scope: &Scope,
    config_revision: u64,
    projection_id: &str,
    policy_revision: u64,
    error: &onex_core::ws::ErrorBody,
) -> String {
    let material = serde_json::json!([
        "onex-route-rejection-v1",
        scope.server_origin,
        scope.tenant_id,
        scope.user_id,
        scope.device_id,
        config_revision,
        projection_id,
        policy_revision,
        error.code,
        canonical(error.detail.as_ref().unwrap_or(&Value::Null)),
    ]);
    let digest = Sha256::digest(serde_json::to_vec(&material).expect("json"));
    let hex: String = digest.iter().take(13).map(|b| format!("{b:02x}")).collect();
    format!("cfr_{hex}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use onex_core::ws::ErrorBody;
    use serde_json::json;

    fn scope() -> Scope {
        Scope::new("wss://onex.example.test/v1/edge/ws", "ten_demo", "usr_lin", "dev_lin").unwrap()
    }

    fn record(revision: u64, projection: &str) -> AppliedRecord {
        AppliedRecord {
            identity: AppliedIdentity { revision, projection_id: projection.into(), digest: [revision as u8; 32] },
            policy_revision: 21,
            signature_id: "sig_12".into(),
            revocation_revision: 3,
            expires_at_ms: 2_000_000,
            applied_at_ms: 1_000 + revision as i64,
        }
    }

    fn applied(id: &str, revision: u64, projection: &str) -> ConfigApplied {
        ConfigApplied {
            id: id.into(),
            config_revision: revision as i64,
            policy_revision: 21,
            projection_id: Some(projection.into()),
            result: Some(ApplyResult::Applied),
            error: None,
        }
    }

    fn rejected(revision: u64, projection: &str, reason: &str) -> ConfigApplied {
        let error = ErrorBody {
            code: "missing_route_credential".into(),
            message: "新配置缺少可用的渠道凭据".into(),
            detail: Some(json!({"deployment_id":"dep_b","reason":reason})),
        };
        ConfigApplied {
            id: rejection_id(&scope(), revision, projection, 21, &error),
            config_revision: revision as i64,
            policy_revision: 21,
            projection_id: Some(projection.into()),
            result: Some(ApplyResult::Rejected),
            error: Some(error),
        }
    }

    #[test]
    fn scope_uses_origin_only() {
        let a = Scope::new("wss://h.example:8443/v1/edge/ws?x=1", "t", "u", "d").unwrap();
        assert_eq!(a.server_origin, "wss://h.example:8443");
        let b = Scope::new("wss://h.example/v1/edge/ws", "t", "u", "d").unwrap();
        assert_eq!(b.server_origin, "wss://h.example");
        assert!(Scope::new("not a url", "t", "u", "d").is_none());
    }

    #[test]
    fn commit_persists_index_notices_and_receipt_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("route_apply.sqlite");
        {
            let store = Store::open(&path).unwrap();
            assert_eq!(store.load(&scope()).unwrap(), None);
            let fresh = store
                .commit_applied(&scope(), &record(91, "prj_91"), &["ntc_91"], &applied("msg_a", 91, "prj_91"))
                .unwrap();
            assert_eq!(fresh, ["ntc_91"]);
        }
        // 真实重开文件：索引、通知和待发回执都在。
        let store = Store::open(&path).unwrap();
        assert_eq!(store.load(&scope()).unwrap(), Some(record(91, "prj_91")));
        let pending = store.pending_receipt(&scope(), 91, "prj_91").unwrap().unwrap();
        assert_eq!(pending.id, "msg_a");
        assert_eq!(pending.to_message(), applied("msg_a", 91, "prj_91"));

        // 同一通知在更高投影中不再算新通知。
        let fresh = store
            .commit_applied(&scope(), &record(92, "prj_92"), &["ntc_91", "ntc_92"], &applied("msg_b", 92, "prj_92"))
            .unwrap();
        assert_eq!(fresh, ["ntc_92"]);
        // 较低修订的未确认成功回执停止发送。
        assert_eq!(store.pending_receipt(&scope(), 91, "prj_91").unwrap(), None);
        assert_eq!(store.pending_receipt(&scope(), 92, "prj_92").unwrap().unwrap().id, "msg_b");
    }

    #[test]
    fn applied_index_is_monotonic() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("s.sqlite")).unwrap();
        store.commit_applied(&scope(), &record(91, "prj_91"), &[], &applied("msg_a", 91, "prj_91")).unwrap();
        for (rev, prj) in [(91, "prj_91"), (91, "prj_x"), (90, "prj_90")] {
            assert!(store.commit_applied(&scope(), &record(rev, prj), &["n"], &applied("msg_z", rev, prj)).is_err());
        }
        // 失败的提交没有留下通知或回执。
        assert_eq!(store.load(&scope()).unwrap().unwrap().identity.revision, 91);
        assert_eq!(store.pending_receipt(&scope(), 90, "prj_90").unwrap(), None);
        let fresh =
            store.commit_applied(&scope(), &record(93, "prj_93"), &["n"], &applied("msg_c", 93, "prj_93")).unwrap();
        assert_eq!(fresh, ["n"]);
    }

    #[test]
    fn scopes_are_isolated() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("s.sqlite")).unwrap();
        store.commit_applied(&scope(), &record(91, "prj_91"), &["ntc_91"], &applied("msg_a", 91, "prj_91")).unwrap();
        let other_user = Scope { user_id: "usr_other".into(), ..scope() };
        let other_server = Scope { server_origin: "wss://other.example.test".into(), ..scope() };
        for other in [&other_user, &other_server] {
            assert_eq!(store.load(other).unwrap(), None);
            assert_eq!(store.pending_receipt(other, 91, "prj_91").unwrap(), None);
            assert_eq!(store.ack_ok(other, "msg_a", 5).unwrap(), AckMatch::Unknown);
            let fresh = store
                .commit_applied(other, &record(10, "prj_10"), &["ntc_91"], &applied("msg_o", 10, "prj_10"))
                .unwrap();
            assert_eq!(fresh, ["ntc_91"], "notice dedupe is per scope");
        }
        assert!(!store.receipt_acked(&scope(), "msg_a").unwrap());
    }

    #[test]
    fn only_ok_ack_clears_pending_and_failure_keeps_record() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sqlite");
        let store = Store::open(&path).unwrap();
        store.commit_applied(&scope(), &record(91, "prj_91"), &[], &applied("msg_a", 91, "prj_91")).unwrap();
        assert_eq!(store.ack_failed(&scope(), "msg_a", "conflict").unwrap(), AckMatch::Recorded);
        let pending = store.pending_receipt(&scope(), 91, "prj_91").unwrap().unwrap();
        assert_eq!((pending.id.as_str(), pending.last_failure.as_deref()), ("msg_a", Some("conflict")));
        assert_eq!(store.ack_ok(&scope(), "msg_unknown", 5).unwrap(), AckMatch::Unknown);
        assert_eq!(store.ack_ok(&scope(), "msg_a", 5).unwrap(), AckMatch::Recorded);
        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(store.pending_receipt(&scope(), 91, "prj_91").unwrap(), None);
        assert!(store.receipt_acked(&scope(), "msg_a").unwrap());
        // 迟到的失败 ACK 不复活已确认的成功回执。
        store.ack_failed(&scope(), "msg_a", "conflict").unwrap();
        assert_eq!(store.pending_receipt(&scope(), 91, "prj_91").unwrap(), None);
    }

    #[test]
    fn fault_before_commit_rolls_back_everything() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sqlite");
        let store = Store::open(&path).unwrap();
        store.inject_fault(Fault::BeforeCommit);
        assert!(
            store
                .commit_applied(&scope(), &record(91, "prj_91"), &["ntc_91"], &applied("msg_a", 91, "prj_91"))
                .is_err()
        );
        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(store.load(&scope()).unwrap(), None);
        assert_eq!(store.pending_receipt(&scope(), 91, "prj_91").unwrap(), None);
        // 通知没被消耗，下一次成功提交仍是新通知。
        let fresh = store
            .commit_applied(&scope(), &record(91, "prj_91"), &["ntc_91"], &applied("msg_b", 91, "prj_91"))
            .unwrap();
        assert_eq!(fresh, ["ntc_91"]);
    }

    #[test]
    fn fault_after_commit_keeps_the_durable_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sqlite");
        let store = Store::open(&path).unwrap();
        store.inject_fault(Fault::AfterCommit);
        assert!(
            store
                .commit_applied(&scope(), &record(91, "prj_91"), &["ntc_91"], &applied("msg_a", 91, "prj_91"))
                .is_err()
        );
        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(store.load(&scope()).unwrap().unwrap().identity.projection_id, "prj_91");
        assert_eq!(store.pending_receipt(&scope(), 91, "prj_91").unwrap().unwrap().id, "msg_a");
        // 故障只触发一次。
        store.commit_applied(&scope(), &record(92, "prj_92"), &[], &applied("msg_b", 92, "prj_92")).unwrap();
    }

    #[test]
    fn rejection_ids_are_stable_and_distinct() {
        let a = rejected(91, "prj_91", "missing_envelope");
        let again = rejected(91, "prj_91", "missing_envelope");
        assert_eq!(a.id, again.id);
        assert!(a.id.starts_with("cfr_") && a.id.len() == 30, "{}", a.id);
        assert_ne!(a.id, rejected(91, "prj_91", "envelope_rejected").id);
        assert_ne!(a.id, rejected(92, "prj_91", "missing_envelope").id);
        assert_ne!(a.id, rejected(91, "prj_92", "missing_envelope").id);
        // detail 的键顺序不影响 ID。
        let mut reordered = a.error.clone().unwrap();
        reordered.detail = Some(json!({"reason":"missing_envelope","deployment_id":"dep_b"}));
        assert_eq!(rejection_id(&scope(), 91, "prj_91", 21, &reordered), a.id);
        let other_device = Scope { device_id: "dev_other".into(), ..scope() };
        assert_ne!(rejection_id(&other_device, 91, "prj_91", 21, a.error.as_ref().unwrap()), a.id);

        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("s.sqlite")).unwrap();
        store.record_rejection(&scope(), &a, 1).unwrap();
        store.record_rejection(&scope(), &again, 2).unwrap();
        // 同 ID 异内容报错。
        let mut changed = a.clone();
        changed.policy_revision = 22;
        assert!(store.record_rejection(&scope(), &changed, 3).is_err());
        // 拒绝不推进生效索引，也不算待发成功回执。
        assert_eq!(store.load(&scope()).unwrap(), None);
        assert_eq!(store.pending_receipt(&scope(), 91, "prj_91").unwrap(), None);
        assert_eq!(store.ack_ok(&scope(), &a.id, 4).unwrap(), AckMatch::Recorded);
    }

    #[test]
    fn digest_covers_whole_receipt() {
        let a = applied("msg_a", 91, "prj_91");
        assert_eq!(receipt_digest(&a), receipt_digest(&a.clone()));
        let mut b = a.clone();
        b.id = "msg_b".into();
        assert_ne!(receipt_digest(&a), receipt_digest(&b));
        assert_ne!(receipt_digest(&a), receipt_digest(&rejected(91, "prj_91", "x")));
    }
}
