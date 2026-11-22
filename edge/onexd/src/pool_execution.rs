//! Signed native Responses execution. Terminal usage is durable before the client sees the terminal response.
use std::error::Error as _;
use std::io::ErrorKind;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use onex_core::ws::{BalanceMode, Rate, UpstreamAuth};
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, timeout_at};
use zeroize::Zeroizing;

use crate::pricing::{Tokens, cost_milli, format_ms};
use crate::responses::{err_before_headers as error, response_failed_event, responses_usage_to_tokens};
use crate::route_apply::{Scope, Store};
use crate::route_select::{self, Context, Request};
use crate::router::{
    MAX_UPSTREAM_BODY, Router, estimate_request_fields, header_value, read_limited, response_headers, tokio_stream_from,
};
use crate::sse::{Batch, Event, Splitter};
use crate::state::PoolExecution;

// A native Agent can time out locally. Keep metering a disconnected reader only while the upstream is
// making progress and while the original grant is valid.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

fn refused_before_send(error: &reqwest::Error) -> bool {
    if !error.is_connect() || error.is_timeout() {
        return false;
    }
    let mut source = error.source();
    while let Some(cause) = source {
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            return io.kind() == ErrorKind::ConnectionRefused;
        }
        source = cause.source();
    }
    false
}

fn blocked() -> Response {
    error(StatusCode::FORBIDDEN, "forbidden", "模型池和租约尚未通过设备确认。")
}

pub(crate) async fn responses(rt: Arc<Router>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(mode) = rt.state.pool_execution() else { return blocked() };
    let Ok(Some(binding)) = rt.session_for(&headers) else {
        return error(StatusCode::UNAUTHORIZED, "unauthenticated", "需要受管 Agent 启动凭据。");
    };
    if binding.agent != "codex"
        || binding.release_id.is_none()
        || (mode == PoolExecution::Production && binding.approved_model.is_none())
    {
        return error(StatusCode::FORBIDDEN, "agent_not_allowed", "模型池需要已签发的 Codex 发行。");
    }
    let Some(store) = &rt.pool_store else { return blocked() };
    let Some(view) = rt.state.route.read().unwrap().ready().cloned() else { return blocked() };
    let now = view.clock.now_ms();
    let generation = rt.state.generation();
    if !view.executable()
        || !store.view_receipt_acked(&view.scope, view.identity.revision, &view.identity.projection_id).unwrap_or(false)
    {
        return blocked();
    }
    let Ok(Some(lease)) = store.accepted_pool_lease(&view.scope) else { return blocked() };
    if lease.config_revision != view.identity.revision
        || lease.projection_id != view.identity.projection_id
        || lease.signature_id != view.config.route_pool.signature_id
        || lease.expires_at_ms <= now
    {
        return blocked();
    }

    let Ok(mut req @ Value::Object(_)) = serde_json::from_slice(&body) else {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid", "请求必须是完整 JSON。");
    };
    let Some(model) = req["model"].as_str().map(str::to_owned) else {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid", "请求缺少模型。");
    };
    let stream = req["stream"].as_bool().unwrap_or(false);
    if req.get("previous_response_id").is_some_and(|v| !v.is_null())
        || binding.approved_model.as_ref().is_some_and(|approved| approved != &model)
    {
        return error(StatusCode::FORBIDDEN, "model_not_allowed", "当前入口需要无服务端会话的已分配模型。");
    }
    let runtime = view.config.policy.runtime.as_ref();
    if runtime.is_some_and(|rules| {
        rules.public_egress == Some(false)
            || rules.requests_per_minute.is_some()
            || rules.tokens_per_minute.is_some()
            || rules.member_concurrent.is_some()
            || rules.key_concurrent.is_some()
    }) {
        return error(StatusCode::FORBIDDEN, "forbidden", "当前设备策略不允许此模型池执行。");
    }
    let output_cap = runtime.and_then(|rules| rules.max_output);
    let requested = match req.get("max_output_tokens") {
        Some(value) => match value.as_u64().filter(|tokens| *tokens > 0) {
            Some(tokens) => Some(tokens),
            None => return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid", "输出上限必须是正整数。"),
        },
        None => None,
    };
    if let (Some(requested), Some(cap)) = (requested, output_cap)
        && requested > cap
    {
        return error(StatusCode::FORBIDDEN, "output_too_large", "请求的输出上限超过当前能力合约。");
    }
    let estimated_input = estimate_request_fields(&req, &["instructions", "input", "tools"]);
    let request = Request {
        agent_release_id: binding.release_id.as_deref().unwrap(),
        ingress_protocol: "openai_responses",
        model_alias: &model,
        required_features: route_select::required_features("openai_responses", &req),
        estimated_input_tokens: estimated_input,
        requested_output_tokens: requested,
    };
    let context = Context {
        balance: view.config.policy.balance.as_ref().map_or(BalanceMode::Normal, |p| p.mode),
        now_ms: now,
        revocations: &[],
        adapters: &[],
    };
    let Ok(plan) = route_select::select(&view.config, &request, &context) else {
        return error(StatusCode::FORBIDDEN, "model_not_allowed", "当前签约模型无可执行渠道。");
    };
    let max_output = requested.unwrap_or_else(|| {
        const DEFAULT_OUTPUT: u64 = 4096;
        let candidate_cap = plan.candidates.iter().filter_map(|route| route.max_output_tokens).min();
        DEFAULT_OUTPUT.min(output_cap.unwrap_or(DEFAULT_OUTPUT)).min(candidate_cap.unwrap_or(DEFAULT_OUTPUT))
    });
    req["max_output_tokens"] = max_output.into();
    let budget =
        lease.budget_milli.min(*lease.model_budgets.get(&plan.binding.model_id).unwrap_or(&lease.budget_milli));
    let reservation =
        cost_milli(&plan.rate.base, &Tokens { input: estimated_input, output: max_output, ..Tokens::default() });
    if reservation > budget {
        return blocked();
    }
    let request_id = crate::id::new("req");
    let Ok(Some(_intent)) = RouteIntent::reserve(store, &view.scope, &lease.lease_id, &request_id) else {
        return blocked();
    };

    let lease_remaining = lease.expires_at_ms.saturating_sub(view.clock.now_ms());
    let lease_deadline = Instant::now() + Duration::from_millis(u64::try_from(lease_remaining).unwrap_or_default());
    let mut total_deadline = None;
    let total = Duration::from_millis(plan.pool.total_timeout_ms);
    let attempt_limit = Duration::from_millis(plan.pool.attempt_timeout_ms);
    let mut attempts = Vec::new();
    let mut result = None;
    let attempt_count = if mode == PoolExecution::Isolated || runtime.is_some_and(|rules| rules.failover) {
        plan.pool.max_attempts as usize
    } else {
        1
    };
    for route in plan.candidates.iter().take(attempt_count) {
        if rt.state.pool_execution() != Some(mode)
            || rt.state.generation() != generation
            || !rt.state.route.read().unwrap().ready().is_some_and(|current| Arc::ptr_eq(current, &view))
            || view.clock.now_ms() >= lease.expires_at_ms
        {
            return blocked();
        }
        let start = Instant::now();
        let deadline = (start + attempt_limit).min(*total_deadline.get_or_insert(start + total)).min(lease_deadline);
        let Some(remaining) = deadline.checked_duration_since(start).filter(|time| !time.is_zero()) else { break };
        let Some((client, url)) = crate::pool_egress::responses_target(&route.base, mode, remaining).await else {
            return blocked();
        };
        if Instant::now() >= deadline {
            break;
        }
        if rt.state.pool_execution() != Some(mode)
            || rt.state.generation() != generation
            || !rt.state.route.read().unwrap().ready().is_some_and(|current| Arc::ptr_eq(current, &view))
            || view.clock.now_ms() >= lease.expires_at_ms
        {
            return blocked();
        }
        let Some(key) = view.key(&route.credential_ref).map(|value| Zeroizing::new(value.to_owned())) else {
            return blocked();
        };
        let attempt_id = crate::id::new("att");
        if store
            .start_route_attempt(
                &view.scope,
                &lease.lease_id,
                &request_id,
                &attempt_id,
                &route.deployment_id,
                route.deployment_revision,
            )
            .is_err()
        {
            return error(StatusCode::INTERNAL_SERVER_ERROR, "internal", "无法持久化渠道尝试。");
        }
        req["model"] = route.base.upstream_model.as_deref().unwrap_or(&route.base.model).into();
        req["store"] = false.into();
        let outgoing = client.post(url).json(&req);
        let outgoing = match route.base.auth {
            UpstreamAuth::Bearer => outgoing.bearer_auth(key.as_str()),
            UpstreamAuth::XApiKey => outgoing.header("x-api-key", header_value(&key)),
        };
        let Ok(response) = timeout_at(deadline, outgoing.send()).await else {
            return error(StatusCode::GATEWAY_TIMEOUT, "upstream_error", "等待上游响应超时，送达情况待核对。");
        };
        let outcome = match &response {
            Ok(_) => "completed",
            Err(cause) if refused_before_send(cause) => "connect_refused",
            Err(_) => return error(StatusCode::BAD_GATEWAY, "upstream_error", "上游送达情况待核对。"),
        };
        attempts.push(json!({"attempt_id": attempt_id, "deployment_id": route.deployment_id,
            "deployment_revision": route.deployment_revision, "outcome": outcome}));
        if let Ok(response) = response {
            result = Some((route, attempt_id, response, deadline));
            break;
        }
        if store.record_connect_refusal(&view.scope, &attempt_id).is_err() {
            return error(StatusCode::INTERNAL_SERVER_ERROR, "internal", "无法持久化连接拒绝。");
        }
    }
    let Some((route, attempt_id, mut upstream, first_deadline)) = result else {
        return error(StatusCode::BAD_GATEWAY, "upstream_error", "已签约渠道的连接均不可用。");
    };
    if !upstream.status().is_success() {
        return error(StatusCode::BAD_GATEWAY, "upstream_error", "上游未返回已确认用量。");
    }
    let headers = response_headers(upstream.headers());
    let upstream_stream = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"));
    if stream != upstream_stream {
        return error(StatusCode::BAD_GATEWAY, "upstream_error", "上游响应类型与请求不符。");
    }
    let payload = json!({"request_id":request_id,"session_id":binding.session_id,"lease_id":lease.lease_id,
        "provider_id":route.base.provider_id,"model":model,"model_id":plan.binding.model_id,
        "deployment_id":route.deployment_id,"deployment_revision":route.deployment_revision,"attempt_id":attempt_id,
        "rate_version_id":plan.rate.rate_version_id,"config_revision":view.identity.revision,
        "projection_id":view.identity.projection_id,"attempts":attempts,"at":format_ms(now),
        "status":"ok","complete":true,"measurement_basis":"upstream_usage"});
    let receipt = Receipt {
        store: store.clone(),
        scope: view.scope.clone(),
        rate: plan.rate.base.clone(),
        budget,
        payload,
        first_session: binding.first_native_session,
    };
    let body = if stream {
        let mut split = Splitter::default();
        let first = match timeout_at(first_deadline, first_stream_batch(&mut upstream, &mut split)).await {
            Ok(Some(batch)) => batch,
            Ok(None) => return error(StatusCode::BAD_GATEWAY, "upstream_error", "上游未返回有效的响应事件。"),
            Err(_) => {
                return error(
                    StatusCode::GATEWAY_TIMEOUT,
                    "upstream_error",
                    "等待上游首个响应事件超时，送达情况待核对。",
                );
            }
        };
        let (send, receive) = mpsc::channel(16);
        tokio::spawn(pump(upstream, (split, first), receipt, send, lease_deadline));
        Body::from_stream(tokio_stream_from(receive))
    } else {
        let bytes = match timeout_at(first_deadline, read_limited(upstream, MAX_UPSTREAM_BODY)).await {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(_)) => return error(StatusCode::BAD_GATEWAY, "upstream_error", "上游响应不完整。"),
            Err(_) => {
                return error(StatusCode::GATEWAY_TIMEOUT, "upstream_error", "等待上游首个响应超时，送达情况待核对。");
            }
        };
        let Ok(result) = serde_json::from_slice::<Value>(&bytes) else {
            return error(StatusCode::BAD_GATEWAY, "upstream_error", "上游响应不包含可核对的用量。");
        };
        if !receipt.finish(&result).await {
            return error(StatusCode::BAD_GATEWAY, "upstream_error", "未能确认或保存上游的终态用量。");
        }
        Body::from(bytes)
    };
    let mut response = Response::new(body);
    *response.headers_mut() = headers;
    response
}

/// On preflight exit or exhausted connection refusals, release the request slot. Once an attempt may have
/// sent bytes, the persistent `started` record prevents cleanup, including when the client cancels early.
struct RouteIntent<'a> {
    store: &'a Store,
    scope: &'a Scope,
    lease: &'a str,
    request: &'a str,
}

impl<'a> RouteIntent<'a> {
    fn reserve(store: &'a Store, scope: &'a Scope, lease: &'a str, request: &'a str) -> anyhow::Result<Option<Self>> {
        Ok(store.reserve_route_request(scope, lease, request)?.then(|| Self { store, scope, lease, request }))
    }
}

impl Drop for RouteIntent<'_> {
    fn drop(&mut self) {
        if let Err(error) = self.store.release_unsent_route_request(self.scope, self.lease, self.request) {
            tracing::warn!(lease_id = self.lease, request_id = self.request, %error, "could not release unsent route request");
        }
    }
}

struct Receipt {
    store: Arc<Store>,
    scope: Scope,
    rate: Rate,
    budget: i64,
    payload: Value,
    first_session: Option<watch::Receiver<Option<String>>>,
}

impl Receipt {
    /// Persist only a confirmed, complete meter. The local intent remains reserved on an uncertain outcome.
    async fn finish(mut self, result: &Value) -> bool {
        let usage = &result["usage"];
        if result["status"] != "completed"
            || !usage["input_tokens"].is_u64()
            || !usage["output_tokens"].is_u64()
            || usage["input_tokens_details"]["cached_tokens"].as_u64().unwrap_or(0)
                > usage["input_tokens"].as_u64().unwrap_or(0)
        {
            return false;
        }
        let counts = responses_usage_to_tokens(usage);
        let cost = cost_milli(&self.rate, &counts);
        if cost > self.budget {
            return false;
        }
        if let Some(first) = &mut self.first_session {
            let _ = tokio::time::timeout(Duration::from_secs(1), first.wait_for(Option::is_some)).await;
            if let Some(native) = first.borrow().as_ref() {
                self.payload["session_id"] = native.as_str().into();
            }
        }
        self.payload["input_tokens"] = counts.input.into();
        self.payload["output_tokens"] = counts.output.into();
        self.payload["cache_read_tokens"] = counts.cache_read.into();
        self.payload["cache_write_tokens"] = counts.cache_write.into();
        self.payload["cost_milli"] = cost.into();
        let lease = self.payload["lease_id"].as_str().unwrap().to_owned();
        let request = self.payload["request_id"].as_str().unwrap().to_owned();
        self.store.complete_route_request(&self.scope, &lease, &request, self.payload).is_ok()
    }
}

fn event_kind<'a>(value: &'a Value, event: &'a Event) -> Option<&'a str> {
    value.as_object()?;
    value["type"].as_str().or(event.event.as_deref())
}

fn starts_response(kind: &str, value: &Value) -> bool {
    match kind {
        "response.created" | "response.in_progress" | "response.completed" | "response.queued" => {
            value["response"]["id"].as_str().is_some_and(|id| !id.is_empty())
        }
        "response.output_item.added" | "response.output_item.done" => value["item"].is_object(),
        "response.content_part.added" | "response.content_part.done" => value["part"].is_object(),
        "response.output_text.delta"
        | "response.reasoning_text.delta"
        | "response.reasoning_summary_text.delta"
        | "response.refusal.delta"
        | "response.function_call_arguments.delta" => value["delta"].is_string(),
        _ => false,
    }
}

/// HTTP headers, SSE comments and malformed events are insufficient to end the first-response timer.
async fn first_stream_batch(upstream: &mut reqwest::Response, split: &mut Splitter) -> Option<Batch> {
    while let Ok(Some(chunk)) = upstream.chunk().await {
        let batch = split.push_framed(&chunk);
        for (_, event) in &batch.events {
            let Ok(value) = serde_json::from_str::<Value>(&event.data) else { continue };
            match event_kind(&value, event) {
                Some("response.failed" | "response.incomplete" | "error") => return None,
                Some(kind) if starts_response(kind, &value) => return Some(batch),
                _ => {}
            }
        }
        if batch.oversized {
            break;
        }
    }
    None
}

async fn pump(
    mut upstream: reqwest::Response,
    (mut split, mut batch): (Splitter, Batch),
    receipt: Receipt,
    send: mpsc::Sender<Result<Bytes, std::io::Error>>,
    lease_deadline: Instant,
) {
    let mut downstream_open = true;
    loop {
        let mut previous = 0;
        for (end, event) in &batch.events {
            let Ok(value) = serde_json::from_str::<Value>(&event.data) else { continue };
            match event_kind(&value, event) {
                Some("response.completed") => {
                    if receipt.finish(&value["response"]).await {
                        write_frame(&send, &mut downstream_open, batch.raw.slice(..*end)).await;
                    } else {
                        write_frame(&send, &mut downstream_open, batch.raw.slice(..previous)).await;
                        send_failure(&send, &mut downstream_open).await;
                    }
                    return;
                }
                Some("response.failed" | "response.incomplete" | "error") => {
                    write_frame(&send, &mut downstream_open, batch.raw.slice(..previous)).await;
                    send_failure(&send, &mut downstream_open).await;
                    return;
                }
                _ => previous = *end,
            }
        }
        write_frame(&send, &mut downstream_open, batch.raw).await;
        if batch.oversized || Instant::now() >= lease_deadline {
            break;
        }
        let deadline = (Instant::now() + STREAM_IDLE_TIMEOUT).min(lease_deadline);
        let Ok(Ok(Some(chunk))) = timeout_at(deadline, upstream.chunk()).await else { break };
        batch = split.push_framed(&chunk);
    }
    send_failure(&send, &mut downstream_open).await;
}

async fn write_frame(send: &mpsc::Sender<Result<Bytes, std::io::Error>>, open: &mut bool, bytes: Bytes) {
    if *open && !bytes.is_empty() {
        *open =
            tokio::time::timeout(Duration::from_secs(1), send.send(Ok(bytes))).await.is_ok_and(|result| result.is_ok());
    }
}

async fn send_failure(send: &mpsc::Sender<Result<Bytes, std::io::Error>>, open: &mut bool) {
    write_frame(send, open, response_failed_event("upstream_error", "上游送达或终态用量待核对。")).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::route_apply::{PoolLease, PoolLeaseState};

    #[test]
    fn first_response_requires_recognized_native_data() {
        assert!(!starts_response("response.keepalive", &json!({})));
        assert!(!starts_response("response.created", &json!({"response":{}})));
        assert!(starts_response("response.created", &json!({"response":{"id":"resp_1"}})));
        assert!(starts_response("response.output_text.delta", &json!({"delta":"ready"})));
    }

    #[test]
    fn route_intent_releases_only_without_possible_delivery() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("route.sqlite");
        let store = Store::open(&path).unwrap();
        let scope = Scope::new("wss://test.example/v1/edge/ws", "tenant", "user", "device").unwrap();
        let lease = PoolLease {
            lease_id: "lease".into(),
            state: PoolLeaseState::Accepted,
            config_revision: 1,
            projection_id: "projection".into(),
            signature_id: "signature".into(),
            commerce_plan_id: None,
            expires_at_ms: 120_000,
            budget_milli: 100,
            model_budgets: Default::default(),
        };
        store.accept_pool_lease(&scope, &lease, None, 1000).unwrap();
        let reserve = |request| RouteIntent::reserve(&store, &scope, &lease.lease_id, request).unwrap();

        drop(reserve("blocked_before_send").unwrap());
        let all_refused = reserve("all_refused").unwrap();
        for (attempt, deployment) in [("attempt_a", "deployment_a"), ("attempt_b", "deployment_b")] {
            store.start_route_attempt(&scope, &lease.lease_id, "all_refused", attempt, deployment, 1).unwrap();
            store.record_connect_refusal(&scope, attempt).unwrap();
        }
        drop(all_refused);
        assert!(store.route_usage_for_lease(&scope, &lease.lease_id).unwrap().is_none());
        let db = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let refusals: u32 = db
            .query_row(
                "SELECT count(*) FROM pool_runtime_attempts
          WHERE request_id='all_refused' AND outcome='connect_refused'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(refusals, 2);
        assert!(
            store
                .start_route_attempt(&scope, &lease.lease_id, "all_refused", "late_attempt", "deployment_a", 1)
                .is_err()
        );

        let uncertain = reserve("possibly_sent").unwrap();
        store.start_route_attempt(&scope, &lease.lease_id, "possibly_sent", "attempt_c", "deployment_a", 1).unwrap();
        assert!(reserve("possibly_sent").is_none());
        drop(uncertain);
        assert!(reserve("another_request").is_none());
        assert!(store.route_usage_for_lease(&scope, &lease.lease_id).unwrap().is_some());
    }
}
