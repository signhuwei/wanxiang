//! Loopback-only native Responses proof for the isolated signed route flow.
//! Successful non-streaming calls persist measured usage before replying. A call with an unknown outcome
//! keeps its local lease intent open rather than settling it at zero or trying another supplier.
use std::net::IpAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use onex_core::ws::BalanceMode;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::pricing::{Tokens, cost_milli, format_ms};
use crate::responses::{err_before_headers as error, responses_usage_to_tokens};
use crate::route_select::{self, Context, Request};
use crate::router::{MAX_UPSTREAM_BODY, Router, estimate_request_fields, read_limited, response_headers};

pub(crate) fn loopback(raw: &str, scheme: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else { return false };
    url.scheme() == scheme
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url
            .host_str()
            .and_then(|host| host.trim_matches(['[', ']']).parse::<IpAddr>().ok())
            .is_some_and(|ip| ip.is_loopback())
}

fn blocked() -> Response {
    error(StatusCode::FORBIDDEN, "forbidden", "模型池和租约尚未通过设备确认。")
}

pub(crate) async fn responses(rt: Arc<Router>, headers: HeaderMap, body: Bytes) -> Response {
    if !rt.state.isolated_route_execution.load(Ordering::Acquire) {
        return blocked();
    }
    let Ok(Some(binding)) = rt.session_for(&headers) else {
        return error(StatusCode::UNAUTHORIZED, "unauthenticated", "需要受管 Agent 启动凭据。");
    };
    if binding.agent != "codex" || binding.release_id.is_none() {
        return error(StatusCode::FORBIDDEN, "agent_not_allowed", "隔离模型池仅接收已签发的 Codex 发行。");
    }
    let Some(store) = &rt.isolated_pool_store else { return blocked() };
    let Some(view) = rt.state.route.read().unwrap().ready().cloned() else { return blocked() };
    let now = view.clock.now_ms();
    let generation = rt.state.generation();
    if !view.executable()
        || !loopback(&view.scope.server_origin, "ws")
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
    let Some(max_output) = req["max_output_tokens"].as_u64().filter(|v| *v > 0) else {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid", "隔离执行须明确输出上限。");
    };
    if req["stream"].as_bool().unwrap_or(false)
        || req.get("previous_response_id").is_some_and(|v| !v.is_null())
        || binding.approved_model.as_ref().is_some_and(|approved| approved != &model)
    {
        return error(StatusCode::FORBIDDEN, "model_not_allowed", "隔离执行只支持非流式、无服务端会话的已分配模型。");
    }

    let estimated_input = estimate_request_fields(&req, &["instructions", "input", "tools"]);
    let request = Request {
        agent_release_id: binding.release_id.as_deref().unwrap(),
        ingress_protocol: "openai_responses",
        model_alias: &model,
        required_features: route_select::required_features("openai_responses", &req),
        estimated_input_tokens: estimated_input,
        requested_output_tokens: Some(max_output),
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
    let Some(route) = plan.candidates.first() else { return blocked() };
    let budget =
        lease.budget_milli.min(*lease.model_budgets.get(&plan.binding.model_id).unwrap_or(&lease.budget_milli));
    let reservation =
        cost_milli(&plan.rate.base, &Tokens { input: estimated_input, output: max_output, ..Tokens::default() });
    if reservation > budget || route.base.protocol != "openai_responses" || !loopback(&route.base.base_url, "http") {
        return blocked();
    }
    let Some(key) = view.key(&route.credential_ref).map(|value| Zeroizing::new(value.to_owned())) else {
        return blocked();
    };
    let request_id = crate::id::new("req");
    let attempt_id = crate::id::new("att");
    if !store.reserve_isolated_request(&view.scope, &lease.lease_id, &request_id).unwrap_or(false)
        || !rt.state.isolated_route_execution.load(Ordering::Acquire)
        || rt.state.generation() != generation
    {
        return blocked();
    }

    let base = route.base.base_url.trim_end_matches('/');
    let url = format!("{}/v1/responses", base.strip_suffix("/v1").unwrap_or(base));
    req["model"] = route.base.upstream_model.as_deref().unwrap_or(&route.base.model).into();
    req["store"] = false.into();
    let deadline = Duration::from_millis(plan.pool.attempt_timeout_ms.min(plan.pool.total_timeout_ms));
    let Ok(client) =
        reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(deadline).build()
    else {
        return error(StatusCode::BAD_GATEWAY, "upstream_error", "无法创建隔离上游客户端。");
    };
    let start_at = format_ms(now);
    let Ok(upstream) = client.post(url).bearer_auth(key.as_str()).json(&req).send().await else {
        return error(StatusCode::BAD_GATEWAY, "upstream_error", "上游送达情况待核对。");
    };
    if !upstream.status().is_success() {
        return error(StatusCode::BAD_GATEWAY, "upstream_error", "上游未返回已确认用量。");
    }
    let response_headers = response_headers(upstream.headers());
    let Ok(bytes) = read_limited(upstream, MAX_UPSTREAM_BODY).await else {
        return error(StatusCode::BAD_GATEWAY, "upstream_error", "上游响应不完整。");
    };
    let Ok(result) = serde_json::from_slice::<Value>(&bytes) else {
        return error(StatusCode::BAD_GATEWAY, "upstream_error", "上游响应不包含可核对的用量。");
    };
    let usage = &result["usage"];
    if result["status"] != "completed"
        || !usage["input_tokens"].is_u64()
        || !usage["output_tokens"].is_u64()
        || usage["input_tokens_details"]["cached_tokens"].as_u64().unwrap_or(0)
            > usage["input_tokens"].as_u64().unwrap_or(0)
    {
        return error(StatusCode::BAD_GATEWAY, "upstream_error", "上游响应不包含已确认的终态用量。");
    }
    let counts = responses_usage_to_tokens(usage);
    let cost = cost_milli(&plan.rate.base, &counts);
    if cost > budget {
        return error(StatusCode::BAD_GATEWAY, "upstream_error", "上游报告超出已预留金额，需核对。");
    }
    let receipt = json!({ "request_id": request_id,"session_id": binding.session_id,"lease_id": lease.lease_id,
        "provider_id": route.base.provider_id,"model": model,"model_id": plan.binding.model_id,
        "deployment_id": route.deployment_id,"deployment_revision": route.deployment_revision,"attempt_id": attempt_id,
        "rate_version_id": plan.rate.rate_version_id,"config_revision": view.identity.revision,
        "projection_id": view.identity.projection_id,"input_tokens": counts.input,
        "output_tokens": counts.output,"cache_read_tokens": counts.cache_read,"cache_write_tokens": counts.cache_write,
        "cost_milli": cost,"at": start_at,"status":"ok","complete":true,"measurement_basis":"upstream_usage" });
    if store.complete_isolated_request(&view.scope, &lease.lease_id, &request_id, receipt).is_err() {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "internal", "无法持久化渠道用量。");
    }
    let mut response = Response::new(Body::from(bytes));
    *response.headers_mut() = response_headers;
    response
}
