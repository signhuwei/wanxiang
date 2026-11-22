//! `route_pool.v1` 配置的设备暂存（`contracts/routing-pricing-and-staging.md`）。
//!
//! [`stage`] 是纯函数：输入认证会话身份、可信当前时间、设备私钥、已应用的配置身份和已知撤销修订，
//! 校验一份完整 `config` 并在内存解封推理信封。它不读写任何运行态，不发回执；本批也不接入 WS。
//! [`stage_with_state`] 只从 [`State`] 读取会话身份和设备私钥，供测试入口验证没有副作用。

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use onex_core::route_pool::{
    AvailabilityState, CredentialRef, FEATURES, INPUT_MULTIPLIER_BASIS, PoolConfig, PoolFrame, PoolRate,
    ROUTE_POOL_ABI, RouteSecret, Strategy, apply_error,
};
use onex_core::ws::ErrorBody;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::pricing::parse_ms;
use crate::secret::{DeviceKey, route_secret_aad};
use crate::state::State;

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
/// 契约未给平台上限，Edge 本地暂取 8（见进度报告）。
const MAX_ATTEMPTS: u32 = 8;
const MAX_RESOURCES: usize = 4096;
const MAX_CIPHERTEXT: usize = 16 * 1024;
const PROTOCOLS: [&str; 3] = ["anthropic", "openai_chat", "openai_responses"];
/// 本 Edge 已注册并验证的协议转换器 `(adapter_id, adapter_revision)`。首条联验只有原生
/// Responses，因此为空：任何非原生绑定或携带 adapter 引用的路由都被拒绝。
pub const SUPPORTED_ADAPTERS: [(&str, u64); 0] = [];

/// 认证会话确定的身份；帧内身份只用于比对，信封 AAD 取这里的值。
#[derive(Debug, Clone, Copy)]
pub struct Session<'a> {
    pub tenant_id: &'a str,
    pub user_id: &'a str,
    pub device_id: &'a str,
}

/// 已应用的配置身份及其有效内容摘要。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedIdentity {
    pub revision: u64,
    pub projection_id: String,
    pub digest: [u8; 32],
}

pub struct Input<'a> {
    pub session: Session<'a>,
    pub now_ms: i64,
    pub device_key: &'a DeviceKey,
    pub applied: Option<&'a AppliedIdentity>,
    /// 本地已落盘的最高撤销修订。
    pub revocation_revision: u64,
    /// 已注册的转换器；生产入口传 [`SUPPORTED_ADAPTERS`]。
    pub adapters: &'a [(&'a str, u64)],
}

/// 成员可见的生效模型标签。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelLabel {
    pub model_id: String,
    pub rate_version_id: String,
    pub display_name: String,
    pub input_multiplier_ppm: u64,
    /// 例如 `DeepSeek V4.1 Flash · 4×`。
    pub label: String,
}

/// 校验并解封后的暂存快照，只在内存。
pub struct Staged {
    pub identity: AppliedIdentity,
    pub policy_revision: u64,
    pub signature_id: String,
    pub expires_at_ms: i64,
    pub revocation_revision: u64,
    /// 同身份同内容的重封。
    pub resealed: bool,
    pub labels: Vec<ModelLabel>,
    pub config: PoolConfig,
    keys: HashMap<CredentialRef, Zeroizing<String>>,
}

impl Staged {
    pub fn key(&self, credential: &CredentialRef) -> Option<&str> {
        self.keys.get(credential).map(|k| k.as_str())
    }

    pub fn credentials(&self) -> BTreeSet<&CredentialRef> {
        self.keys.keys().collect()
    }
}

impl std::fmt::Debug for Staged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Staged")
            .field("identity", &self.identity)
            .field("resealed", &self.resealed)
            .field("labels", &self.labels)
            .field("credentials", &self.credentials())
            .finish_non_exhaustive()
    }
}

/// 稳定拒绝：`code` 是 `config_applied.error.code`，`reason` 进 `detail.reason`。`detail` 只含脱敏的定位字段。
#[derive(Debug, Clone, PartialEq)]
pub struct StageError {
    pub code: &'static str,
    pub reason: &'static str,
    pub detail: Map<String, Value>,
}

impl StageError {
    fn new(code: &'static str, reason: &'static str) -> Self {
        Self { code, reason, detail: Map::new() }
    }

    fn invalid(reason: &'static str) -> Self {
        Self::new(apply_error::INVALID_CONFIG, reason)
    }

    fn unsupported(reason: &'static str) -> Self {
        Self::new(apply_error::UNSUPPORTED_CAPABILITY, reason)
    }

    fn conflict(reason: &'static str) -> Self {
        Self::new(apply_error::CONFLICT, reason)
    }

    fn at(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.detail.insert(key.into(), value.into());
        self
    }

    pub fn to_error_body(&self) -> ErrorBody {
        let message = match self.code {
            apply_error::MISSING_ROUTE_CREDENTIAL => "新配置缺少可用的渠道凭据",
            apply_error::UNSUPPORTED_CAPABILITY => "设备不支持新配置要求的能力",
            apply_error::CONFLICT => "新配置与设备已应用的版本冲突",
            _ => "新配置无效",
        };
        let mut detail = self.detail.clone();
        detail.insert("reason".into(), self.reason.into());
        ErrorBody { code: self.code.into(), message: message.into(), detail: Some(Value::Object(detail)) }
    }
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

fn short_text(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

fn revision(value: u64) -> bool {
    (1..=MAX_SAFE_INTEGER).contains(&value)
}

fn valid_url(base: &str) -> bool {
    reqwest::Url::parse(base).is_ok_and(|url| {
        matches!(url.scheme(), "https" | "http")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
    })
}

/// 有效内容摘要：去掉帧 `id`，信封列表按 `routes[].credential_ref` 的唯一
/// `(credential_id, credential_version)` 排序重建，只保留凭据身份。实际收到的信封顺序、
/// 漏发、多发或重复不改变摘要，由后面的信封集合检查单独报错。
pub fn content_digest(config: &PoolConfig) -> [u8; 32] {
    let mut c = config.clone();
    c.id.clear();
    let refs: BTreeSet<&CredentialRef> = config.routes.iter().map(|r| &r.credential_ref).collect();
    c.route_pool.secrets = refs
        .into_iter()
        .map(|r| RouteSecret {
            credential_id: r.credential_id.clone(),
            credential_version: r.credential_version,
            key_id: String::new(),
            nonce: String::new(),
            ciphertext: String::new(),
        })
        .collect();
    Sha256::digest(serde_json::to_vec(&c).expect("typed config serializes")).into()
}

/// `ppm / 1e6`，最多三位小数，去掉末尾的零。
pub fn format_multiplier(ppm: u64) -> String {
    let (whole, milli) = (ppm / 1_000_000, (ppm % 1_000_000) / 1000);
    if milli == 0 {
        return whole.to_string();
    }
    format!("{whole}.{milli:03}").trim_end_matches('0').to_owned()
}

struct Window {
    from: i64,
    until: Option<i64>,
}

impl Window {
    fn covers(&self, now: i64) -> bool {
        self.from <= now && self.until.is_none_or(|until| now < until)
    }

    fn overlaps(&self, other: &Window) -> bool {
        self.until.is_none_or(|until| other.from < until) && other.until.is_none_or(|until| self.from < until)
    }
}

fn check_rate(rate: &PoolRate) -> Result<Window, StageError> {
    let at = |e: StageError| e.at("rate_version_id", rate.rate_version_id.as_str());
    if !identifier(&rate.rate_version_id) || !identifier(&rate.base.model_id) || !short_text(&rate.model_display_name) {
        return Err(at(StageError::invalid("malformed_rate")));
    }
    let base = &rate.base;
    if rate.input_multiplier_basis != INPUT_MULTIPLIER_BASIS
        || rate.input_multiplier_ppm > MAX_SAFE_INTEGER
        || !rate.input_multiplier_ppm.is_multiple_of(1000)
        || base.input_milli_per_mtok.checked_mul(1000) != Some(rate.input_multiplier_ppm)
        || [base.output_milli_per_mtok, base.cache_read_milli_per_mtok, base.cache_write_milli_per_mtok]
            .iter()
            .any(|v| *v > MAX_SAFE_INTEGER)
    {
        return Err(at(StageError::invalid("rate_mismatch")));
    }
    let from = base.effective_from.as_deref().and_then(parse_ms);
    let until = rate.effective_until.as_deref().map(parse_ms);
    match (from, until) {
        (Some(from), None) => Ok(Window { from, until: None }),
        (Some(from), Some(Some(until))) if from < until => Ok(Window { from, until: Some(until) }),
        _ => Err(at(StageError::invalid("rate_window_invalid"))),
    }
}

/// 校验一份完整 `route_pool.v1` config 并解封信封。不读写运行态。
pub fn stage(frame: &Value, input: &Input<'_>) -> Result<Staged, StageError> {
    let config = match serde_json::from_value::<PoolFrame>(frame.clone()) {
        Ok(PoolFrame::Config(c)) => *c,
        _ => return Err(StageError::invalid("malformed")),
    };
    let s = input.session;
    let rp = &config.route_pool;

    // 1. 版本、身份和配置身份。
    let config_revision = u64::try_from(config.revision).ok().filter(|r| revision(*r));
    let Some(config_revision) = config_revision else { return Err(StageError::invalid("malformed")) };
    if rp.abi != ROUTE_POOL_ABI {
        return Err(StageError::unsupported("route_pool_abi"));
    }
    let policy = &config.policy;
    if policy.summary.abi != 2 || policy.runtime.is_none() || !revision(policy.summary.policy_revision) {
        return Err(StageError::unsupported("policy_abi"));
    }
    if (policy.summary.tenant_id.as_str(), policy.summary.user_id.as_str(), policy.summary.device_id.as_str())
        != (s.tenant_id, s.user_id, s.device_id)
    {
        return Err(StageError::invalid("identity_mismatch"));
    }
    if !identifier(&rp.projection_id) || !identifier(&rp.signature_id) || rp.revocation_revision > MAX_SAFE_INTEGER {
        return Err(StageError::invalid("malformed"));
    }
    let digest = content_digest(&config);
    let identity = AppliedIdentity { revision: config_revision, projection_id: rp.projection_id.clone(), digest };
    let mut resealed = false;
    if let Some(applied) = input.applied {
        let at = |e: StageError| e.at("applied_config_revision", applied.revision);
        if config_revision < applied.revision {
            return Err(at(StageError::conflict(apply_error::STALE_REVISION)));
        }
        if config_revision == applied.revision {
            if rp.projection_id != applied.projection_id {
                return Err(at(StageError::conflict("projection_mismatch")));
            }
            if digest != applied.digest {
                return Err(at(StageError::conflict("content_changed")));
            }
            resealed = true;
        }
    }
    if rp.revocation_revision < input.revocation_revision {
        return Err(StageError::invalid(apply_error::REVOCATION_REGRESSED)
            .at("known_revocation_revision", input.revocation_revision));
    }
    let expires_at_ms = parse_ms(&rp.expires_at).ok_or_else(|| StageError::invalid("malformed"))?;
    if expires_at_ms <= input.now_ms {
        return Err(StageError::invalid("expired"));
    }
    if !policy.secrets.is_empty() {
        return Err(StageError::invalid("legacy_secrets"));
    }
    if [config.routes.len(), config.rates.len(), rp.bindings.len(), rp.pools.len(), rp.secrets.len()]
        .iter()
        .any(|n| *n > MAX_RESOURCES)
    {
        return Err(StageError::invalid("too_many_resources"));
    }

    // 2. 池。
    let mut pools = HashMap::new();
    for pool in &rp.pools {
        let at = |e: StageError| e.at("model_id", pool.model_id.as_str());
        if !identifier(&pool.model_id) || !revision(pool.pool_revision) {
            return Err(at(StageError::invalid("malformed_pool")));
        }
        if pool.strategy != Strategy::Ordered {
            return Err(at(StageError::unsupported("unsupported_strategy")));
        }
        if !(1..=MAX_ATTEMPTS).contains(&pool.max_attempts)
            || !(1..=MAX_SAFE_INTEGER).contains(&pool.attempt_timeout_ms)
            || !(pool.attempt_timeout_ms..=MAX_SAFE_INTEGER).contains(&pool.total_timeout_ms)
        {
            return Err(at(StageError::invalid("pool_limits")));
        }
        if pools.insert(pool.model_id.as_str(), pool).is_some() {
            return Err(at(StageError::invalid("duplicate_pool")));
        }
    }

    // 3. 部署路由。
    let mut routes = HashMap::new();
    for route in &config.routes {
        let at = |e: StageError| e.at("deployment_id", route.deployment_id.as_str());
        let r = &route.base;
        if !identifier(&route.deployment_id)
            || !identifier(&r.model_id)
            || !identifier(&r.provider_id)
            || !short_text(&r.model)
            || !revision(route.deployment_revision)
            || route.priority > MAX_SAFE_INTEGER
            || !identifier(&route.credential_ref.credential_id)
            || !revision(route.credential_ref.credential_version)
            || route.adapter_id.is_some() != route.adapter_revision.is_some()
            || route.adapter_id.as_deref().is_some_and(|id| !identifier(id))
            || route.adapter_revision.is_some_and(|rev| !revision(rev))
            || route.max_context_tokens.is_some_and(|v| v > MAX_SAFE_INTEGER)
            || route.max_output_tokens.is_some_and(|v| v > MAX_SAFE_INTEGER)
            || parse_ms(&route.valid_until).is_none()
            || parse_ms(&route.availability.observed_at).is_none()
            || parse_ms(&route.availability.valid_until).is_none()
            || !valid_url(&r.base_url)
        {
            return Err(at(StageError::invalid("malformed_route")));
        }
        if !PROTOCOLS.contains(&r.protocol.as_str()) {
            return Err(at(StageError::unsupported("unsupported_protocol")));
        }
        if route.availability.state == AvailabilityState::Unknown {
            return Err(at(StageError::unsupported("unknown_availability")));
        }
        if let Some(adapter) = route.adapter_id.as_deref().zip(route.adapter_revision)
            && !input.adapters.contains(&adapter)
        {
            return Err(at(StageError::unsupported("unregistered_adapter"))
                .at("adapter_id", adapter.0)
                .at("adapter_revision", adapter.1));
        }
        if let Some(f) = route.features.iter().find(|f| !FEATURES.contains(&f.as_str())) {
            return Err(at(StageError::unsupported("unknown_feature")).at("feature", f.as_str()));
        }
        match pools.get(r.model_id.as_str()) {
            Some(pool) if pool.pool_revision == route.pool_revision => {}
            _ => return Err(at(StageError::invalid("pool_mismatch"))),
        }
        if routes.insert(route.deployment_id.as_str(), route).is_some() {
            return Err(at(StageError::invalid("duplicate_deployment")));
        }
    }

    // 4. 绑定。
    let releases: HashSet<&str> = config.agents.iter().map(|a| a.id.as_str()).collect();
    let mut binding_ids = HashSet::new();
    let mut aliases = HashSet::new();
    let mut referenced = HashSet::new();
    let mut executable_models = BTreeSet::new();
    for b in &rp.bindings {
        let at = |e: StageError| e.at("binding_id", b.binding_id.as_str());
        if !identifier(&b.binding_id)
            || !revision(b.binding_revision)
            || !identifier(&b.model_id)
            || b.aliases.is_empty()
            || !b.aliases.iter().all(|a| short_text(a))
        {
            return Err(at(StageError::invalid("malformed_binding")));
        }
        if !binding_ids.insert(b.binding_id.as_str()) {
            return Err(at(StageError::invalid("duplicate_binding")));
        }
        if !releases.contains(b.agent_release_id.as_str()) {
            return Err(at(StageError::invalid("unknown_release")));
        }
        if !PROTOCOLS.contains(&b.ingress_protocol.as_str()) {
            return Err(at(StageError::unsupported("unsupported_protocol")));
        }
        for alias in &b.aliases {
            if !aliases.insert((b.agent_release_id.as_str(), b.ingress_protocol.as_str(), alias.as_str())) {
                return Err(at(StageError::invalid("ambiguous_alias")).at("alias", alias.as_str()));
            }
        }
        if b.deployment_ids.is_empty() {
            let target = b.restricted_target_model_id.as_deref();
            let signed = target.is_some_and(|t| {
                t != b.model_id
                    && rp.bindings.iter().any(|o| {
                        o.agent_release_id == b.agent_release_id
                            && o.ingress_protocol == b.ingress_protocol
                            && o.model_id == t
                            && !o.deployment_ids.is_empty()
                    })
            });
            if target.is_some() && !signed {
                return Err(at(StageError::invalid("restricted_target_unsigned")));
            }
            continue;
        }
        if b.restricted_target_model_id.is_some() {
            return Err(at(StageError::invalid("restricted_target_with_routes")));
        }
        let mut seen = HashSet::new();
        for id in &b.deployment_ids {
            if !seen.insert(id.as_str()) {
                return Err(at(StageError::invalid("duplicate_deployment")).at("deployment_id", id.as_str()));
            }
            let route = match routes.get(id.as_str()) {
                Some(route) if route.base.model_id == b.model_id => route,
                _ => return Err(at(StageError::invalid("unresolved_deployment")).at("deployment_id", id.as_str())),
            };
            // 非原生协议只能经已注册的转换器承接（注册检查已在路由阶段完成）。
            if route.base.protocol != b.ingress_protocol && route.adapter_id.is_none() {
                return Err(
                    at(StageError::unsupported("protocol_mismatch_without_adapter")).at("deployment_id", id.as_str())
                );
            }
            referenced.insert(id.as_str());
        }
        executable_models.insert(b.model_id.as_str());
    }
    if let Some(orphan) = config.routes.iter().find(|r| !referenced.contains(r.deployment_id.as_str())) {
        return Err(StageError::invalid("orphan_route").at("deployment_id", orphan.deployment_id.as_str()));
    }

    // 5. 费率：基准与倍率一致、窗口不重叠、可执行型号当前有价。
    let mut windows: BTreeMap<&str, Vec<(Window, &PoolRate)>> = BTreeMap::new();
    let mut rate_ids = HashSet::new();
    for rate in &config.rates {
        let window = check_rate(rate)?;
        let at = |e: StageError| e.at("rate_version_id", rate.rate_version_id.as_str());
        if !rate_ids.insert(rate.rate_version_id.as_str()) {
            return Err(at(StageError::invalid("duplicate_rate")));
        }
        if !executable_models.contains(rate.base.model_id.as_str()) {
            return Err(at(StageError::invalid("rate_unreferenced")));
        }
        let list = windows.entry(rate.base.model_id.as_str()).or_default();
        if list.iter().any(|(w, _)| w.overlaps(&window)) {
            return Err(at(StageError::invalid("rate_overlap")));
        }
        list.push((window, rate));
    }
    let mut labels = Vec::new();
    for model in &executable_models {
        let current = windows.get(model).and_then(|list| list.iter().find(|(w, _)| w.covers(input.now_ms)));
        let Some((_, rate)) = current else {
            return Err(StageError::invalid("rate_missing").at("model_id", *model));
        };
        labels.push(ModelLabel {
            model_id: rate.base.model_id.clone(),
            rate_version_id: rate.rate_version_id.clone(),
            display_name: rate.model_display_name.clone(),
            input_multiplier_ppm: rate.input_multiplier_ppm,
            label: format!("{} · {}×", rate.model_display_name, format_multiplier(rate.input_multiplier_ppm)),
        });
    }

    // 6. 信封：每个精确凭据引用恰好一个信封，不多不少，全部能解开。
    let needed: BTreeMap<&CredentialRef, &str> =
        config.routes.iter().map(|r| (&r.credential_ref, r.deployment_id.as_str())).collect();
    let mut envelopes = HashMap::new();
    for secret in &rp.secrets {
        let cred = CredentialRef {
            credential_id: secret.credential_id.clone(),
            credential_version: secret.credential_version,
        };
        let at = |e: StageError| {
            e.at("credential_id", secret.credential_id.as_str()).at("credential_version", secret.credential_version)
        };
        if !identifier(&secret.credential_id)
            || !revision(secret.credential_version)
            || secret.ciphertext.len() > MAX_CIPHERTEXT
        {
            return Err(at(StageError::invalid("malformed_envelope")));
        }
        if !needed.contains_key(&cred) {
            return Err(at(StageError::invalid("extra_envelope")));
        }
        if envelopes.insert(cred, secret).is_some() {
            return Err(at(StageError::invalid("duplicate_envelope")));
        }
    }
    if let Some((cred, deployment)) = needed.iter().find(|(cred, _)| !envelopes.contains_key(**cred)) {
        return Err(StageError::new(apply_error::MISSING_ROUTE_CREDENTIAL, "missing_envelope")
            .at("deployment_id", *deployment)
            .at("credential_id", cred.credential_id.as_str())
            .at("credential_version", cred.credential_version));
    }
    let mut keys = HashMap::new();
    for (cred, secret) in envelopes {
        let aad = route_secret_aad(
            s.tenant_id,
            s.device_id,
            &rp.projection_id,
            config_revision,
            &cred.credential_id,
            cred.credential_version,
        );
        let plain = input
            .device_key
            .open_route(&aad, &secret.key_id, &secret.nonce, &secret.ciphertext)
            .ok()
            .filter(|k| !k.is_empty())
            .ok_or_else(|| {
                StageError::invalid("envelope_rejected")
                    .at("credential_id", cred.credential_id.as_str())
                    .at("credential_version", cred.credential_version)
            })?;
        keys.insert(cred, plain);
    }

    Ok(Staged {
        identity,
        policy_revision: policy.summary.policy_revision,
        signature_id: rp.signature_id.clone(),
        expires_at_ms,
        revocation_revision: rp.revocation_revision,
        resealed,
        labels,
        keys,
        config,
    })
}

/// 测试入口：从 `State` 读取认证会话身份和设备私钥，只读。没有会话身份时拒绝。
pub fn stage_with_state(
    state: &State,
    frame: &Value,
    now_ms: i64,
    applied: Option<&AppliedIdentity>,
    revocation_revision: u64,
) -> Result<Staged, StageError> {
    let (tenant, user, device) = {
        let c = state.conn.lock().unwrap();
        (c.tenant_id.clone(), c.user_id.clone(), c.device_id.clone())
    };
    let (Some(tenant_id), Some(user_id), Some(device_id)) = (tenant, user, device) else {
        return Err(StageError::invalid("no_session"));
    };
    let session = Session { tenant_id: &tenant_id, user_id: &user_id, device_id: &device_id };
    let adapters = &SUPPORTED_ADAPTERS;
    stage(frame, &Input { session, now_ms, device_key: &state.device_key, applied, revocation_revision, adapters })
}

/// 供诊断：脱敏的暂存摘要，不含密钥、URL 和采购数据。
pub fn summary(staged: &Staged) -> Value {
    json!({
        "config_revision": staged.identity.revision,
        "projection_id": staged.identity.projection_id,
        "policy_revision": staged.policy_revision,
        "signature_id": staged.signature_id,
        "revocation_revision": staged.revocation_revision,
        "resealed": staged.resealed,
        "credentials": staged.credentials().len(),
        "labels": staged.labels.iter().map(|l| &l.label).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 对样例配置做一处修改，配上期望的拒绝原因。
    type Case<'a> = (&'a dyn Fn(&mut Value), &'a str);
    use crate::pricing::{Tokens, cost_milli};
    use crate::secret::seal_route_for_test;
    use std::sync::atomic::{AtomicU8, Ordering};
    use x25519_dalek::{PublicKey, StaticSecret};

    const FIXTURE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/routing/p0-ab.json"));
    // 契约跨语言向量：(ten_demo, dev_lin, prj_91, 91, cred_a, 1)。
    const VECTOR: (&str, &str, &str) = (
        "MdSras7slhE3kXA3k25gcW+sVzr+lNnahKgCBEjfwRI=",
        "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX",
        "fp1Fke4jFdKim93jA03oMTHhmAJmfFP4SJR5swErN1Rsv1DzXg==",
    );
    const SESSION: Session<'static> = Session { tenant_id: "ten_demo", user_id: "usr_lin", device_id: "dev_lin" };

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    fn now() -> i64 {
        parse_ms(fixture()["clock_utc"].as_str().unwrap()).unwrap()
    }

    fn device() -> DeviceKey {
        DeviceKey::from_bytes([7; 32])
    }

    /// 每次封装换一个 nonce 和临时密钥，模拟 Server 重封。
    fn seal(
        tenant: &str,
        device: &str,
        projection: &str,
        revision: u64,
        cred: &str,
        version: u64,
        plain: &str,
    ) -> Value {
        static N: AtomicU8 = AtomicU8::new(1);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let public = PublicKey::from(&StaticSecret::from([7u8; 32])).to_bytes();
        let aad = route_secret_aad(tenant, device, projection, revision, cred, version);
        let (key_id, nonce, ciphertext) = seal_route_for_test(&public, [n.wrapping_add(16); 32], [n; 24], &aad, plain);
        json!({"credential_id":cred,"credential_version":version,"key_id":key_id,"nonce":nonce,"ciphertext":ciphertext})
    }

    /// 按帧内身份重新封装全部信封。
    fn reseal(frame: &mut Value) {
        let policy = frame["policy"].clone();
        let (tenant, device) = (policy["tenant_id"].as_str().unwrap(), policy["device_id"].as_str().unwrap());
        let projection = frame["route_pool"]["projection_id"].as_str().unwrap().to_owned();
        let revision = frame["revision"].as_u64().unwrap();
        let sealed: Vec<Value> = frame["route_pool"]["secrets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| {
                let (cred, version) = (s["credential_id"].as_str().unwrap(), s["credential_version"].as_u64().unwrap());
                seal(tenant, device, &projection, revision, cred, version, &format!("key-{cred}-{version}"))
            })
            .collect();
        frame["route_pool"]["secrets"] = json!(sealed);
    }

    /// 样例配置 91：`cred_a` 用契约向量，`cred_b` 用测试封装。
    fn frame() -> Value {
        let mut f = fixture()["wire"]["config"].clone();
        let (key_id, nonce, ciphertext) = VECTOR;
        f["route_pool"]["secrets"] = json!([
            {"credential_id":"cred_a","credential_version":1,"key_id":key_id,"nonce":nonce,"ciphertext":ciphertext},
            seal("ten_demo", "dev_lin", "prj_91", 91, "cred_b", 2, "key-cred_b-2"),
        ]);
        f
    }

    fn input<'a>(key: &'a DeviceKey) -> Input<'a> {
        Input { session: SESSION, now_ms: now(), device_key: key, applied: None, revocation_revision: 0, adapters: &[] }
    }

    #[test]
    fn digest_ignores_envelope_order_and_omissions() {
        let key = device();
        let applied = stage(&frame(), &input(&key)).unwrap().identity;
        let digest = |f: &Value| match serde_json::from_value::<PoolFrame>(f.clone()).unwrap() {
            PoolFrame::Config(c) => content_digest(&c),
            _ => unreachable!(),
        };
        let mut reversed = frame();
        reversed["route_pool"]["secrets"].as_array_mut().unwrap().reverse();
        let mut missing = frame();
        missing["route_pool"]["secrets"].as_array_mut().unwrap().pop();
        let mut extra = frame();
        let stray = seal("ten_demo", "dev_lin", "prj_91", 91, "cred_z", 1, "z");
        extra["route_pool"]["secrets"].as_array_mut().unwrap().push(stray);
        let mut doubled = frame();
        let copy = doubled["route_pool"]["secrets"][0].clone();
        doubled["route_pool"]["secrets"].as_array_mut().unwrap().push(copy);
        for f in [&reversed, &missing, &extra, &doubled] {
            assert_eq!(digest(f), applied.digest);
        }

        let with = Input { applied: Some(&applied), ..input(&key) };
        // 顺序不同：仍是同内容重封。
        assert!(stage(&reversed, &with).unwrap().resealed);
        // 同版漏发：报缺凭据，不报 conflict。
        let e = stage(&missing, &with).unwrap_err();
        assert_eq!((e.code, e.reason), (apply_error::MISSING_ROUTE_CREDENTIAL, "missing_envelope"));
        assert_eq!(e.detail["credential_id"], "cred_b");
        // 同版多发或重复：报信封集合错误，不报 conflict。
        assert_eq!(rejects(&extra, &with), (apply_error::INVALID_CONFIG, "extra_envelope"));
        assert_eq!(rejects(&doubled, &with), (apply_error::INVALID_CONFIG, "duplicate_envelope"));
        // 首次下发时同样。
        assert_eq!(rejects(&missing, &input(&key)).0, apply_error::MISSING_ROUTE_CREDENTIAL);
    }

    #[test]
    fn bindings_require_native_protocol_or_registered_adapter() {
        let key = device();
        // 原生 Responses 是首条联验路径，无需转换器。
        assert!(stage(&frame(), &input(&key)).is_ok());

        // 入口与部署协议不同，又没有转换器。
        let mut mismatch = frame();
        mismatch["routes"][1]["protocol"] = json!("openai_chat");
        let e = stage(&mismatch, &input(&key)).unwrap_err();
        assert_eq!((e.code, e.reason), (apply_error::UNSUPPORTED_CAPABILITY, "protocol_mismatch_without_adapter"));
        assert_eq!((&e.detail["binding_id"], &e.detail["deployment_id"]), (&json!("bnd_codex_m"), &json!("dep_b")));

        // 带转换器引用但本 Edge 没有注册：生产入口为空注册表，一律拒绝。
        let mut converted = mismatch.clone();
        converted["routes"][1]["adapter_id"] = json!("responses_to_chat");
        converted["routes"][1]["adapter_revision"] = json!(1);
        let e = stage(&converted, &input(&key)).unwrap_err();
        assert_eq!((e.code, e.reason), (apply_error::UNSUPPORTED_CAPABILITY, "unregistered_adapter"));
        assert_eq!(e.detail["adapter_id"], "responses_to_chat");
        // 原生路由附带未注册的转换器引用同样拒绝。
        let mut native_with_ref = frame();
        native_with_ref["routes"][0]["adapter_id"] = json!("responses_to_chat");
        native_with_ref["routes"][0]["adapter_revision"] = json!(1);
        assert_eq!(
            rejects(&native_with_ref, &input(&key)),
            (apply_error::UNSUPPORTED_CAPABILITY, "unregistered_adapter")
        );
        // 版本不符也算未注册。
        let registered = [("responses_to_chat", 2)];
        let wrong_rev = Input { adapters: &registered, ..input(&key) };
        assert_eq!(rejects(&converted, &wrong_rev).1, "unregistered_adapter");
        // 注册表命中时才接受（为后续批次保留的形状）。
        let registered = [("responses_to_chat", 1)];
        assert!(stage(&converted, &Input { adapters: &registered, ..input(&key) }).is_ok());
        // 生产入口使用空注册表，同一帧被拒。
        let state = State { device_key: device(), ..Default::default() };
        {
            let mut c = state.conn.lock().unwrap();
            (c.tenant_id, c.user_id, c.device_id) =
                (Some("ten_demo".into()), Some("usr_lin".into()), Some("dev_lin".into()));
        }
        assert_eq!(stage_with_state(&state, &converted, now(), None, 0).unwrap_err().reason, "unregistered_adapter");
    }

    fn rejects(frame: &Value, input: &Input<'_>) -> (&'static str, &'static str) {
        let e = stage(frame, input).expect_err("expected rejection");
        (e.code, e.reason)
    }

    #[test]
    fn fixture_v91_stages_with_4x_label_and_both_keys() {
        let key = device();
        let staged = stage(&frame(), &input(&key)).unwrap();
        assert_eq!((staged.identity.revision, staged.identity.projection_id.as_str()), (91, "prj_91"));
        assert_eq!((staged.policy_revision, staged.signature_id.as_str(), staged.resealed), (21, "sig_12", false));
        let cred = |id: &str, v| CredentialRef { credential_id: id.into(), credential_version: v };
        assert_eq!(staged.key(&cred("cred_a", 1)), Some("fixture-inference-key"));
        assert_eq!(staged.key(&cred("cred_b", 2)), Some("key-cred_b-2"));
        assert_eq!(staged.credentials().len(), 2);

        // 标签和价格都来自同一条已签费率，并与上游定价字段一致。
        let pricing = &fixture()["pricing"];
        assert_eq!(staged.labels.len(), 1);
        let label = &staged.labels[0];
        assert_eq!(label.label, "DeepSeek V4.1 Flash · 4×");
        assert_eq!((label.model_id.as_str(), label.rate_version_id.as_str()), ("mdl_m", "rate_m_12"));
        assert_eq!(label.input_multiplier_ppm, pricing["signed_input_multiplier_ppm"].as_u64().unwrap());
        let rate = &staged.config.rates[0].base;
        assert_eq!(rate.input_milli_per_mtok * 1000, label.input_multiplier_ppm);
        let usage = Tokens { input: 10_000, output: 2_000, ..Default::default() };
        assert_eq!(cost_milli(rate, &usage), pricing["sales_cost_milli"].as_i64().unwrap());

        // 调试输出和诊断摘要不含密钥或信封。
        let debug = format!("{staged:?}");
        assert!(!debug.contains("fixture-inference-key") && !debug.contains(VECTOR.2));
        let summary = summary(&staged).to_string();
        assert!(!summary.contains("fixture-inference-key") && !summary.contains("example.test"));
        assert!(summary.contains("DeepSeek V4.1 Flash · 4×"));
    }

    #[test]
    fn reseal_same_semantics_is_accepted() {
        let key = device();
        let first = stage(&frame(), &input(&key)).unwrap();
        let mut again = frame();
        again["id"] = json!("cfg91_resend");
        reseal(&mut again);
        assert_ne!(again["route_pool"]["secrets"], frame()["route_pool"]["secrets"]);
        let staged = stage(&again, &Input { applied: Some(&first.identity), ..input(&key) }).unwrap();
        assert!(staged.resealed);
        assert_eq!(staged.identity, first.identity);
        assert_eq!(
            staged.key(&CredentialRef { credential_id: "cred_a".into(), credential_version: 1 }),
            Some("key-cred_a-1")
        );
    }

    #[test]
    fn same_revision_conflicts() {
        let key = device();
        let applied = stage(&frame(), &input(&key)).unwrap().identity;
        let with = Input { applied: Some(&applied), ..input(&key) };

        let mut other_projection = frame();
        other_projection["route_pool"]["projection_id"] = json!("prj_92");
        reseal(&mut other_projection);
        assert_eq!(rejects(&other_projection, &with), (apply_error::CONFLICT, "projection_mismatch"));

        let mut binding = frame();
        binding["route_pool"]["bindings"][0]["aliases"] = json!(["model-m", "model-m2"]);
        assert_eq!(rejects(&binding, &with), (apply_error::CONFLICT, "content_changed"));

        let mut rate = frame();
        rate["rates"][0]["output_milli_per_mtok"] = json!(13000);
        assert_eq!(rejects(&rate, &with), (apply_error::CONFLICT, "content_changed"));

        // 改凭据版本也算内容变化（信封字节之外的凭据引用参与摘要）。
        let mut cred = frame();
        cred["routes"][1]["credential_ref"]["credential_version"] = json!(3);
        cred["route_pool"]["secrets"][1]["credential_version"] = json!(3);
        reseal(&mut cred);
        assert_eq!(rejects(&cred, &with), (apply_error::CONFLICT, "content_changed"));

        let mut lower = frame();
        lower["revision"] = json!(90);
        reseal(&mut lower);
        let e = stage(&lower, &with).unwrap_err();
        assert_eq!(
            (e.code, e.reason, &e.detail["applied_config_revision"]),
            (apply_error::CONFLICT, apply_error::STALE_REVISION, &json!(91))
        );

        // 更高 revision 是新配置，不是冲突。
        let mut higher = frame();
        higher["revision"] = json!(92);
        reseal(&mut higher);
        assert!(!stage(&higher, &with).unwrap().resealed);
    }

    #[test]
    fn revocation_regression_rejected() {
        let key = device();
        let known = Input { revocation_revision: 4, ..input(&key) };
        assert_eq!(rejects(&frame(), &known), (apply_error::INVALID_CONFIG, apply_error::REVOCATION_REGRESSED));
        assert!(stage(&frame(), &Input { revocation_revision: 3, ..input(&key) }).is_ok());
    }

    #[test]
    fn envelopes_are_bound_to_session_device_and_key() {
        let key = device();
        // 帧和会话都换成另一台设备：信封 AAD 用会话身份，原信封解不开。
        let mut moved = frame();
        moved["policy"]["device_id"] = json!("dev_other");
        let other = Input { session: Session { device_id: "dev_other", ..SESSION }, ..input(&key) };
        assert_eq!(rejects(&moved, &other), (apply_error::INVALID_CONFIG, "envelope_rejected"));
        // 不同设备私钥解不开。
        let wrong = DeviceKey::from_bytes([9; 32]);
        assert_eq!(rejects(&frame(), &input(&wrong)), (apply_error::INVALID_CONFIG, "envelope_rejected"));
        // 会话与帧身份不一致。
        let tenant = Input { session: Session { tenant_id: "ten_other", ..SESSION }, ..input(&key) };
        assert_eq!(rejects(&frame(), &tenant), (apply_error::INVALID_CONFIG, "identity_mismatch"));
        let user = Input { session: Session { user_id: "usr_other", ..SESSION }, ..input(&key) };
        assert_eq!(rejects(&frame(), &user), (apply_error::INVALID_CONFIG, "identity_mismatch"));
        // 信封交换凭据身份后 AAD 不符。
        let mut swapped = frame();
        swapped["route_pool"]["secrets"][0]["ciphertext"] = frame()["route_pool"]["secrets"][1]["ciphertext"].clone();
        swapped["route_pool"]["secrets"][0]["key_id"] = frame()["route_pool"]["secrets"][1]["key_id"].clone();
        swapped["route_pool"]["secrets"][0]["nonce"] = frame()["route_pool"]["secrets"][1]["nonce"].clone();
        assert_eq!(rejects(&swapped, &input(&key)), (apply_error::INVALID_CONFIG, "envelope_rejected"));
    }

    #[test]
    fn envelope_set_must_match_credential_refs() {
        let key = device();
        let mut missing = frame();
        missing["route_pool"]["secrets"].as_array_mut().unwrap().pop();
        let e = stage(&missing, &input(&key)).unwrap_err();
        assert_eq!((e.code, e.reason), (apply_error::MISSING_ROUTE_CREDENTIAL, "missing_envelope"));
        // 回执形状与样例 config_applied_rejected 对齐。
        let body = e.to_error_body();
        let expected = &fixture()["wire"]["config_applied_rejected"]["error"];
        assert_eq!(
            (body.code.as_str(), body.message.as_str()),
            (expected["code"].as_str().unwrap(), expected["message"].as_str().unwrap())
        );
        assert_eq!(body.detail.as_ref().unwrap()["deployment_id"], expected["detail"]["deployment_id"]);

        let mut extra = frame();
        let stray = seal("ten_demo", "dev_lin", "prj_91", 91, "cred_z", 1, "z");
        extra["route_pool"]["secrets"].as_array_mut().unwrap().push(stray);
        assert_eq!(rejects(&extra, &input(&key)), (apply_error::INVALID_CONFIG, "extra_envelope"));

        let mut dup = frame();
        let copy = dup["route_pool"]["secrets"][1].clone();
        dup["route_pool"]["secrets"].as_array_mut().unwrap().push(copy);
        assert_eq!(rejects(&dup, &input(&key)), (apply_error::INVALID_CONFIG, "duplicate_envelope"));

        // 两条部署引用同一凭据版本：一个信封即可，多余的旧版本信封被拒。
        let mut shared = frame();
        shared["routes"][1]["credential_ref"] = json!({"credential_id":"cred_a","credential_version":1});
        shared["route_pool"]["secrets"].as_array_mut().unwrap().pop();
        let staged = stage(&shared, &input(&key)).unwrap();
        assert_eq!(staged.credentials().len(), 1);
        let mut stale = shared.clone();
        stale["route_pool"]["secrets"].as_array_mut().unwrap().push(frame()["route_pool"]["secrets"][1].clone());
        assert_eq!(rejects(&stale, &input(&key)), (apply_error::INVALID_CONFIG, "extra_envelope"));

        // 旧 policy.secrets 不再供密钥。
        let mut legacy = frame();
        legacy["policy"]["secrets"] = json!([{"provider_id":"prv_a","key_id":"x","nonce":"x","ciphertext":"x"}]);
        assert_eq!(rejects(&legacy, &input(&key)), (apply_error::INVALID_CONFIG, "legacy_secrets"));
    }

    #[test]
    fn rate_rules() {
        let key = device();
        let edit = |f: &dyn Fn(&mut Value)| {
            let mut v = frame();
            f(&mut v);
            v
        };
        let cases: [Case; 7] = [
            (&|v| v["rates"][0]["input_multiplier_ppm"] = json!(3_999_000), "rate_mismatch"),
            (&|v| v["rates"][0]["input_multiplier_ppm"] = json!(4_000_500), "rate_mismatch"),
            (&|v| v["rates"][0]["input_multiplier_basis"] = json!("usd_1_per_mtok_input"), "rate_mismatch"),
            (&|v| v["rates"][0]["effective_from"] = json!("2026-11-22T03:00:00Z"), "rate_missing"),
            (&|v| v["rates"][0]["effective_until"] = json!("2026-11-22T02:00:12Z"), "rate_missing"),
            (&|v| v["rates"][0]["effective_until"] = json!("2026-11-21T00:00:00Z"), "rate_window_invalid"),
            (&|v| v["rates"][0]["model_id"] = json!("mdl_other"), "rate_unreferenced"),
        ];
        for (change, reason) in cases {
            assert_eq!(rejects(&edit(change), &input(&key)), (apply_error::INVALID_CONFIG, reason));
        }
        // 重叠窗口拒绝；首尾相接的预发窗口接受，标签仍取当前窗口。
        let next = |from: &str, ppm: u64| {
            let mut r = fixture()["wire"]["config"]["rates"][0].clone();
            r["rate_version_id"] = json!(format!("rate_m_{ppm}"));
            r["effective_from"] = json!(from);
            r["effective_until"] = json!("2027-01-01T00:00:00Z");
            r["input_multiplier_ppm"] = json!(ppm);
            r["input_milli_per_mtok"] = json!(ppm / 1000);
            r
        };
        let overlap = edit(&|v| v["rates"].as_array_mut().unwrap().push(next("2026-11-30T00:00:00Z", 5_000_000)));
        assert_eq!(rejects(&overlap, &input(&key)), (apply_error::INVALID_CONFIG, "rate_overlap"));
        let adjacent = edit(&|v| v["rates"].as_array_mut().unwrap().push(next("2026-12-01T00:00:00Z", 5_000_000)));
        assert_eq!(stage(&adjacent, &input(&key)).unwrap().labels[0].label, "DeepSeek V4.1 Flash · 4×");
        let later = Input { now_ms: parse_ms("2026-12-01T00:00:00Z").unwrap(), ..input(&key) };
        // 路由快照已过期时整份拒绝，不会借预发费率放行。
        assert_eq!(rejects(&adjacent, &later), (apply_error::INVALID_CONFIG, "expired"));
    }

    #[test]
    fn structural_rules() {
        let key = device();
        let edit = |f: &dyn Fn(&mut Value)| {
            let mut v = frame();
            f(&mut v);
            v
        };
        let invalid: [Case; 9] = [
            (&|v| v["route_pool"]["expires_at"] = json!("2026-11-22T02:00:12Z"), "expired"),
            (&|v| v["route_pool"]["bindings"][0]["deployment_ids"] = json!(["dep_a"]), "orphan_route"),
            (
                &|v| v["route_pool"]["bindings"][0]["deployment_ids"] = json!(["dep_a", "dep_x"]),
                "unresolved_deployment",
            ),
            (&|v| v["route_pool"]["bindings"][0]["agent_release_id"] = json!("rel_other"), "unknown_release"),
            (&|v| v["routes"][1]["pool_revision"] = json!(6), "pool_mismatch"),
            (&|v| v["route_pool"]["pools"][0]["max_attempts"] = json!(0), "pool_limits"),
            (&|v| v["route_pool"]["pools"][0]["total_timeout_ms"] = json!(4000), "pool_limits"),
            (&|v| v["routes"][0]["base_url"] = json!("https://user:pw@a.example.test/v1"), "malformed_route"),
            (
                &|v| {
                    let mut b = v["route_pool"]["bindings"][0].clone();
                    b["binding_id"] = json!("bnd_dup");
                    v["route_pool"]["bindings"].as_array_mut().unwrap().push(b);
                },
                "ambiguous_alias",
            ),
        ];
        for (change, reason) in invalid {
            assert_eq!(rejects(&edit(change), &input(&key)), (apply_error::INVALID_CONFIG, reason), "{reason}");
        }
        let unsupported: [Case; 5] = [
            (&|v| v["route_pool"]["abi"] = json!(2), "route_pool_abi"),
            (&|v| v["route_pool"]["pools"][0]["strategy"] = json!("weighted"), "unsupported_strategy"),
            (&|v| v["routes"][0]["features"] = json!(["text", "telepathy"]), "unknown_feature"),
            (&|v| v["routes"][0]["protocol"] = json!("grpc"), "unsupported_protocol"),
            (&|v| v["routes"][0]["availability"]["state"] = json!("degraded"), "unknown_availability"),
        ];
        for (change, reason) in unsupported {
            assert_eq!(rejects(&edit(change), &input(&key)), (apply_error::UNSUPPORTED_CAPABILITY, reason), "{reason}");
        }
        // 单条路由过期不拒绝整份快照，由选路跳过。
        assert!(stage(&edit(&|v| v["routes"][0]["valid_until"] = json!("2026-11-22T02:00:00Z")), &input(&key)).is_ok());
        assert_eq!(rejects(&json!({"type":"config","id":"x"}), &input(&key)).1, "malformed");
    }

    #[test]
    fn staging_has_no_runtime_side_effects() {
        let state = State { device_key: device(), ..Default::default() };
        // 无会话身份时拒绝。
        assert_eq!(stage_with_state(&state, &frame(), now(), None, 0).unwrap_err().reason, "no_session");
        {
            let mut c = state.conn.lock().unwrap();
            c.tenant_id = Some("ten_demo".into());
            c.user_id = Some("usr_lin".into());
            c.device_id = Some("dev_lin".into());
        }
        state.secrets.write().unwrap().insert("prv_old".into(), "old".into());
        let before_conn = format!("{:?}", state.conn.lock().unwrap());
        let before_lease = state.lease.status();

        let staged = stage_with_state(&state, &frame(), now(), None, 0).unwrap();
        assert_eq!(staged.labels[0].label, "DeepSeek V4.1 Flash · 4×");
        let mut bad = frame();
        bad["rates"][0]["input_multiplier_ppm"] = json!(3_000_000);
        assert_eq!(stage_with_state(&state, &bad, now(), None, 0).unwrap_err().reason, "rate_mismatch");

        let cfg = state.config.read().unwrap();
        assert_eq!(cfg.revision, 0, "applied cursor untouched");
        assert!(cfg.routes.is_empty() && cfg.rates.is_empty() && cfg.policy.is_none() && !cfg.policy_blocked);
        drop(cfg);
        assert_eq!(state.secrets.read().unwrap().len(), 1, "legacy key table untouched");
        assert_eq!(state.secrets.read().unwrap()["prv_old"], "old");
        assert_eq!(state.lease.status(), before_lease, "lease untouched");
        assert_eq!(format!("{:?}", state.conn.lock().unwrap()), before_conn);
        assert!(state.launch_tokens.read().unwrap().is_empty());
        assert_eq!(state.upstream.lock().unwrap().completed, 0);
    }

    #[test]
    fn multiplier_format() {
        for (ppm, s) in [
            (4_000_000, "4"),
            (1_500_000, "1.5"),
            (1_234_000, "1.234"),
            (0, "0"),
            (10_000, "0.01"),
            (12_340_000, "12.34"),
        ] {
            assert_eq!(format_multiplier(ppm), s);
        }
    }
}
