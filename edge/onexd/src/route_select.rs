//! `route_pool.v1` 的确定性候选选择（纯逻辑，本批不接入真实请求）。
//!
//! 输入是一份已应用的池快照、请求身份（精确 Agent 发行、入口协议、别名）、从入口请求推出的
//! 所需能力、可信时间和本地已落盘的撤销选择器。输出是冻结的绑定、池、费率和有序候选，或稳定
//! 的拒绝原因。顺序规则见 `contracts/routing-p0.md`：先按权限、协议、功能、版本、撤销和有效期
//! 筛选，再按 `priority` 升序、验证过的原生优先、`deployment_id` 字典序。

use std::collections::{BTreeSet, HashSet};

use onex_core::route_pool::{
    AvailabilityState, Binding, Pool, PoolConfig, PoolRate, PoolRoute, RevocationTarget, SkippedCandidate, Strategy,
};
use serde_json::Value;

use crate::pricing::parse_ms;

/// 能力词，取值与 `onex_core::route_pool::FEATURES` 一致。
pub mod feature {
    pub const TEXT: &str = "text";
    pub const STREAM: &str = "stream";
    pub const FUNCTION_TOOLS: &str = "function_tools";
    pub const IMAGES: &str = "images";
    pub const REASONING: &str = "reasoning";
    pub const JSON_SCHEMA: &str = "json_schema";
}

/// `skipped[].reason` 的取值。
pub mod skip {
    pub const ROUTE_MISSING: &str = "route_missing";
    pub const POOL_MISMATCH: &str = "pool_mismatch";
    pub const PROTOCOL_INCOMPATIBLE: &str = "protocol_incompatible";
    pub const UNSUPPORTED_FEATURE: &str = "unsupported_feature";
    pub const CONTEXT_TOO_LONG: &str = "context_too_long";
    pub const OUTPUT_TOO_LONG: &str = "output_too_long";
    pub const DEPLOYMENT_REVOKED: &str = "deployment_revoked";
    pub const CREDENTIAL_REVOKED: &str = "credential_revoked";
    pub const AVAILABILITY_BLOCKED: &str = "availability_blocked";
    pub const AVAILABILITY_EXPIRED: &str = "availability_expired";
    pub const ROUTE_EXPIRED: &str = "route_expired";
}

/// 一次逻辑请求的选路输入。
#[derive(Debug, Clone)]
pub struct Request<'a> {
    pub agent_release_id: &'a str,
    /// `anthropic`、`openai_responses` 或 `openai_chat`。
    pub ingress_protocol: &'a str,
    pub model_alias: &'a str,
    pub required_features: BTreeSet<&'static str>,
    pub estimated_input_tokens: u64,
    pub requested_output_tokens: Option<u64>,
}

/// 选路环境：可信时间、已落盘撤销、本 Edge 支持的转换器。
#[derive(Debug, Clone, Copy)]
pub struct Context<'a> {
    pub now_ms: i64,
    pub revocations: &'a [RevocationTarget],
    /// 已验证可用的 `(adapter_id, adapter_revision)`；非原生路由只有命中才参加排序。
    pub adapters: &'a [(&'a str, u64)],
}

#[derive(Debug, Clone, PartialEq)]
pub struct Plan<'a> {
    /// 实际执行的绑定。低余额降档时是替代目标的绑定。
    pub binding: &'a Binding,
    /// 降档时原先命中的绑定 ID。
    pub restricted_from: Option<&'a str>,
    pub pool: &'a Pool,
    pub rate: &'a PoolRate,
    /// 已排序的合格候选，执行时最多尝试 `pool.max_attempts` 个。
    pub candidates: Vec<&'a PoolRoute>,
    pub skipped: Vec<SkippedCandidate>,
}

impl Plan<'_> {
    pub fn candidate_order(&self) -> Vec<String> {
        self.candidates.iter().map(|r| r.deployment_id.clone()).collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectError {
    /// 本发行在快照中没有任何绑定。
    AgentNotAllowed,
    /// 发行有绑定，但入口或别名不匹配；或命中的绑定为空且没有可用替代目标。
    ModelNotAllowed,
    /// 同级同名命中多个绑定（Server 应拒绝发布，Edge 不猜）。
    AmbiguousBinding,
    /// 池快照已过 `route_pool.expires_at`，等 Server 同步。
    SnapshotExpired,
    PoolMissing,
    /// 当前时刻没有有效销售费率，停发该型号新请求。
    RateUnavailable,
    /// 池策略未协商或不认识。
    UnsupportedStrategy,
    /// 没有协议、功能和窗口都满足的部署。
    NoCompatibleRoute {
        skipped: Vec<SkippedCandidate>,
    },
    /// 有兼容部署，但全部撤销、停供或过期。
    NoAvailableUpstream {
        skipped: Vec<SkippedCandidate>,
    },
}

impl SelectError {
    /// 对外的稳定错误码；`snapshot_expired`、`rate_unavailable`、`pool_missing`、
    /// `unsupported_strategy` 是 Edge 提议，见进度报告。
    pub fn code(&self) -> &'static str {
        match self {
            SelectError::AgentNotAllowed => "agent_not_allowed",
            SelectError::ModelNotAllowed | SelectError::AmbiguousBinding => "model_not_allowed",
            SelectError::SnapshotExpired => "snapshot_expired",
            SelectError::PoolMissing => "pool_missing",
            SelectError::RateUnavailable => "rate_unavailable",
            SelectError::UnsupportedStrategy => "unsupported_strategy",
            SelectError::NoCompatibleRoute { .. } => "no_compatible_route",
            SelectError::NoAvailableUpstream { .. } => "no_available_upstream",
        }
    }
}

/// 别名命中的级别：精确 > 最长前缀 > 全局通配。
fn alias_rank(alias: &str, model: &str) -> Option<(u8, usize)> {
    if alias == "*" {
        Some((0, 0))
    } else if let Some(prefix) = alias.strip_suffix('*') {
        model.starts_with(prefix).then_some((1, prefix.len()))
    } else {
        (alias == model).then_some((2, alias.len()))
    }
}

fn match_binding<'a>(cfg: &'a PoolConfig, req: &Request<'_>) -> Result<&'a Binding, SelectError> {
    let mut of_release =
        cfg.route_pool.bindings.iter().filter(|b| b.agent_release_id == req.agent_release_id).peekable();
    if of_release.peek().is_none() {
        return Err(SelectError::AgentNotAllowed);
    }
    let mut best: Option<((u8, usize), &Binding)> = None;
    let mut tied = false;
    for b in of_release.filter(|b| b.ingress_protocol == req.ingress_protocol) {
        let Some(rank) = b.aliases.iter().filter_map(|a| alias_rank(a, req.model_alias)).max() else { continue };
        match &best {
            Some((r, _)) if *r > rank => {}
            Some((r, cur)) if *r == rank => tied |= cur.binding_id != b.binding_id,
            _ => {
                best = Some((rank, b));
                tied = false;
            }
        }
    }
    match best {
        None => Err(SelectError::ModelNotAllowed),
        Some(_) if tied => Err(SelectError::AmbiguousBinding),
        Some((_, b)) => Ok(b),
    }
}

/// 降档绑定只能转到同一发行、同一入口下已签且有部署的替代型号。
fn resolve_restricted<'a>(cfg: &'a PoolConfig, source: &'a Binding) -> Result<&'a Binding, SelectError> {
    let target = source.restricted_target_model_id.as_deref().ok_or(SelectError::ModelNotAllowed)?;
    let mut found = cfg.route_pool.bindings.iter().filter(|b| {
        b.agent_release_id == source.agent_release_id
            && b.ingress_protocol == source.ingress_protocol
            && b.model_id == target
            && !b.deployment_ids.is_empty()
    });
    match (found.next(), found.next()) {
        (Some(b), None) => Ok(b),
        (Some(_), Some(_)) => Err(SelectError::AmbiguousBinding),
        (None, _) => Err(SelectError::ModelNotAllowed),
    }
}

/// `[effective_from, effective_until)` 覆盖 `now` 的唯一费率；缺少起点视为无效。
fn current_rate<'a>(rates: &'a [PoolRate], model_id: &str, now: i64) -> Option<&'a PoolRate> {
    let mut hits = rates.iter().filter(|r| {
        r.base.model_id == model_id
            && r.base.effective_from.as_deref().and_then(parse_ms).is_some_and(|from| from <= now)
            && r.effective_until.as_deref().is_none_or(|until| parse_ms(until).is_some_and(|until| now < until))
    });
    match (hits.next(), hits.next()) {
        (Some(r), None) => Some(r),
        _ => None,
    }
}

/// 时间缺失或无法解析都按已过期处理。
fn still_valid(at: &str, now: i64) -> bool {
    parse_ms(at).is_some_and(|until| now < until)
}

enum Verdict {
    Eligible { native: bool },
    Incompatible(&'static str),
    Unavailable(&'static str),
}

fn judge(route: &PoolRoute, binding: &Binding, pool: &Pool, req: &Request<'_>, ctx: &Context<'_>) -> Verdict {
    if route.base.model_id != binding.model_id || route.pool_revision != pool.pool_revision {
        return Verdict::Incompatible(skip::POOL_MISMATCH);
    }
    let native = route.base.protocol == req.ingress_protocol;
    let converted = !native
        && route
            .adapter_id
            .as_deref()
            .zip(route.adapter_revision)
            .is_some_and(|(id, rev)| ctx.adapters.contains(&(id, rev)));
    if !native && !converted {
        return Verdict::Incompatible(skip::PROTOCOL_INCOMPATIBLE);
    }
    if !req.required_features.iter().all(|f| route.features.iter().any(|g| g == f)) {
        return Verdict::Incompatible(skip::UNSUPPORTED_FEATURE);
    }
    if route.max_context_tokens.is_some_and(|max| req.estimated_input_tokens > max) {
        return Verdict::Incompatible(skip::CONTEXT_TOO_LONG);
    }
    if req.requested_output_tokens.zip(route.max_output_tokens).is_some_and(|(want, max)| want > max) {
        return Verdict::Incompatible(skip::OUTPUT_TOO_LONG);
    }
    if let Some(hit) = ctx.revocations.iter().find(|t| t.matches(&route.deployment_id, &route.credential_ref)) {
        return Verdict::Unavailable(if hit.deployment_id.is_some() {
            skip::DEPLOYMENT_REVOKED
        } else {
            skip::CREDENTIAL_REVOKED
        });
    }
    if !matches!(route.availability.state, AvailabilityState::Eligible | AvailabilityState::Conditional) {
        return Verdict::Unavailable(skip::AVAILABILITY_BLOCKED);
    }
    if !still_valid(&route.valid_until, ctx.now_ms) {
        return Verdict::Unavailable(skip::ROUTE_EXPIRED);
    }
    if !still_valid(&route.availability.valid_until, ctx.now_ms) {
        return Verdict::Unavailable(skip::AVAILABILITY_EXPIRED);
    }
    Verdict::Eligible { native }
}

/// 在快照内为一次逻辑请求定序。不读写任何状态，同输入必得同输出。
pub fn select<'a>(cfg: &'a PoolConfig, req: &Request<'_>, ctx: &Context<'_>) -> Result<Plan<'a>, SelectError> {
    if !still_valid(&cfg.route_pool.expires_at, ctx.now_ms) {
        return Err(SelectError::SnapshotExpired);
    }
    let matched = match_binding(cfg, req)?;
    let (binding, restricted_from) = if matched.deployment_ids.is_empty() {
        (resolve_restricted(cfg, matched)?, Some(matched.binding_id.as_str()))
    } else {
        (matched, None)
    };
    let mut pools = cfg.route_pool.pools.iter().filter(|p| p.model_id == binding.model_id);
    let pool = match (pools.next(), pools.next()) {
        (Some(p), None) => p,
        _ => return Err(SelectError::PoolMissing),
    };
    if pool.strategy != Strategy::Ordered {
        return Err(SelectError::UnsupportedStrategy);
    }
    let rate = current_rate(&cfg.rates, &binding.model_id, ctx.now_ms).ok_or(SelectError::RateUnavailable)?;

    let mut seen = HashSet::new();
    let mut eligible = Vec::new();
    let mut skipped = Vec::new();
    let mut any_compatible = false;
    for id in binding.deployment_ids.iter().filter(|id| seen.insert(id.as_str())) {
        let mut skip_with =
            |reason: &str| skipped.push(SkippedCandidate { deployment_id: id.clone(), reason: reason.into() });
        let mut routes = cfg.routes.iter().filter(|r| &r.deployment_id == id);
        let (Some(route), None) = (routes.next(), routes.next()) else {
            skip_with(skip::ROUTE_MISSING);
            continue;
        };
        match judge(route, binding, pool, req, ctx) {
            Verdict::Eligible { native } => {
                any_compatible = true;
                eligible.push((route, native));
            }
            Verdict::Unavailable(reason) => {
                any_compatible = true;
                skip_with(reason);
            }
            Verdict::Incompatible(reason) => skip_with(reason),
        }
    }
    if eligible.is_empty() {
        return Err(if any_compatible {
            SelectError::NoAvailableUpstream { skipped }
        } else {
            SelectError::NoCompatibleRoute { skipped }
        });
    }
    eligible.sort_by(|(a, an), (b, bn)| (a.priority, !an, &a.deployment_id).cmp(&(b.priority, !bn, &b.deployment_id)));
    Ok(Plan {
        binding,
        restricted_from,
        pool,
        rate,
        candidates: eligible.into_iter().map(|(r, _)| r).collect(),
        skipped,
    })
}

fn has_items(v: &Value) -> bool {
    v.as_array().is_some_and(|a| !a.is_empty())
}

/// 在任意深度找某种内容块类型。
fn contains_block(v: &Value, types: &[&str]) -> bool {
    match v {
        Value::Object(o) => {
            o.get("type").and_then(Value::as_str).is_some_and(|t| types.contains(&t))
                || o.values().any(|x| contains_block(x, types))
        }
        Value::Array(a) => a.iter().any(|x| contains_block(x, types)),
        _ => false,
    }
}

/// 从入口实际请求推出所需能力。`text` 恒需要。
pub fn required_features(ingress_protocol: &str, body: &Value) -> BTreeSet<&'static str> {
    let mut need = BTreeSet::from([feature::TEXT]);
    if body.get("stream").and_then(Value::as_bool) == Some(true) {
        need.insert(feature::STREAM);
    }
    if body.get("tools").is_some_and(has_items) {
        need.insert(feature::FUNCTION_TOOLS);
    }
    match ingress_protocol {
        "openai_responses" => {
            if body.get("input").is_some_and(|i| contains_block(i, &["input_image"])) {
                need.insert(feature::IMAGES);
            }
            if body.get("reasoning").is_some_and(|r| !r.is_null()) {
                need.insert(feature::REASONING);
            }
            if body.pointer("/text/format/type").and_then(Value::as_str) == Some("json_schema") {
                need.insert(feature::JSON_SCHEMA);
            }
        }
        "openai_chat" => {
            if body.get("messages").is_some_and(|m| contains_block(m, &["image_url"])) {
                need.insert(feature::IMAGES);
            }
            if body.get("reasoning_effort").is_some_and(|r| !r.is_null()) {
                need.insert(feature::REASONING);
            }
            if body.pointer("/response_format/type").and_then(Value::as_str) == Some("json_schema") {
                need.insert(feature::JSON_SCHEMA);
            }
        }
        "anthropic" => {
            if body.get("messages").is_some_and(|m| contains_block(m, &["image"])) {
                need.insert(feature::IMAGES);
            }
            if body.get("thinking").and_then(|t| t.get("type")).and_then(Value::as_str) == Some("enabled") {
                need.insert(feature::REASONING);
            }
        }
        _ => {}
    }
    need
}

#[cfg(test)]
mod tests {
    use super::*;
    use onex_core::route_pool::PoolFrame;
    use serde_json::json;

    const FIXTURE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/routing/p0-ab.json"));

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    /// 样例配置 91；`edit` 在解析前改原始 JSON，方便构造反例。
    fn config_with(edit: impl FnOnce(&mut Value)) -> PoolConfig {
        let mut v = fixture()["wire"]["config"].clone();
        edit(&mut v);
        match serde_json::from_value(v).unwrap() {
            PoolFrame::Config(c) => *c,
            other => panic!("{other:?}"),
        }
    }

    fn config() -> PoolConfig {
        config_with(|_| {})
    }

    fn clock() -> i64 {
        parse_ms(fixture()["clock_utc"].as_str().unwrap()).unwrap()
    }

    fn req(features: &[&'static str]) -> Request<'static> {
        Request {
            agent_release_id: "rel_codex",
            ingress_protocol: "openai_responses",
            model_alias: "model-m",
            required_features: features.iter().copied().collect(),
            estimated_input_tokens: 10_000,
            requested_output_tokens: Some(2_000),
        }
    }

    fn ctx() -> Context<'static> {
        Context { now_ms: clock(), revocations: &[], adapters: &[] }
    }

    fn order(plan: &Plan<'_>) -> Vec<String> {
        plan.candidate_order()
    }

    fn skips(list: &[SkippedCandidate]) -> Vec<(&str, &str)> {
        list.iter().map(|s| (s.deployment_id.as_str(), s.reason.as_str())).collect()
    }

    #[test]
    fn fixture_a_then_b() {
        let cfg = config();
        let plan = select(&cfg, &req(&["text", "stream"]), &ctx()).unwrap();
        // 与样例 route_decision 的 candidate_order、binding、池、费率一致。
        let planned = &fixture()["wire"]["events"]["batch"][0]["payload"];
        assert_eq!(
            order(&plan),
            planned["candidate_order"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect::<Vec<_>>()
        );
        assert_eq!(plan.binding.binding_id, planned["binding_id"]);
        assert_eq!(plan.binding.binding_revision, planned["binding_revision"]);
        assert_eq!(plan.pool.pool_revision, planned["pool_revision"]);
        assert_eq!(plan.rate.rate_version_id, planned["rate_version_id"]);
        assert_eq!(plan.binding.model_id, planned["model_id"]);
        assert!(plan.skipped.is_empty() && plan.restricted_from.is_none());
        assert_eq!(plan.pool.max_attempts, 2);
        assert_eq!(plan.rate.input_multiplier_ppm, fixture()["pricing"]["signed_input_multiplier_ppm"]);
    }

    #[test]
    fn tool_request_excludes_b_without_tools() {
        let cfg = config_with(|v| v["routes"][1]["features"] = json!(["text", "stream"]));
        let body = json!({"model":"model-m","stream":true,"input":"hi","tools":[{"type":"function","name":"f"}]});
        let need = required_features("openai_responses", &body);
        assert!(need.contains(feature::FUNCTION_TOOLS));
        let plan = select(&cfg, &Request { required_features: need.clone(), ..req(&[]) }, &ctx()).unwrap();
        assert_eq!(order(&plan), ["dep_a"]);
        assert_eq!(skips(&plan.skipped), [("dep_b", skip::UNSUPPORTED_FEATURE)]);

        // 不带工具时 B 仍是备路。
        let plain = required_features("openai_responses", &json!({"model":"model-m","input":"hi"}));
        assert_eq!(
            order(&select(&cfg, &Request { required_features: plain, ..req(&[]) }, &ctx()).unwrap()),
            ["dep_a", "dep_b"]
        );

        // 两条都缺工具：没有兼容部署，不发请求。
        let none = config_with(|v| {
            v["routes"][0]["features"] = json!(["text"]);
            v["routes"][1]["features"] = json!(["text"]);
        });
        let err = select(&none, &Request { required_features: need, ..req(&[]) }, &ctx()).unwrap_err();
        assert_eq!(err.code(), "no_compatible_route");
        let SelectError::NoCompatibleRoute { skipped } = err else { panic!() };
        assert_eq!(skips(&skipped), [("dep_a", skip::UNSUPPORTED_FEATURE), ("dep_b", skip::UNSUPPORTED_FEATURE)]);
    }

    #[test]
    fn equal_priority_orders_native_then_deployment_id() {
        // 同优先级：按 deployment_id 字典序，与快照中出现顺序无关。
        let cfg = config_with(|v| {
            v["routes"][0]["priority"] = json!(10);
            v["routes"][1]["priority"] = json!(10);
            let routes = v["routes"].as_array_mut().unwrap();
            routes.reverse();
            v["route_pool"]["bindings"][0]["deployment_ids"] = json!(["dep_b", "dep_a"]);
        });
        assert_eq!(order(&select(&cfg, &req(&["text"]), &ctx()).unwrap()), ["dep_a", "dep_b"]);

        // 同优先级：验证过的原生排在转换路由之前，即使 ID 更大。
        let cfg = config_with(|v| {
            v["routes"][1]["priority"] = json!(10);
            v["routes"][0]["protocol"] = json!("openai_chat");
            v["routes"][0]["adapter_id"] = json!("responses_to_chat");
            v["routes"][0]["adapter_revision"] = json!(1);
        });
        let adapters = [("responses_to_chat", 1)];
        let with_adapter = Context { adapters: &adapters, ..ctx() };
        assert_eq!(order(&select(&cfg, &req(&["text"]), &with_adapter).unwrap()), ["dep_b", "dep_a"]);

        // 转换器未验证或版本不符时，转换路由不参加排序。
        let plan = select(&cfg, &req(&["text"]), &ctx()).unwrap();
        assert_eq!(order(&plan), ["dep_b"]);
        assert_eq!(skips(&plan.skipped), [("dep_a", skip::PROTOCOL_INCOMPATIBLE)]);
        let stale = [("responses_to_chat", 2)];
        assert_eq!(order(&select(&cfg, &req(&["text"]), &Context { adapters: &stale, ..ctx() }).unwrap()), ["dep_b"]);

        // 优先级数值小的先于原生性。
        let cfg = config_with(|v| v["routes"][1]["priority"] = json!(5));
        assert_eq!(order(&select(&cfg, &req(&["text"]), &ctx()).unwrap()), ["dep_b", "dep_a"]);
    }

    #[test]
    fn expiry_rules() {
        let cfg = config();
        let at = |s: &str| Context { now_ms: parse_ms(s).unwrap(), ..ctx() };

        // 路由有效期到 02:08（左闭右开），快照到 02:10。
        let err = select(&cfg, &req(&["text"]), &at("2026-11-22T02:08:00Z")).unwrap_err();
        let SelectError::NoAvailableUpstream { skipped } = err else { panic!("{err:?}") };
        assert_eq!(skips(&skipped), [("dep_a", skip::ROUTE_EXPIRED), ("dep_b", skip::ROUTE_EXPIRED)]);
        assert!(select(&cfg, &req(&["text"]), &at("2026-11-22T02:07:59.999Z")).is_ok());
        assert_eq!(
            select(&cfg, &req(&["text"]), &at("2026-11-22T02:10:00Z")).unwrap_err(),
            SelectError::SnapshotExpired
        );

        // 准入观察单独过期只影响该部署。
        let cfg = config_with(|v| v["routes"][0]["availability"]["valid_until"] = json!("2026-11-22T02:00:12Z"));
        let plan = select(&cfg, &req(&["text"]), &ctx()).unwrap();
        assert_eq!(order(&plan), ["dep_b"]);
        assert_eq!(skips(&plan.skipped), [("dep_a", skip::AVAILABILITY_EXPIRED)]);

        // 无法解析的时间按已过期处理。
        let cfg = config_with(|v| v["routes"][1]["valid_until"] = json!("soon"));
        assert_eq!(skips(&select(&cfg, &req(&["text"]), &ctx()).unwrap().skipped), [("dep_b", skip::ROUTE_EXPIRED)]);

        // 费率窗口外停发新请求。
        let cfg = config_with(|v| v["rates"][0]["effective_from"] = json!("2026-11-22T03:00:00Z"));
        assert_eq!(select(&cfg, &req(&["text"]), &ctx()).unwrap_err(), SelectError::RateUnavailable);
        let cfg = config_with(|v| v["rates"][0]["effective_until"] = json!("2026-11-22T02:00:12Z"));
        assert_eq!(select(&cfg, &req(&["text"]), &ctx()).unwrap_err().code(), "rate_unavailable");
    }

    #[test]
    fn unauthorized_requests() {
        let cfg = config();
        assert_eq!(
            select(&cfg, &Request { agent_release_id: "rel_other", ..req(&["text"]) }, &ctx()).unwrap_err(),
            SelectError::AgentNotAllowed
        );
        assert_eq!(
            select(&cfg, &Request { ingress_protocol: "anthropic", ..req(&["text"]) }, &ctx()).unwrap_err(),
            SelectError::ModelNotAllowed
        );
        assert_eq!(
            select(&cfg, &Request { model_alias: "model-x", ..req(&["text"]) }, &ctx()).unwrap_err(),
            SelectError::ModelNotAllowed
        );
        // routes[].model 不扩大权限：别名只从绑定解析。
        let cfg = config_with(|v| v["routes"][0]["model"] = json!("*"));
        assert_eq!(
            select(&cfg, &Request { model_alias: "model-x", ..req(&["text"]) }, &ctx()).unwrap_err().code(),
            "model_not_allowed"
        );
        // 空绑定没有运行权限。
        let cfg = config_with(|v| v["route_pool"]["bindings"][0]["deployment_ids"] = json!([]));
        assert_eq!(select(&cfg, &req(&["text"]), &ctx()).unwrap_err(), SelectError::ModelNotAllowed);
        // 绑定外的部署不会成为候选。
        let cfg = config_with(|v| v["route_pool"]["bindings"][0]["deployment_ids"] = json!(["dep_a"]));
        assert_eq!(order(&select(&cfg, &req(&["text"]), &ctx()).unwrap()), ["dep_a"]);
    }

    #[test]
    fn alias_precedence_exact_then_longest_prefix_then_wildcard() {
        let cfg = config_with(|v| {
            let base = v["route_pool"]["bindings"][0].clone();
            let mk = |id: &str, aliases: Value, deps: Value| {
                let mut b = base.clone();
                b["binding_id"] = json!(id);
                b["aliases"] = aliases;
                b["deployment_ids"] = deps;
                b
            };
            v["route_pool"]["bindings"] = json!([
                mk("bnd_star", json!(["*"]), json!(["dep_b"])),
                mk("bnd_short", json!(["model-*"]), json!(["dep_b"])),
                mk("bnd_long", json!(["model-m*"]), json!(["dep_a"])),
                mk("bnd_exact", json!(["model-m"]), json!(["dep_a", "dep_b"])),
            ]);
        });
        let pick = |alias: &'static str| select(&cfg, &Request { model_alias: alias, ..req(&["text"]) }, &ctx());
        assert_eq!(pick("model-m").unwrap().binding.binding_id, "bnd_exact");
        assert_eq!(pick("model-mini").unwrap().binding.binding_id, "bnd_long");
        assert_eq!(pick("model-x").unwrap().binding.binding_id, "bnd_short");
        assert_eq!(pick("other").unwrap().binding.binding_id, "bnd_star");

        // 同级同名命中两个绑定时不猜。
        let dup = config_with(|v| {
            let mut b = v["route_pool"]["bindings"][0].clone();
            b["binding_id"] = json!("bnd_dup");
            v["route_pool"]["bindings"].as_array_mut().unwrap().push(b);
        });
        assert_eq!(select(&dup, &req(&["text"]), &ctx()).unwrap_err(), SelectError::AmbiguousBinding);
    }

    #[test]
    fn version_and_availability_filters() {
        let cfg = config_with(|v| v["routes"][1]["pool_revision"] = json!(6));
        let plan = select(&cfg, &req(&["text"]), &ctx()).unwrap();
        assert_eq!(
            (order(&plan), skips(&plan.skipped)),
            (vec!["dep_a".to_string()], vec![("dep_b", skip::POOL_MISMATCH)])
        );

        let cfg = config_with(|v| v["routes"][0]["availability"]["state"] = json!("blocked"));
        assert_eq!(
            skips(&select(&cfg, &req(&["text"]), &ctx()).unwrap().skipped),
            [("dep_a", skip::AVAILABILITY_BLOCKED)]
        );
        let cfg = config_with(|v| v["routes"][0]["availability"]["state"] = json!("degraded"));
        assert_eq!(
            skips(&select(&cfg, &req(&["text"]), &ctx()).unwrap().skipped),
            [("dep_a", skip::AVAILABILITY_BLOCKED)]
        );
        let cfg = config_with(|v| v["routes"][0]["availability"]["state"] = json!("conditional"));
        assert_eq!(order(&select(&cfg, &req(&["text"]), &ctx()).unwrap()), ["dep_a", "dep_b"]);

        let cfg = config_with(|v| v["route_pool"]["bindings"][0]["deployment_ids"] = json!(["dep_a", "dep_z"]));
        assert_eq!(skips(&select(&cfg, &req(&["text"]), &ctx()).unwrap().skipped), [("dep_z", skip::ROUTE_MISSING)]);

        let cfg = config_with(|v| v["route_pool"]["pools"][0]["strategy"] = json!("weighted"));
        assert_eq!(select(&cfg, &req(&["text"]), &ctx()).unwrap_err(), SelectError::UnsupportedStrategy);
        let cfg = config_with(|v| v["route_pool"]["pools"] = json!([]));
        assert_eq!(select(&cfg, &req(&["text"]), &ctx()).unwrap_err(), SelectError::PoolMissing);
    }

    #[test]
    fn window_limits() {
        let cfg = config();
        let long = Request { estimated_input_tokens: 128_001, ..req(&["text"]) };
        let SelectError::NoCompatibleRoute { skipped } = select(&cfg, &long, &ctx()).unwrap_err() else { panic!() };
        assert!(skipped.iter().all(|s| s.reason == skip::CONTEXT_TOO_LONG));
        let big = Request { requested_output_tokens: Some(16_001), ..req(&["text"]) };
        let SelectError::NoCompatibleRoute { skipped } = select(&cfg, &big, &ctx()).unwrap_err() else { panic!() };
        assert!(skipped.iter().all(|s| s.reason == skip::OUTPUT_TOO_LONG));
    }

    #[test]
    fn revocation_targets_from_fixture_cutoff() {
        let cfg = config();
        let cutoff = fixture()["wire"]["cutoff"].clone();
        let PoolFrame::Cutoff(c) = serde_json::from_value(cutoff).unwrap() else { panic!() };
        let with = Context { revocations: &c.targets, ..ctx() };
        let plan = select(&cfg, &req(&["text"]), &with).unwrap();
        assert_eq!(order(&plan), ["dep_b"]);
        assert_eq!(skips(&plan.skipped), [("dep_a", skip::DEPLOYMENT_REVOKED)]);

        let by_cred = [RevocationTarget {
            deployment_id: None,
            credential_id: Some("cred_b".into()),
            credential_version: Some(2),
        }];
        let plan = select(&cfg, &req(&["text"]), &Context { revocations: &by_cred, ..ctx() }).unwrap();
        assert_eq!(skips(&plan.skipped), [("dep_b", skip::CREDENTIAL_REVOKED)]);

        // 全部撤销：有兼容部署但不可用。
        let mut all = c.targets.clone();
        all.extend(by_cred);
        let err = select(&cfg, &req(&["text"]), &Context { revocations: &all, ..ctx() }).unwrap_err();
        assert_eq!(err.code(), "no_available_upstream");
    }

    #[test]
    fn restricted_binding_redirects_to_signed_target() {
        let cfg = config_with(|v| {
            let mut target = v["route_pool"]["bindings"][0].clone();
            target["binding_id"] = json!("bnd_codex_lite");
            target["model_id"] = json!("mdl_lite");
            target["aliases"] = json!(["model-lite"]);
            target["deployment_ids"] = json!(["dep_lite"]);
            let src = &mut v["route_pool"]["bindings"][0];
            src["deployment_ids"] = json!([]);
            src["restricted_target_model_id"] = json!("mdl_lite");
            v["route_pool"]["bindings"].as_array_mut().unwrap().push(target);

            let mut route = v["routes"][1].clone();
            route["deployment_id"] = json!("dep_lite");
            route["model_id"] = json!("mdl_lite");
            route["pool_revision"] = json!(3);
            v["routes"] = json!([route]);
            let mut pool = v["route_pool"]["pools"][0].clone();
            pool["model_id"] = json!("mdl_lite");
            pool["pool_revision"] = json!(3);
            v["route_pool"]["pools"] = json!([pool]);
            let mut rate = v["rates"][0].clone();
            rate["model_id"] = json!("mdl_lite");
            rate["rate_version_id"] = json!("rate_lite_1");
            rate["model_display_name"] = json!("Lite");
            rate["input_multiplier_ppm"] = json!(1_000_000);
            rate["input_milli_per_mtok"] = json!(1000);
            v["rates"] = json!([rate]);
        });
        let plan = select(&cfg, &req(&["text"]), &ctx()).unwrap();
        assert_eq!(plan.restricted_from, Some("bnd_codex_m"));
        assert_eq!(plan.binding.binding_id, "bnd_codex_lite");
        assert_eq!(plan.rate.rate_version_id, "rate_lite_1");
        assert_eq!(order(&plan), ["dep_lite"]);

        // 替代目标没有本发行同入口的已签绑定时拒绝。
        let cfg = config_with(|v| {
            let src = &mut v["route_pool"]["bindings"][0];
            src["deployment_ids"] = json!([]);
            src["restricted_target_model_id"] = json!("mdl_lite");
        });
        assert_eq!(select(&cfg, &req(&["text"]), &ctx()).unwrap_err(), SelectError::ModelNotAllowed);
    }

    #[test]
    fn deterministic_for_same_input() {
        let cfg = config();
        let a = select(&cfg, &req(&["text", "stream"]), &ctx()).unwrap();
        let b = select(&cfg, &req(&["text", "stream"]), &ctx()).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn features_from_requests() {
        let set = |p: &str, b: Value| required_features(p, &b).into_iter().collect::<Vec<_>>();
        assert_eq!(set("openai_responses", json!({"input":"hi"})), ["text"]);
        assert_eq!(
            set(
                "openai_responses",
                json!({"stream":true,"tools":[{"type":"function"}],"reasoning":{"effort":"low"},
                    "text":{"format":{"type":"json_schema"}},
                    "input":[{"role":"user","content":[{"type":"input_image","image_url":"data:"}]}]})
            ),
            ["function_tools", "images", "json_schema", "reasoning", "stream", "text"]
        );
        assert_eq!(set("openai_responses", json!({"tools":[],"stream":false,"reasoning":null})), ["text"]);
        assert_eq!(
            set(
                "openai_chat",
                json!({"messages":[{"role":"user","content":[{"type":"image_url"}]}],
                "response_format":{"type":"json_schema"},"reasoning_effort":"low"})
            ),
            ["images", "json_schema", "reasoning", "text"]
        );
        assert_eq!(
            set(
                "anthropic",
                json!({"messages":[{"role":"user","content":[{"type":"image"}]}],
                "thinking":{"type":"enabled"},"tools":[{"name":"t"}]})
            ),
            ["function_tools", "images", "reasoning", "text"]
        );
        // 与契约能力词一致。
        for f in required_features(
            "openai_responses",
            &json!({"stream":true,"tools":[1],"reasoning":{},
            "text":{"format":{"type":"json_schema"}},"input":[{"type":"input_image"}]}),
        ) {
            assert!(onex_core::route_pool::FEATURES.contains(&f));
        }
    }
}
