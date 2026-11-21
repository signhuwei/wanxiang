//! Device-local admission. A permit follows the HTTP response through its final stream event.
use std::collections::{HashMap, VecDeque};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use onex_core::ws::RuntimeRules;
use serde_json::Value;

#[derive(Default)]
struct Window {
    events: VecDeque<(Instant, u64)>,
    tokens: u64,
    inflight: u64,
}

#[derive(Default)]
struct Counters {
    members: HashMap<(String, String), Window>,
    keys: HashMap<u64, u64>,
}

#[derive(Clone, Default)]
pub(crate) struct Gate(Arc<Mutex<Counters>>);

pub(crate) struct Permit {
    gate: Gate,
    owner: (String, String),
    key: u64,
    key_limit: Option<u64>,
}

fn fingerprint(key: &str) -> u64 {
    let mut hash = DefaultHasher::new();
    key.hash(&mut hash);
    hash.finish()
}

impl Gate {
    /// Normalizes output fields before protocol translation. TPM reserves estimated input
    /// plus this enforced upper bound, so an omitted generation length cannot evade TPM.
    pub fn admit(
        &self,
        owner: (String, String),
        rules: &RuntimeRules,
        key: &str,
        input: u64,
        req: &mut Value,
        fields: &[&str],
    ) -> Result<Option<Permit>, (u16, &'static str)> {
        let has_limits = rules.requests_per_minute.is_some()
            || rules.tokens_per_minute.is_some()
            || rules.member_concurrent.is_some()
            || rules.key_concurrent.is_some();
        if !has_limits && rules.max_output.is_none() {
            return Ok(None);
        }
        let key = fingerprint(key);
        let mut all = self.0.lock().unwrap();
        if rules.key_concurrent.is_some_and(|max| all.keys.get(&key).copied().unwrap_or(0) >= max) {
            return Err((429, "上游密钥已达到并发上限。"));
        }
        let now = Instant::now();
        let window = all.members.entry(owner.clone()).or_default();
        while window.events.front().is_some_and(|(time, _)| now.duration_since(*time) >= Duration::from_secs(60)) {
            window.tokens -= window.events.pop_front().unwrap().1;
        }
        if rules.requests_per_minute.is_some_and(|max| window.events.len() as u64 >= max)
            || rules.member_concurrent.is_some_and(|max| window.inflight >= max)
        {
            return Err((429, "已达到本机成员请求速率或并发上限。"));
        }
        let available = rules.tokens_per_minute.map(|max| max.saturating_sub(window.tokens));
        if available.is_some_and(|left| input > left || (input == left && !fields.is_empty())) {
            return Err((429, "已达到本机成员每分钟 Token 上限。"));
        }
        let mut output = 0;
        if let Some(first) = fields.first() {
            let specified = fields.iter().filter(|k| req.get(**k).is_some_and(|v| !v.is_null())).collect::<Vec<_>>();
            if specified.len() > 1 {
                return Err((422, "只允许一个输出 Token 上限。"));
            }
            let field = specified.first().map(|v| **v).unwrap_or(*first);
            let requested = match req.get(field).filter(|v| !v.is_null()) {
                Some(v) => Some(v.as_u64().filter(|v| *v > 0).ok_or((422, "输出 Token 上限须为正整数。"))?),
                None => None,
            };
            let cap = [rules.max_output, available.map(|n| n - input)].into_iter().flatten().min();
            if let Some(cap) = cap {
                output = requested.unwrap_or(cap).min(cap);
                req[field] = Value::from(output);
            } else {
                output = requested.unwrap_or(0);
            }
        }
        if !has_limits {
            return Ok(None);
        }
        if rules.tokens_per_minute.is_some() || rules.requests_per_minute.is_some() {
            let reserved = if rules.tokens_per_minute.is_some() { input.saturating_add(output) } else { 0 };
            window.events.push_back((now, reserved));
            window.tokens = window.tokens.saturating_add(reserved);
        }
        window.inflight += 1;
        *all.keys.entry(key).or_default() += 1;
        Ok(Some(Permit { gate: self.clone(), owner, key, key_limit: rules.key_concurrent }))
    }
}

impl Permit {
    pub fn move_to(&mut self, key: &str) -> bool {
        let next = fingerprint(key);
        if next == self.key {
            return true;
        }
        let mut all = self.gate.0.lock().unwrap();
        if self.key_limit.is_some_and(|max| all.keys.get(&next).copied().unwrap_or(0) >= max) {
            return false;
        }
        release_key(&mut all, self.key);
        *all.keys.entry(next).or_default() += 1;
        self.key = next;
        true
    }
}

fn release_key(all: &mut Counters, key: u64) {
    if let Some(count) = all.keys.get_mut(&key) {
        *count -= 1;
        if *count == 0 {
            all.keys.remove(&key);
        }
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        let mut all = self.gate.0.lock().unwrap();
        release_key(&mut all, self.key);
        if let Some(w) = all.members.get_mut(&self.owner) {
            w.inflight -= 1;
            if w.inflight == 0 && w.events.is_empty() {
                all.members.remove(&self.owner);
            }
        }
    }
}

fn private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_private() || v.is_loopback(),
        IpAddr::V6(v) => {
            v.is_loopback()
                || v.is_unique_local()
                || v.to_ipv4_mapped().is_some_and(|v| v.is_private() || v.is_loopback())
        }
    }
}

pub(crate) async fn restricted_client(url: &str) -> Result<reqwest::Client, String> {
    let url = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    let host = url.host_str().ok_or("missing host")?.trim_matches(['[', ']']);
    let port = url.port_or_known_default().ok_or("missing port")?;
    let addrs = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![std::net::SocketAddr::new(ip, port)]
    } else {
        tokio::time::timeout(Duration::from_secs(10), tokio::net::lookup_host((host, port)))
            .await
            .map_err(|_| "内网地址解析超时")?
            .map_err(|_| "无法解析内网地址")?
            .collect::<Vec<_>>()
    };
    if addrs.is_empty() || addrs.iter().any(|addr| !private(addr.ip())) {
        return Err("当前合约仅允许连接私网或回环地址".into());
    }
    crate::router::client_builder().no_proxy().resolve_to_addrs(host, &addrs).build().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn concurrent_requests_share_keys_and_keep_member_budgets_separate() {
        let gate = Gate::default();
        let limits = RuntimeRules {
            max_output: Some(5),
            key_concurrent: Some(1),
            tokens_per_minute: Some(11),
            requests_per_minute: Some(2),
            ..Default::default()
        };
        let a = ("t".into(), "a".into());
        let b = ("t".into(), "b".into());
        let mut request = json!({"max_tokens":20});
        let mut first = gate.admit(a.clone(), &limits, "key1", 3, &mut request, &["max_tokens"]).unwrap().unwrap();
        assert_eq!(request["max_tokens"], 5);
        assert!(matches!(gate.admit(b.clone(), &limits, "key1", 1, &mut request, &[]), Err((429, _))));
        let second = gate.admit(b, &limits, "key2", 1, &mut request, &[]).unwrap();
        assert!(!first.move_to("key2"));
        drop(second);
        assert!(first.move_to("key2"));
        drop(first);
        let mut missing = json!({});
        let permit = gate.admit(a.clone(), &limits, "key1", 1, &mut missing, &["max_tokens"]).unwrap();
        assert_eq!(missing["max_tokens"], 2);
        drop(permit);
        assert!(matches!(gate.admit(a, &limits, "key1", 1, &mut missing, &[]), Err((429, _))));
    }

    #[tokio::test]
    async fn denies_public_egress_before_opening_a_connection() {
        assert!(restricted_client("https://8.8.8.8/v1").await.is_err());
        assert!(restricted_client("https://[::ffff:8.8.8.8]/v1").await.is_err());
        assert!(restricted_client("http://127.0.0.1:43210").await.is_ok());
    }
}
