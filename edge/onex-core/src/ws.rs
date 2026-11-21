//! Edge ↔ Server WebSocket 消息，对应 `contracts/edge-ws.md` v0。

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: &str = "0";
pub const WS_PATH: &str = "/v1/edge/ws";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Msg {
    Hello(Hello),
    Welcome(Welcome),
    Ping {
        id: String,
    },
    Pong {
        #[serde(default)]
        re: Option<String>,
    },
    Ack(Ack),

    // Server → Edge
    Config(Config),
    Secret(Secret),
    Lease(Lease),
    Cutoff(Cutoff),
    Diag(Diag),
    AgentCmd(AgentCmd),
    EventsAck(EventsAck),

    // Edge → Server
    Events(Events),
    Usage(UsageBatch),
    LeaseRenew(LeaseRenew),
    LeaseRequest(LeaseRequest),
    DiagResult(DiagResult),
    AgentState(AgentState),
    ConfigApplied(ConfigApplied),

    /// 不认识的 type。新版 Server 加消息时旧 Edge 不至于断线。
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Hello {
    #[serde(default)]
    pub agent_cache: bool,
    #[serde(default)]
    pub capability_contract_v1: bool,
    #[serde(default)]
    pub capability_policy_v2: bool,
    #[serde(default)]
    pub policy_runtime_v1: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub mac_desktop_v1: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub codex_desktop_v1: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub claude_desktop_v1: bool,
    pub id: String,
    pub edge_version: String,
    pub os: String,
    pub arch: String,
    pub config_revision: i64,
    pub lease_id: Option<String>,
    pub outbox_last_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Welcome {
    pub re: String,
    pub device_id: String,
    pub user_id: String,
    pub tenant_id: String,
    pub server_time: String,
    pub ack_seq: u64,
    pub heartbeat_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Ack {
    pub re: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub agent_cache: bool,
    pub id: String,
    pub revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_contract: Option<CapabilityContract>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<Policy>,
    #[serde(default)]
    pub routes: Vec<Route>,
    #[serde(default)]
    pub agents: Vec<AgentRelease>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolRelease>,
    #[serde(default)]
    pub rates: Vec<Rate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolRelease {
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: String,
    pub agents: Vec<String>,
    pub os: Option<String>,
    pub arch: Option<String>,
    pub entrypoint: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityContract {
    pub platform_revision: u64,
    pub tenant_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PolicyScopeRevision {
    pub id: String,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PolicyDisplayItem {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PolicyNotice {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub at: String,
    pub policy_revision: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BalanceMode {
    Normal,
    Warn,
    Restricted,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BalanceAlias {
    pub model: String,
    pub protocol: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BalanceRouting {
    pub mode: BalanceMode,
    pub aliases: Vec<BalanceAlias>,
}

/// Whitelisted, non-executable projection shared with the local status API.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PolicySummary {
    pub abi: u32,
    pub tenant_id: String,
    pub user_id: String,
    pub device_id: String,
    pub policy_revision: u64,
    pub platform_revision: u64,
    pub tenant_revision: Option<u64>,
    pub groups: Vec<PolicyScopeRevision>,
    pub member: Option<PolicyScopeRevision>,
    pub display: Vec<PolicyDisplayItem>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct PolicySecret {
    pub provider_id: String,
    pub key_id: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct RuntimeRules {
    #[serde(rename = "model.max_output_tokens")]
    pub max_output: Option<u64>,
    #[serde(rename = "rate.member_rpm")]
    pub requests_per_minute: Option<u64>,
    #[serde(rename = "rate.member_tpm")]
    pub tokens_per_minute: Option<u64>,
    #[serde(rename = "rate.member_concurrent")]
    pub member_concurrent: Option<u64>,
    #[serde(rename = "rate.key_concurrent")]
    pub key_concurrent: Option<u64>,
    #[serde(rename = "network.public")]
    pub public_egress: Option<bool>,
    #[serde(rename = "route.failover")]
    pub failover: bool,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct Policy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<RuntimeRules>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commerce_plan_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub search_tools: Vec<SearchTool>,
    #[serde(flatten)]
    pub summary: PolicySummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub balance: Option<BalanceRouting>,
    pub notices: Vec<PolicyNotice>,
    pub secrets: Vec<PolicySecret>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchTool {
    pub id: String,
    pub name: String,
    pub agents: Vec<String>,
}

impl std::fmt::Debug for Policy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Policy")
            .field("policy_revision", &self.summary.policy_revision)
            .field("keys", &self.secrets.len())
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConfigApplied {
    pub id: String,
    pub config_revision: i64,
    pub policy_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRelease {
    pub id: String,
    pub agent: String,
    pub version: String,
    pub os: String,
    pub arch: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Route {
    /// Agent 请求里的模型名。以 `*` 结尾时按前缀匹配，单独一个 `*` 匹配全部。
    pub model: String,
    /// 对应 `rates[].model_id`
    pub model_id: String,
    pub provider_id: String,
    /// 上游协议，S1 只支持 `anthropic`。
    pub protocol: String,
    /// 不含 `/v1/messages`，例如 `https://openrouter.ai/api`。
    pub base_url: String,
    /// 转发前把请求里的 `model` 换成这个值；为空时原样转发。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_model: Option<String>,
    #[serde(default)]
    pub auth: UpstreamAuth,
    /// `"none"` 直连，URL 用指定代理；不填时遵从环境变量代理。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<String>,
}

/// 单价，单位毫橡皮每百万 token。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rate {
    pub model_id: String,
    pub input_milli_per_mtok: u64,
    pub output_milli_per_mtok: u64,
    pub cache_read_milli_per_mtok: u64,
    pub cache_write_milli_per_mtok: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_from: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpstreamAuth {
    /// Anthropic 官方：`x-api-key: <key>`
    #[default]
    XApiKey,
    /// OpenRouter、Kimi 等兼容端点：`Authorization: Bearer <key>`
    Bearer,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Secret {
    pub id: String,
    pub provider_id: String,
    pub ciphertext: String,
    pub nonce: String,
    pub key_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Lease {
    pub id: String,
    /// 回应 lease_renew 时指向它的 id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub re: Option<String>,
    pub lease_id: String,
    pub expires_at: String,
    pub budget_milli: i64,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub model_budgets: std::collections::BTreeMap<String, i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commerce_plan_id: Option<String>,
    pub seq: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Cutoff {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub re: Option<String>,
    pub reason: String,
    /// 旧租约已在本次续租中结清（v0.13）。等于 Edge 当前租约时，Edge 丢弃该租约、
    /// 累计用量和续租快照，之后 `hello` 不再带 `lease_id`。缺省时维持 v0.5 行为：旧租约和快照保留。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settled_lease_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Diag {
    pub id: String,
    pub diag_id: String,
    pub kind: String,
    #[serde(default)]
    pub upload_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentCmd {
    pub id: String,
    pub agent: String,
    pub action: String,
}

/// 累计确认：所有 seq ≤ ack_seq 的 events 和 usage 都已持久化。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventsAck {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub re: Option<String>,
    pub ack_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Events {
    pub id: String,
    pub batch: Vec<EventItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventItem {
    pub seq: u64,
    pub session_id: String,
    pub kind: String,
    pub at: String,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageBatch {
    pub id: String,
    pub batch: Vec<UsageItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageItem {
    pub seq: u64,
    pub request_id: String,
    pub session_id: Option<String>,
    pub lease_id: Option<String>,
    pub provider_id: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cost_milli: i64,
    pub at: String,
    /// `ok`、`upstream_<HTTP 状态码>`、`upstream_error`、`client_cancelled`，
    /// 以及 Edge 断流的 `lease_exhausted`、`cutoff`（CONTRACT-PENDING）。
    pub status: String,
    /// false 表示流中断、用量不全，Server 记为待结算。
    pub complete: bool,
    // CONTRACT-PENDING: 契约 usage 只有 `model`，Edge 另带 `model_id`（对应 rates），便于 Server 按倍率核对。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeaseRenew {
    pub id: String,
    /// 幂等键：同一租约、同一用量的续租用同一个 op_id
    pub op_id: String,
    pub lease_id: String,
    /// 这个租约的累计已用额度（绝对值）
    pub used_milli: i64,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub model_used_milli: std::collections::BTreeMap<String, i64>,
}

/// 没有租约时申请新租约（v0.13）。Server 按签发规则回 `lease` 或 `cutoff`，不缓存结果，同一 `op_id` 可重发。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeaseRequest {
    pub id: String,
    pub op_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiagResult {
    pub id: String,
    pub diag_id: String,
    pub ok: bool,
    pub detail: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentState {
    pub id: String,
    pub agent: String,
    pub session_id: String,
    pub state: String,
    pub exit_code: Option<i32>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_contract_examples() {
        let hello: Msg = serde_json::from_value(
            json!({"type":"hello","id":"m1","edge_version":"0.1.0","os":"darwin","arch":"arm64",
            "config_revision":12,"lease_id":"lse_1","outbox_last_seq":4810}),
        )
        .unwrap();
        assert!(matches!(
            hello,
            Msg::Hello(Hello { outbox_last_seq: 4810, codex_desktop_v1: false, claude_desktop_v1: false, .. })
        ));
        let mut wire = serde_json::to_value(hello).unwrap();
        assert!(wire.get("codex_desktop_v1").is_none());
        assert!(wire.get("claude_desktop_v1").is_none());

        wire["claude_desktop_v1"] = json!(true);
        let claude_hello: Msg = serde_json::from_value(wire).unwrap();
        assert!(matches!(claude_hello, Msg::Hello(Hello { claude_desktop_v1: true, .. })));
        assert_eq!(serde_json::to_value(claude_hello).unwrap()["claude_desktop_v1"], true);

        let welcome: Msg = serde_json::from_value(
            json!({"type":"welcome","re":"m1","device_id":"dev_1","user_id":"usr_1","tenant_id":"ten_1",
            "server_time":"2026-11-19T08:00:00Z","ack_seq":4790,"heartbeat_ms":15000}),
        )
        .unwrap();
        assert!(matches!(welcome, Msg::Welcome(Welcome { ack_seq: 4790, heartbeat_ms: 15000, .. })));

        let ack: Msg = serde_json::from_value(json!({"type":"events_ack","ack_seq":7})).unwrap();
        assert!(matches!(ack, Msg::EventsAck(EventsAck { ack_seq: 7, .. })));
    }

    #[test]
    fn unknown_type_does_not_fail() {
        let m: Msg = serde_json::from_value(json!({"type":"from_the_future","id":"x","n":1})).unwrap();
        assert_eq!(m, Msg::Unknown);
    }

    #[test]
    fn serializes_with_type_tag() {
        let v = serde_json::to_value(Msg::Ping { id: "m3".into() }).unwrap();
        assert_eq!(v, json!({"type":"ping","id":"m3"}));
        let v = serde_json::to_value(Msg::Ack(Ack { re: "s1".into(), ok: true, error: None })).unwrap();
        assert_eq!(v, json!({"type":"ack","re":"s1","ok":true}));
    }

    #[test]
    fn cutoff_settled_lease_id_roundtrips() {
        let m: Msg = serde_json::from_value(
            json!({"type":"cutoff","id":"c1","re":"r1","reason":"balance","settled_lease_id":"lse_1"}),
        )
        .unwrap();
        let Msg::Cutoff(c) = m else { panic!() };
        assert_eq!(c.settled_lease_id.as_deref(), Some("lse_1"));

        // 缺省时解析为 None，序列化时不出现该字段
        let m: Msg = serde_json::from_value(json!({"type":"cutoff","id":"c2","reason":"disabled"})).unwrap();
        let Msg::Cutoff(c) = m else { panic!() };
        assert_eq!(c.settled_lease_id, None);
        let v = serde_json::to_value(Msg::Cutoff(c)).unwrap();
        assert!(v.get("settled_lease_id").is_none());
    }

    #[test]
    fn lease_request_roundtrips() {
        let m: Msg = serde_json::from_value(json!({"type":"lease_request","id":"m1","op_id":"lrq_1"})).unwrap();
        assert!(matches!(m, Msg::LeaseRequest(LeaseRequest { op_id, .. }) if op_id == "lrq_1"));
        let v =
            serde_json::to_value(Msg::LeaseRequest(LeaseRequest { id: "m2".into(), op_id: "lrq_2".into() })).unwrap();
        assert_eq!(v, json!({"type":"lease_request","id":"m2","op_id":"lrq_2"}));
    }

    #[test]
    fn route_defaults() {
        let r: Route = serde_json::from_value(json!({"model":"claude-*","model_id":"mdl_1","provider_id":"prv_1",
            "protocol":"anthropic","base_url":"https://example.invalid"}))
        .unwrap();
        assert_eq!(r.auth, UpstreamAuth::XApiKey);
        assert_eq!(r.upstream_model, None);
        assert_eq!(r.proxy, None);
    }

    #[test]
    fn config_with_rates() {
        let m: Msg = serde_json::from_value(json!({"type":"config","id":"c1","revision":3,"routes":[],"agents":[],
            "rates":[{"model_id":"mdl_1","input_milli_per_mtok":3000,"output_milli_per_mtok":15000,
            "cache_read_milli_per_mtok":300,"cache_write_milli_per_mtok":3750,"effective_from":"2026-11-01T00:00:00Z"}]}))
        .unwrap();
        let Msg::Config(c) = m else { panic!() };
        assert_eq!(c.rates[0].output_milli_per_mtok, 15000);
    }
}
