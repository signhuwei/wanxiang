//! `route_pool.v1` 帧的类型，对应 `contracts/routing-p0.md` 与
//! `tests/fixtures/routing/p0-ab.json`。
//!
//! 旧协议的 [`Msg`](crate::ws::Msg) 解析保持不变：新字段在旧结构里被忽略。只有连接选中
//! [`ROUTE_POOL_V1`] 时，调用方才把同一帧按这里的扩展类型再解析一次。扩展类型用
//! `#[serde(flatten)]` 复用旧结构，新增字段按契约设为必填或可选。
//!
//! 可由 Server 扩充的枚举带 `Unknown` 兜底，保证整帧仍能解析，由校验层拒绝该快照并回执；
//! 由 Edge 自己产出的枚举（尝试终态、决策状态等）保持严格。

use serde::{Deserialize, Serialize};

use crate::ws::{AgentRelease, CapabilityContract, Cutoff, Lease, Policy, Rate, Route, ToolRelease, UsageItem};

/// `hello.capabilities` / `welcome.capabilities` 里的能力名。
pub const ROUTE_POOL_V1: &str = "route_pool.v1";
/// `route_pool.abi` 当前唯一支持的值。
pub const ROUTE_POOL_ABI: u32 = 1;
/// 首版输入倍率基准：人民币 1 元／百万普通输入 Token 为 1×。
pub const INPUT_MULTIPLIER_BASIS: &str = "cny_1_per_mtok_input";
/// 首批能力词（`contracts/routing-p0.md` 连接与回执口径第 3 条）。
pub const FEATURES: [&str; 6] = ["text", "stream", "function_tools", "images", "reasoning", "json_schema"];

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/// 选中 `route_pool.v1` 的连接收到的完整 `config` 帧（不含 `type` 标签）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PoolConfig {
    pub id: String,
    pub revision: i64,
    #[serde(default)]
    pub agent_cache: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_contract: Option<CapabilityContract>,
    pub policy: Policy,
    #[serde(default)]
    pub agents: Vec<AgentRelease>,
    #[serde(default)]
    pub tools: Vec<ToolRelease>,
    #[serde(default)]
    pub routes: Vec<PoolRoute>,
    #[serde(default)]
    pub rates: Vec<PoolRate>,
    pub route_pool: RoutePool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoutePool {
    pub abi: u32,
    pub projection_id: String,
    pub signature_id: String,
    pub expires_at: String,
    pub revocation_revision: u64,
    pub pools: Vec<Pool>,
    pub bindings: Vec<Binding>,
    pub secrets: Vec<RouteSecret>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Strategy {
    Ordered,
    Weighted,
    CostBanded,
    /// Server 新增而本 Edge 不认识的策略，校验时拒绝快照。
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pool {
    pub model_id: String,
    pub pool_revision: u64,
    pub strategy: Strategy,
    pub max_attempts: u32,
    pub attempt_timeout_ms: u64,
    pub total_timeout_ms: u64,
    #[serde(default)]
    pub cost_bands: Vec<CostBand>,
}

/// `cost_banded` 扩展的档位；未协商 `route_pool.cost_banded.v1` 时只解析不执行。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CostBand {
    pub id: String,
    pub max_estimated_input_tokens: Option<u64>,
    pub max_requested_output_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binding {
    pub binding_id: String,
    pub binding_revision: u64,
    pub agent_release_id: String,
    /// `anthropic`、`openai_responses`、`openai_chat`。
    pub ingress_protocol: String,
    pub model_id: String,
    /// 精确名、`前缀*` 或单独的 `*`。
    pub aliases: Vec<String>,
    pub deployment_ids: Vec<String>,
    /// 低余额降档：`deployment_ids=[]` 时指向同一发行和入口下已签的替代型号。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restricted_target_model_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct CredentialRef {
    pub credential_id: String,
    pub credential_version: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AvailabilityState {
    Eligible,
    Conditional,
    Blocked,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Availability {
    pub state: AvailabilityState,
    pub observed_at: String,
    pub valid_until: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<String>,
}

/// `config.routes[]` 的一条部署：旧路由字段加池字段。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PoolRoute {
    #[serde(flatten)]
    pub base: Route,
    pub deployment_id: String,
    pub deployment_revision: u64,
    pub pool_revision: u64,
    pub priority: u64,
    pub features: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_context_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    pub valid_until: String,
    pub availability: Availability,
    pub credential_ref: CredentialRef,
    /// 非原生路由的已验证转换器；原生路由缺省。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter_revision: Option<u64>,
}

/// `config.rates[]` 的一条销售费率版本。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PoolRate {
    #[serde(flatten)]
    pub base: Rate,
    pub rate_version_id: String,
    pub model_display_name: String,
    pub input_multiplier_basis: String,
    pub input_multiplier_ppm: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_until: Option<String>,
}

/// 绑定设备、配置和凭据版本的推理密钥信封，只在 daemon 内存解封。
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteSecret {
    pub credential_id: String,
    pub credential_version: u64,
    pub key_id: String,
    pub nonce: String,
    pub ciphertext: String,
}

impl std::fmt::Debug for RouteSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RouteSecret")
            .field("credential_id", &self.credential_id)
            .field("credential_version", &self.credential_version)
            .finish_non_exhaustive()
    }
}

// ---------------------------------------------------------------------------
// cutoff / lease
// ---------------------------------------------------------------------------

/// 目标选择器：列出的字段全部相等才命中。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RevocationTarget {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deployment_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_version: Option<u64>,
}

impl RevocationTarget {
    /// 至少给出部署 ID，或凭据 ID 与版本。
    pub fn is_well_formed(&self) -> bool {
        self.deployment_id.is_some() || (self.credential_id.is_some() && self.credential_version.is_some())
    }

    pub fn matches(&self, deployment_id: &str, credential: &CredentialRef) -> bool {
        self.is_well_formed()
            && self.deployment_id.as_deref().is_none_or(|id| id == deployment_id)
            && self.credential_id.as_deref().is_none_or(|id| id == credential.credential_id)
            && self.credential_version.is_none_or(|v| v == credential.credential_version)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PoolCutoff {
    #[serde(flatten)]
    pub base: Cutoff,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revocation_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub targets: Vec<RevocationTarget>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub terminate_inflight: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PoolLease {
    #[serde(flatten)]
    pub base: Lease,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature_id: Option<String>,
}

/// 选中 `route_pool.v1` 的连接上与旧协议形状不同的 Server → Edge 帧。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PoolFrame {
    Config(Box<PoolConfig>),
    Cutoff(PoolCutoff),
    Lease(PoolLease),
}

// ---------------------------------------------------------------------------
// config_applied
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplyResult {
    Applied,
    Rejected,
}

/// `config_applied.error.code` 的稳定取值。
pub mod apply_error {
    pub const INVALID_CONFIG: &str = "invalid_config";
    pub const MISSING_ROUTE_CREDENTIAL: &str = "missing_route_credential";
    pub const UNSUPPORTED_CAPABILITY: &str = "unsupported_capability";
    pub const CONFLICT: &str = "conflict";
    /// `conflict` 的 `detail.reason`：较低 revision。
    pub const STALE_REVISION: &str = "stale_revision";
    /// `invalid_config` 的 `detail.reason`：撤销修订倒退。
    pub const REVOCATION_REGRESSED: &str = "revocation_regressed";
}

// ---------------------------------------------------------------------------
// events / usage (Edge → Server)
// ---------------------------------------------------------------------------

pub mod event_kind {
    pub const ROUTE_DECISION: &str = "route_decision";
    pub const ROUTE_ATTEMPT: &str = "route_attempt";
    pub const ROUTE_SESSION_LINK: &str = "route_session_link";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionState {
    Planned,
    Completed,
    Failed,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkippedCandidate {
    pub deployment_id: String,
    pub reason: String,
}

/// `route_decision` 的 payload。首条修订冻结身份和计划，终态修订只带结果字段。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteDecision {
    pub request_id: String,
    pub decision_revision: u64,
    pub state: DecisionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_release_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ingress_protocol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_model_alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pool_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_version_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_order: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped: Option<Vec<SkippedCandidate>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_attempt_id: Option<String>,
    /// 无确切原生会话时为 `unlinked`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_association: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptOutcome {
    Started,
    NotSent,
    Completed,
    UpstreamRejected,
    Partial,
    Unknown,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteAttempt {
    pub request_id: String,
    pub attempt_id: String,
    pub attempt_no: u32,
    pub attempt_revision: u64,
    pub deployment_id: String,
    pub deployment_revision: u64,
    pub outcome: AttemptOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_token_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteSessionLink {
    pub request_id: String,
    pub launch_id: String,
    pub prior_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeasurementBasis {
    UpstreamUsage,
    PartialEstimate,
}

/// 选中新协议时的 `usage` 条目。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PoolUsageItem {
    #[serde(flatten)]
    pub base: UsageItem,
    pub deployment_id: String,
    pub deployment_revision: u64,
    pub attempt_id: String,
    pub rate_version_id: String,
    pub config_revision: u64,
    pub measurement_basis: MeasurementBasis,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ws::{ConfigApplied, EventItem, Events, Msg, UsageBatch};
    use serde_json::{Value, json};

    const FIXTURE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/routing/p0-ab.json"));

    fn wire(name: &str) -> Value {
        let v: Value = serde_json::from_str(FIXTURE).unwrap();
        v["wire"][name].clone()
    }

    /// 样例里的每个字段都原样出现在重新序列化的结果里。样例中的空数组、`false`、`null`
    /// 与“字段缺失”等价（各结构对这些缺省值跳过序列化）；结果可以多出旧协议的缺省字段。
    fn assert_covers(expected: &Value, actual: &Value, path: &str) {
        let empty =
            |v: &Value| matches!(v, Value::Null | Value::Bool(false)) || v.as_array().is_some_and(Vec::is_empty);
        match (expected, actual) {
            (Value::Object(e), Value::Object(a)) => {
                for (k, ev) in e {
                    let p = format!("{path}.{k}");
                    match a.get(k) {
                        Some(av) => assert_covers(ev, av, &p),
                        None => assert!(empty(ev), "{p} missing after roundtrip"),
                    }
                }
            }
            (Value::Array(e), Value::Array(a)) => {
                assert_eq!(e.len(), a.len(), "{path} length");
                for (i, (ev, av)) in e.iter().zip(a).enumerate() {
                    assert_covers(ev, av, &format!("{path}[{i}]"));
                }
            }
            _ => assert_eq!(expected, actual, "{path}"),
        }
    }

    /// 解析 → 序列化 → 覆盖样例 → 再解析得到相同值。
    fn roundtrip<T: Serialize + for<'de> Deserialize<'de> + PartialEq + std::fmt::Debug>(name: &str, v: Value) -> T {
        let parsed: T = serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
        let out = serde_json::to_value(&parsed).unwrap();
        assert_covers(&v, &out, name);
        let again: T = serde_json::from_value(out).unwrap();
        assert_eq!(parsed, again, "{name} reparse");
        parsed
    }

    #[test]
    fn hello_and_welcome_carry_capabilities() {
        let hello = roundtrip::<Msg>("hello", wire("hello"));
        let Msg::Hello(h) = hello else { panic!() };
        assert_eq!(h.capabilities, [ROUTE_POOL_V1]);
        assert_eq!(h.config_revision, 90);

        let welcome = roundtrip::<Msg>("welcome", wire("welcome"));
        let Msg::Welcome(w) = welcome else { panic!() };
        assert!(w.capabilities.iter().any(|c| c == ROUTE_POOL_V1));
    }

    #[test]
    fn legacy_hello_and_welcome_omit_capabilities() {
        let w: Msg = serde_json::from_value(json!({"type":"welcome","re":"m1","device_id":"d","user_id":"u",
            "tenant_id":"t","server_time":"2026-11-19T08:00:00Z","ack_seq":1,"heartbeat_ms":15000}))
        .unwrap();
        let Msg::Welcome(w) = w else { panic!() };
        assert!(w.capabilities.is_empty());
        let out = serde_json::to_value(Msg::Welcome(w)).unwrap();
        assert!(out.get("capabilities").is_none());

        let mut hello = wire("hello");
        hello.as_object_mut().unwrap().remove("capabilities");
        let Msg::Hello(h) = serde_json::from_value(hello).unwrap() else { panic!() };
        assert!(serde_json::to_value(Msg::Hello(h)).unwrap().get("capabilities").is_none());
    }

    #[test]
    fn config_v91_parses_as_pool_config() {
        let frame = roundtrip::<PoolFrame>("config", wire("config"));
        let PoolFrame::Config(c) = frame else { panic!() };
        assert_eq!(c.revision, 91);
        let rp = &c.route_pool;
        assert_eq!((rp.abi, rp.projection_id.as_str(), rp.signature_id.as_str()), (ROUTE_POOL_ABI, "prj_91", "sig_12"));
        assert_eq!(rp.revocation_revision, 3);
        assert_eq!(rp.pools[0].strategy, Strategy::Ordered);
        assert_eq!(
            (rp.pools[0].max_attempts, rp.pools[0].attempt_timeout_ms, rp.pools[0].total_timeout_ms),
            (2, 5000, 12000)
        );
        assert_eq!(rp.bindings[0].deployment_ids, ["dep_a", "dep_b"]);
        assert_eq!(rp.bindings[0].restricted_target_model_id, None);
        assert_eq!(rp.secrets.len(), 2);

        let a = &c.routes[0];
        assert_eq!((a.deployment_id.as_str(), a.deployment_revision, a.pool_revision, a.priority), ("dep_a", 3, 7, 10));
        assert_eq!(a.base.model_id, "mdl_m");
        assert_eq!(a.base.upstream_model.as_deref(), Some("vendor-a/m-20261121"));
        assert_eq!(a.availability.state, AvailabilityState::Eligible);
        assert_eq!(a.credential_ref, CredentialRef { credential_id: "cred_a".into(), credential_version: 1 });
        assert!(a.features.iter().all(|f| FEATURES.contains(&f.as_str())));

        let r = &c.rates[0];
        assert_eq!(r.rate_version_id, "rate_m_12");
        assert_eq!(r.input_multiplier_basis, INPUT_MULTIPLIER_BASIS);
        assert_eq!(r.input_multiplier_ppm, r.base.input_milli_per_mtok * 1000);
        assert_eq!(r.effective_until.as_deref(), Some("2026-12-01T00:00:00Z"));

        assert!(c.policy.secrets.is_empty());
        assert!(c.policy.runtime.as_ref().unwrap().failover);
    }

    #[test]
    fn legacy_parser_still_accepts_pool_frames() {
        let Msg::Config(c) = serde_json::from_value(wire("config")).unwrap() else { panic!() };
        assert_eq!((c.revision, c.routes.len(), c.rates.len()), (91, 2, 1));
        let Msg::Cutoff(c) = serde_json::from_value(wire("cutoff")).unwrap() else { panic!() };
        assert_eq!(c.reason, "contract");
        let Msg::Lease(l) = serde_json::from_value(wire("lease")).unwrap() else { panic!() };
        assert_eq!(l.lease_id, "lse_01");
    }

    #[test]
    fn unknown_server_enums_still_parse() {
        let mut v = wire("config");
        v["route_pool"]["pools"][0]["strategy"] = json!("from_the_future");
        v["routes"][0]["availability"]["state"] = json!("degraded");
        let PoolFrame::Config(c) = serde_json::from_value(v).unwrap() else { panic!() };
        assert_eq!(c.route_pool.pools[0].strategy, Strategy::Unknown);
        assert_eq!(c.routes[0].availability.state, AvailabilityState::Unknown);
    }

    #[test]
    fn pool_route_requires_pool_fields() {
        let mut v = wire("config");
        v["routes"][1].as_object_mut().unwrap().remove("credential_ref");
        assert!(serde_json::from_value::<PoolFrame>(v).is_err());
    }

    #[test]
    fn secret_debug_hides_material() {
        let PoolFrame::Config(c) = serde_json::from_value(wire("config")).unwrap() else { panic!() };
        let s = format!("{:?}", c.route_pool.secrets[0]);
        assert!(s.contains("cred_a") && !s.contains("<base64>"));
    }

    #[test]
    fn cutoff_targets_and_matching() {
        let PoolFrame::Cutoff(c) = roundtrip::<PoolFrame>("cutoff", wire("cutoff")) else { panic!() };
        assert_eq!(c.revocation_revision, Some(4));
        assert!(c.terminate_inflight);
        let t = &c.targets[0];
        let cred_a = CredentialRef { credential_id: "cred_a".into(), credential_version: 1 };
        let cred_b = CredentialRef { credential_id: "cred_b".into(), credential_version: 2 };
        assert!(t.matches("dep_a", &cred_a));
        assert!(!t.matches("dep_b", &cred_b));
        assert!(!t.matches("dep_a", &cred_b), "all listed fields must match");

        let by_credential =
            RevocationTarget { deployment_id: None, credential_id: Some("cred_b".into()), credential_version: Some(2) };
        assert!(by_credential.matches("dep_any", &cred_b));
        let malformed =
            RevocationTarget { deployment_id: None, credential_id: Some("cred_b".into()), credential_version: None };
        assert!(!malformed.is_well_formed() && !malformed.matches("dep_b", &cred_b));

        // 旧租户级 cutoff 在新类型下不带目标。
        let PoolFrame::Cutoff(legacy) =
            serde_json::from_value(json!({"type":"cutoff","id":"c1","reason":"balance"})).unwrap()
        else {
            panic!()
        };
        assert!(legacy.targets.is_empty() && legacy.revocation_revision.is_none() && !legacy.terminate_inflight);
    }

    #[test]
    fn lease_carries_signature() {
        let PoolFrame::Lease(l) = roundtrip::<PoolFrame>("lease", wire("lease")) else { panic!() };
        assert_eq!(l.signature_id.as_deref(), Some("sig_12"));
        assert_eq!(l.base.model_budgets["mdl_m"], 800);
    }

    #[test]
    fn route_events_have_typed_payloads() {
        let Msg::Events(Events { batch, .. }) = roundtrip::<Msg>("events", wire("events")) else { panic!() };
        let seqs: Vec<u64> = batch.iter().map(|e| e.seq).collect();
        assert_eq!(seqs, [701, 702, 703, 704, 705, 706]);
        let decode = |e: &EventItem| -> Value { e.payload.clone() };

        let planned: RouteDecision = serde_json::from_value(decode(&batch[0])).unwrap();
        assert_eq!(batch[0].kind, event_kind::ROUTE_DECISION);
        assert_eq!(planned.state, DecisionState::Planned);
        assert_eq!(planned.candidate_order.as_deref(), Some(&["dep_a".to_string(), "dep_b".to_string()][..]));
        assert_eq!(planned.skipped.as_deref(), Some(&[][..]));
        assert_covers(&batch[0].payload, &serde_json::to_value(&planned).unwrap(), "decision1");

        let attempts: Vec<RouteAttempt> =
            batch[1..5].iter().map(|e| serde_json::from_value(decode(e)).unwrap()).collect();
        assert!(batch[1..5].iter().all(|e| e.kind == event_kind::ROUTE_ATTEMPT));
        let outcomes: Vec<_> =
            attempts.iter().map(|a| (a.attempt_id.as_str(), a.attempt_revision, a.outcome)).collect();
        assert_eq!(
            outcomes,
            [
                ("att_01", 1, AttemptOutcome::Started),
                ("att_01", 2, AttemptOutcome::NotSent),
                ("att_02", 1, AttemptOutcome::Started),
                ("att_02", 2, AttemptOutcome::Completed),
            ]
        );
        assert_eq!(attempts[1].reason.as_deref(), Some("connect_failed"));
        for (a, e) in attempts.iter().zip(&batch[1..5]) {
            assert_covers(&e.payload, &serde_json::to_value(a).unwrap(), "attempt");
        }

        let done: RouteDecision = serde_json::from_value(decode(&batch[5])).unwrap();
        assert_eq!((done.decision_revision, done.state), (2, DecisionState::Completed));
        assert_eq!(done.final_attempt_id.as_deref(), Some("att_02"));
        assert_covers(&batch[5].payload, &serde_json::to_value(&done).unwrap(), "decision2");
    }

    #[test]
    fn usage_item_extends_legacy() {
        // 旧结构仍能读出公共字段（新字段被忽略；Edge 发送走 outbox 原始 JSON，不经旧结构）。
        let Msg::Usage(UsageBatch { batch, .. }) = serde_json::from_value(wire("usage")).unwrap() else { panic!() };
        assert_eq!(batch[0].cost_milli, 64);
        let raw = wire("usage")["batch"][0].clone();
        let item = roundtrip::<PoolUsageItem>("usage_item", raw);
        assert_eq!((item.deployment_id.as_str(), item.attempt_id.as_str()), ("dep_b", "att_02"));
        assert_eq!((item.rate_version_id.as_str(), item.config_revision), ("rate_m_12", 91));
        assert_eq!(item.measurement_basis, MeasurementBasis::UpstreamUsage);
        assert_eq!(item.base.model_id.as_deref(), Some("mdl_m"));
    }

    #[test]
    fn lease_renew_and_events_ack_unchanged() {
        roundtrip::<Msg>("lease_renew", wire("lease_renew"));
        roundtrip::<Msg>("events_ack", wire("events_ack"));
    }

    #[test]
    fn config_applied_results() {
        let Msg::ConfigApplied(ok) = roundtrip::<Msg>("config_applied_ok", wire("config_applied_ok")) else { panic!() };
        assert_eq!(ok.result, Some(ApplyResult::Applied));
        assert_eq!(ok.projection_id.as_deref(), Some("prj_91"));
        assert!(ok.error.is_none());

        let Msg::ConfigApplied(rej) = roundtrip::<Msg>("config_applied_rejected", wire("config_applied_rejected"))
        else {
            panic!()
        };
        assert_eq!(rej.result, Some(ApplyResult::Rejected));
        let err = rej.error.unwrap();
        assert_eq!(err.code, apply_error::MISSING_ROUTE_CREDENTIAL);
        assert_eq!(err.detail.unwrap()["deployment_id"], "dep_b");

        // 旧协议的应用证明不出现新字段。
        let legacy = ConfigApplied {
            id: "m1".into(),
            config_revision: 3,
            policy_revision: 2,
            projection_id: None,
            result: None,
            error: None,
        };
        assert_eq!(
            serde_json::to_value(Msg::ConfigApplied(legacy)).unwrap(),
            json!({"type":"config_applied","id":"m1","config_revision":3,"policy_revision":2})
        );
    }
}
