//! OpenAI 入口：Codex 的 Responses 及受管桌面 Agent 的 Chat Completions。
//! Chat 直通仅接受设备为桌面 Agent 启动所签发的本机令牌。
//!
//! 和 `/v1/messages` 共用本机令牌、租约、计价和 usage 上报（见 `router.rs`），只是入口协议、
//! 请求/响应形状和错误体不同：
//! - 上游 `openai_responses`：同协议转发，只旁路解析用量，不改写请求或响应正文。
//! - 上游 `openai_chat`：Edge 把 Responses 请求转成 Chat，再把 Chat 的响应/流译回 Responses。
//! - 上游 `anthropic`：Responses 入口不做 Responses→Messages，选路时跳过。
//!
//! 用量口径：`input_tokens` 含缓存，计费输入 = `input_tokens − input_tokens_details.cached_tokens`；
//! `output_tokens_details.reasoning_tokens` 只是输出的子集，不单独计费。
//!
//! 错误：还没给客户端发任何响应头时用 `{"error":{"type","code","message"}}`；已经发过响应头
//! （流已经开始）时写一个 `response.failed` 事件，`code` 取 `contracts/errors.md`。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::State as AxState;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::chat;
use crate::id;
use crate::lease::Block;
use crate::outbox::now_ms;
use crate::pricing::cost_milli;
use crate::router::{
    AgentProtocol, MAX_UPSTREAM_BODY, Meter, Outcome, RouteSelectionError, Router, SelectedRoute, Tokens, UsageRecord,
    block_error, header_value, read_limited, response_headers, tokio_stream_from,
};
use crate::sse::{Event, Splitter};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Wire {
    Responses,
    Chat,
}

pub async fn responses(AxState(rt): AxState<Arc<Router>>, headers: HeaderMap, body: Bytes) -> Response {
    if rt.pool_store.is_some() && rt.state.route_pool_engaged() {
        return crate::pool_execution::responses(rt, headers, body).await;
    }
    openai_request(rt, headers, body, Wire::Responses).await
}

pub async fn chat_completions(AxState(rt): AxState<Arc<Router>>, headers: HeaderMap, body: Bytes) -> Response {
    openai_request(rt, headers, body, Wire::Chat).await
}

async fn openai_request(rt: Arc<Router>, headers: HeaderMap, body: Bytes, wire: Wire) -> Response {
    let started = Instant::now();
    let prompt = (wire == Wire::Chat)
        .then(|| rt.state.desktop_sessions.take_deepseek_prompt(&headers, AgentProtocol::Chat))
        .flatten();
    let mut documents = Vec::new();
    let binding = if let Some((binding, attached)) = prompt {
        documents = attached;
        Ok(Some(binding))
    } else if wire == Wire::Responses {
        match rt.state.desktop_sessions.codex_response(&headers).await {
            Ok(Some(binding)) => Ok(Some(binding)),
            Ok(None) => rt.session_for(&headers),
            Err(()) => {
                return err_before_headers(
                    StatusCode::FORBIDDEN,
                    "forbidden",
                    "未能核对本次 Codex Desktop 原生会话和轮次。",
                );
            }
        }
    } else {
        rt.session_for(&headers)
    };
    let Ok(mut binding) = binding else {
        return err_before_headers(
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            "OneX 本机令牌无效。请从 OneX Desktop 重新启动这个 Agent。",
        );
    };

    let agent_protocol = binding.as_ref().and_then(|binding| AgentProtocol::for_agent(&binding.agent));
    let workbuddy = binding.as_ref().is_some_and(|binding| binding.agent == "workbuddy");
    // The signed WorkBuddy custom provider may use its native x-api-key spelling.
    let rejected_key = headers.get("x-api-key").is_some_and(|key| {
        !workbuddy
            || headers
                .get("authorization")
                .is_some_and(|bearer| bearer.as_bytes().strip_prefix(b"Bearer ") != Some(key.as_bytes()))
    });
    let allowed = match wire {
        Wire::Responses => agent_protocol.is_none_or(|protocol| protocol == AgentProtocol::Responses),
        Wire::Chat => agent_protocol == Some(AgentProtocol::Chat) && !rejected_key,
    };
    if !allowed {
        return err_before_headers(StatusCode::FORBIDDEN, "forbidden", "这个本机令牌无权使用该模型接口。");
    }
    if let Some(binding) = &mut binding
        && rt.bind_codex_cli(&headers, binding).await.is_err()
    {
        return err_before_headers(StatusCode::FORBIDDEN, "forbidden", "未能核对本次 Codex CLI 原生会话。");
    }

    let mut req: Value = match serde_json::from_slice(&body) {
        Ok(v @ Value::Object(_)) => v,
        _ => {
            return err_before_headers(StatusCode::UNPROCESSABLE_ENTITY, "invalid", "请求体不是有效的 JSON 对象。");
        }
    };
    let managed_codex = agent_protocol == Some(AgentProtocol::Responses);
    let deepseek = binding.as_ref().is_some_and(|binding| binding.agent == "deepseek-desktop");
    if let Err(message) = crate::desktop_sessions::project_prompt_documents(&mut req, &documents) {
        return err_before_headers(StatusCode::UNPROCESSABLE_ENTITY, "invalid", message);
    }
    let session_id = binding.as_ref().map(|binding| binding.session_id.clone());
    let Some(model) = req.get("model").and_then(Value::as_str) else {
        return err_before_headers(StatusCode::UNPROCESSABLE_ENTITY, "invalid", "请求缺少 model 字段。");
    };
    let model = if workbuddy { model.strip_prefix("custom-local:").unwrap_or(model) } else { model }.to_owned();
    if binding.as_ref().and_then(|claim| claim.approved_model.as_ref()).is_some_and(|approved| approved != &model) {
        return err_before_headers(StatusCode::FORBIDDEN, "model_not_allowed", "该会话本次请求未获准使用此模型。");
    }
    let stream = req.get("stream").and_then(Value::as_bool).unwrap_or(false);

    let protocol = match wire {
        Wire::Responses => AgentProtocol::Responses,
        Wire::Chat => AgentProtocol::Chat,
    };
    let SelectedRoute { mut route, rate, key, mut execution } =
        match rt.route_and_rate(&model, protocol, binding.as_ref()) {
            Ok(selection) => selection,
            Err(RouteSelectionError::ModelNotAllowed) => {
                return err_before_headers(StatusCode::FORBIDDEN, "model_not_allowed", "此模型已不在生效合约中。");
            }
            Err(RouteSelectionError::ReleaseNotAllowed) => {
                return err_before_headers(
                    StatusCode::FORBIDDEN,
                    "agent_not_allowed",
                    "此 Agent 发行已不在生效合约中。",
                );
            }
            Err(RouteSelectionError::BalanceExhausted) => {
                return err_before_headers_block(Block::Cutoff(crate::lease::CutoffReason::Balance));
            }
            Err(RouteSelectionError::RoutePoolPending) => {
                return err_before_headers(
                    StatusCode::FORBIDDEN,
                    "forbidden",
                    crate::router::ROUTE_POOL_PENDING_MESSAGE,
                );
            }
            Err(RouteSelectionError::NotFound) => {
                return err_before_headers(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    &format!("OneX 没有为模型 {model} 配置路由，请联系管理员开通，或换用已开通的模型。"),
                );
            }
            Err(RouteSelectionError::Incompatible(upstream)) => {
                let message = match (wire, upstream.as_str()) {
                    (Wire::Responses, "anthropic") => "该模型的上游协议暂不支持 Codex，请联系管理员调整路由。".into(),
                    _ => format!("此模型接口不支持 {upstream} 协议的上游。"),
                };
                return err_before_headers(StatusCode::FORBIDDEN, "model_not_allowed", &message);
            }
        };
    if deepseek
        && crate::route_select::required_features("openai_chat", &req).contains(crate::route_select::feature::IMAGES)
    {
        if !crate::desktop_sessions::accepts_images(&route) {
            return err_before_headers(
                StatusCode::FORBIDDEN,
                "model_not_allowed",
                "当前签约模型的渠道没有核验图片输入能力。",
            );
        }
        execution.require_verified_images();
    }
    let first_native_session = binding.and_then(|binding| binding.first_native_session);
    let to_chat = wire == Wire::Responses && route.protocol == "openai_chat";
    let Some(rate) = rate else {
        warn!(model = %model, model_id = %route.model_id, "no rate for model");
        return err_before_headers(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            &format!("OneX 还没有收到模型 {model} 的计价配置，请稍后重试；如果持续出现，请联系管理员检查倍率表。"),
        );
    };
    let Some(mut key) = key else {
        return err_before_headers(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "OneX 还没有收到这个模型的上游密钥。请确认 OneX Desktop 已登录并在线，稍后重试。",
        );
    };

    let (url, client) = match execution.prepare(&rt, &mut route, &mut key, "").await {
        Ok(v) => v,
        Err((status, msg)) => {
            return err_before_headers(
                status,
                if status == StatusCode::FORBIDDEN { "forbidden" } else { "upstream_error" },
                msg,
            );
        }
    };
    let (input, output_fields): (&[&str], &[&str]) = match wire {
        Wire::Responses => (&["instructions", "input", "tools"], &["max_output_tokens"]),
        Wire::Chat => (&["messages", "tools", "functions"], &["max_completion_tokens", "max_tokens"]),
    };
    let est_input = crate::router::estimate_request_fields(&req, input);
    let permit = match execution.admit(&rt, &key, est_input, &mut req, output_fields) {
        Ok(permit) => permit,
        Err((code, msg)) => {
            return err_before_headers(
                StatusCode::from_u16(code).unwrap(),
                if code == 429 { "rate_limit" } else { "invalid" },
                msg,
            );
        }
    };
    let upstream_model = route.upstream_model.clone().unwrap_or_else(|| model.clone());
    let kinds = if to_chat { chat_tool_kinds(&req) } else { HashMap::new() };
    let out_body = if wire == Wire::Chat {
        if !req["messages"].as_array().is_some_and(|messages| !messages.is_empty())
            || req.get("n").is_some_and(|n| !n.is_null() && n.as_u64() != Some(1))
        {
            return err_before_headers(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid",
                "请求须提供 messages，且每次生成一条回复。",
            );
        }
        if stream && !req["stream_options"].is_object() {
            req["stream_options"] = json!({});
        }
        if stream {
            req["stream_options"]["include_usage"] = true.into();
        }
        req["model"] = Value::String(upstream_model.clone());
        req["store"] = false.into();
        Bytes::from(serde_json::to_vec(&req).unwrap())
    } else if to_chat {
        if req.get("previous_response_id").is_some_and(|value| !value.is_null()) {
            return err_before_headers(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid",
                "该上游需要关闭服务端会话存储，并在 input 里发送完整对话历史。",
            );
        }
        let chat_req = match request_to_chat(&req, &upstream_model, stream) {
            Ok(v) => v,
            Err(msg) => return err_before_headers(StatusCode::UNPROCESSABLE_ENTITY, "invalid", &msg),
        };
        Bytes::from(serde_json::to_vec(&chat_req).unwrap())
    } else {
        if upstream_model != model || managed_codex || execution.clamps_output() {
            req["model"] = Value::String(upstream_model.clone());
            if managed_codex {
                req["store"] = false.into();
            }
            Bytes::from(serde_json::to_vec(&req).unwrap())
        } else {
            body
        }
    };
    let mut out_headers = HeaderMap::new();
    if !to_chat && wire == Wire::Responses {
        for name in ["content-type", "accept", "openai-beta", "user-agent"] {
            if let Some(value) = headers.get(name) {
                out_headers.insert(name, value.clone());
            }
        }
    }
    out_headers.entry(header::CONTENT_TYPE).or_insert("application/json".parse().unwrap());
    out_headers.insert(header::AUTHORIZATION, header_value(&format!("Bearer {}", key.as_str())));
    out_headers.insert(header::ACCEPT_ENCODING, "identity".parse().unwrap());

    let mut max_output = None;
    for field in output_fields {
        if let Some(value) = req.get(field).filter(|value| !value.is_null()) {
            let Some(tokens) = value.as_u64().filter(|tokens| *tokens > 0 && max_output.is_none()) else {
                return err_before_headers(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "invalid",
                    &format!("{field} 必须是正整数，且只能指定一个输出上限。"),
                );
            };
            max_output = Some(tokens);
        }
    }
    let ticket = match rt.state.lease.admit_model_with(&route.model_id, |remaining| {
        let output =
            max_output.unwrap_or_else(|| crate::pricing::affordable_output_tokens(&rate, est_input, 4096, remaining));
        Meter::new(rate.clone(), output, est_input).reservation
    }) {
        Ok(ticket) => ticket,
        Err(block) => return err_before_headers_block(block),
    };
    rt.state.upstream.lock().unwrap().inflight += 1;

    let rec = UsageRecord {
        request_id: id::new("req"),
        message_id: None,
        provider_id: route.provider_id.clone(),
        model,
        model_id: route.model_id.clone(),
        upstream_model,
        tokens: Tokens::default(),
        usage_final: false,
        cost_milli: 0,
        lease_id: None,
        outcome: Outcome::UpstreamError,
        stream,
        started_at_ms: now_ms(),
        duration_ms: 0,
        session_id,
    };
    let mut req_ctx = ReqCtx {
        rt: rt.clone(),
        rec,
        meter: Meter::new(rate, 0, est_input),
        ticket: Some(ticket),
        permit,
        started,
        output_bytes: 0,
        first_native_session,
    };

    let mut outbound = crate::router::Outbound { client, url, headers: out_headers, body: out_body };
    let resp = loop {
        let resp = tokio::select! {
            biased;
            b = req_ctx.ticket().stopped() => {
                req_ctx.rec.outcome = Outcome::Stopped(b);
                req_ctx.finish();
                return err_before_headers_block(b);
            }
            r = outbound.send() => r,
        };
        match resp {
            Ok(r) => break r,
            Err(e) => {
                let reached = !e.is_connect();
                if !reached {
                    if let Some((provider, model)) =
                        execution.next(&rt, &mut outbound, &mut req_ctx.permit, "", &req_ctx.rec.model, None).await
                    {
                        req_ctx.rec.provider_id = provider;
                        req_ctx.rec.upstream_model = model;
                        continue;
                    }
                }
                warn!(request_id = %req_ctx.rec.request_id, error = %e.without_url(), "responses upstream request failed");
                if reached {
                    req_ctx.meter.tokens.input = est_input;
                }
                req_ctx.rec.usage_final = !reached;
                req_ctx.finish();
                return err_before_headers(
                    StatusCode::BAD_GATEWAY,
                    "upstream_error",
                    "OneX 连接上游模型服务失败，请稍后重试。",
                );
            }
        }
    };

    let status = resp.status();
    if status.is_success() {
        req_ctx.meter.tokens.input = est_input;
    }
    let resp_headers = response_headers(resp.headers());
    let is_sse = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/event-stream"));

    if to_chat {
        return chat_backed_response(req_ctx, resp, status, is_sse, stream, kinds).await;
    }
    native_response(req_ctx, resp, status, is_sse, resp_headers, wire).await
}

/// 进行中的请求：计量、租约票据和收尾。和 `router::Req` 结构类似，但 Responses 的用量口径
/// 和错误体不同，不直接复用它。
struct ReqCtx {
    rt: Arc<Router>,
    rec: UsageRecord,
    meter: Meter,
    output_bytes: usize,
    ticket: Option<crate::lease::Ticket>,
    permit: Option<crate::runtime_gate::Permit>,
    started: Instant,
    first_native_session: Option<tokio::sync::watch::Receiver<Option<String>>>,
}

impl ReqCtx {
    fn ticket(&self) -> &crate::lease::Ticket {
        self.ticket.as_ref().expect("request in progress")
    }

    fn finish(&mut self) {
        let Some(ticket) = self.ticket.take() else { return };
        let rec = &mut self.rec;
        rec.tokens = self.meter.final_tokens(rec.usage_final);
        rec.cost_milli = cost_milli(&self.meter.rate, &rec.tokens);
        rec.lease_id = ticket.finish(rec.cost_milli);
        rec.duration_ms = self.started.elapsed().as_millis() as u64;
        info!(
            request_id = %rec.request_id,
            provider_id = %rec.provider_id,
            model = %rec.model,
            outcome = %rec.outcome.as_str(),
            input = rec.tokens.input,
            output = rec.tokens.output,
            cost_milli = rec.cost_milli,
            usage_final = rec.usage_final,
            duration_ms = rec.duration_ms,
            "responses request done"
        );
        self.rt.note_upstream(rec);
        {
            let mut u = self.rt.state.upstream.lock().unwrap();
            u.inflight = u.inflight.saturating_sub(1);
            u.completed += 1;
        }
        self.rt.note_local_usage(rec);
        self.rt.record_usage(rec.clone(), self.first_native_session.take());
    }

    /// 实时花费超过租约额度时返回 Err，调用方应中断这条流。
    fn check_budget(&mut self) -> Result<(), Block> {
        self.ticket.as_mut().expect("request in progress").update(self.meter.seen_cost())
    }

    fn observe_output(&mut self, bytes: usize) {
        self.output_bytes = self.output_bytes.saturating_add(bytes);
        self.meter.observe_output_bytes(self.output_bytes);
    }

    fn observe_usage(&mut self, usage: &Value) -> bool {
        if ["input_tokens", "output_tokens"].iter().all(|key| usage[*key].is_u64()) {
            self.meter.tokens = responses_usage_to_tokens(usage);
            true
        } else {
            false
        }
    }
}

impl Drop for ReqCtx {
    fn drop(&mut self) {
        if self.ticket.is_some() {
            self.rec.outcome = Outcome::ClientCancelled;
            self.rec.usage_final = false;
            self.finish();
        }
    }
}

/// Responses 的 `usage` → 计费 token。`input_tokens` 本身含缓存命中，扣掉
/// `input_tokens_details.cached_tokens` 才是计费输入；`output_tokens_details.reasoning_tokens`
/// 只是 `output_tokens` 的子集，不单独计入 `Tokens`（`cost_milli` 没有推理 token 的单独单价）。
pub(crate) fn responses_usage_to_tokens(u: &Value) -> Tokens {
    let n = |p: &str| u.pointer(p).and_then(Value::as_u64).unwrap_or(0);
    let input = n("/input_tokens");
    let cached = n("/input_tokens_details/cached_tokens").min(input);
    Tokens { input: input.saturating_sub(cached), output: n("/output_tokens"), cache_read: cached, cache_write: 0 }
}

/// Chat usage → Responses usage，字段名和 Responses 原生一致，供转 Chat 路径下非流式响应及
/// 流式终态拼出完整的 Responses usage 对象用。
fn chat_usage_complete(usage: &Value) -> bool {
    ["prompt_tokens", "completion_tokens"].iter().all(|key| usage[*key].is_u64())
}

fn chat_usage_to_responses(u: &Value) -> Value {
    let n = |p: &str| u.pointer(p).and_then(Value::as_u64).unwrap_or(0);
    let (prompt, cached) = (n("/prompt_tokens"), n("/prompt_tokens_details/cached_tokens"));
    let reasoning = n("/completion_tokens_details/reasoning_tokens");
    let mut v = json!({
        "input_tokens": prompt,
        "input_tokens_details": {"cached_tokens": cached},
        "output_tokens": n("/completion_tokens"),
        "total_tokens": prompt.saturating_add(n("/completion_tokens")),
    });
    if reasoning > 0 {
        v["output_tokens_details"] = json!({"reasoning_tokens": reasoning});
    }
    v
}

/// 未发响应头时的错误：`{"error":{"type","code","message"}}`（`contracts/edge-ws.md` 多 Agent 一节）。
pub(crate) fn err_before_headers(status: StatusCode, code: &str, message: &str) -> Response {
    (status, axum::Json(err_body(error_kind(code), code, message))).into_response()
}

fn err_before_headers_block(b: Block) -> Response {
    let (status, kind, code, message) = block_error(b);
    let message = if matches!(b, Block::TooLarge { .. }) {
        "这次请求预估花费超过单个额度租约的上限，请缩短上下文或联系管理员调高租约额度。"
    } else {
        message
    };
    (status, axum::Json(err_body(kind, code, message))).into_response()
}

fn error_kind(code: &str) -> &'static str {
    match code {
        "unauthenticated" | "model_not_allowed" | "agent_not_allowed" | "forbidden" => "permission_error",
        "invalid" | "not_found" => "invalid_request_error",
        _ => "api_error",
    }
}

fn err_body(kind: &str, code: &str, message: &str) -> Value {
    json!({"error": {"type": kind, "code": code, "message": message}})
}

/// 已发响应头之后（流已经开始）用的终态事件：`response.failed`。
pub(crate) fn response_failed_event(code: &str, message: &str) -> Bytes {
    let body = json!({"type": "response.failed", "response": {"status": "failed",
        "error": {"code": code, "message": message}}});
    Bytes::from(format!("event: response.failed\ndata: {body}\n\n"))
}

// ---- Responses → Chat 请求 ----

/// OpenAI Responses 的 `instructions` + `input`（有序 items）→ Chat 的 `messages`。
/// Converts text, user image URLs, and the supported tool calls and results. File references and
/// other unsupported content need a native Responses upstream.
fn request_to_chat(req: &Value, upstream_model: &str, stream: bool) -> Result<Value, String> {
    let mut msgs = Vec::new();
    let mut system = Vec::new();
    if let Some(instructions) = req["instructions"].as_str().filter(|s| !s.is_empty()) {
        system.push(instructions.to_owned());
    }
    let input = req.get("input").ok_or("请求缺少 input。")?;
    match input {
        Value::String(s) => msgs.push(json!({"role": "user", "content": s})),
        Value::Array(items) => {
            for item in items {
                responses_item_to_chat(item, &mut msgs, &mut system)?;
            }
        }
        _ => return Err("input 的格式无效。".into()),
    }
    // Chat templates such as Qwen accept one system message before the dialogue. Codex
    // can emit developer context after the user item, including during a resumed turn.
    if !system.is_empty() {
        msgs.insert(0, json!({"role": "system", "content": system.join("\n\n")}));
    }
    let mut out = json!({"model": upstream_model, "messages": msgs});
    if let Some(n) = req.get("max_output_tokens") {
        out["max_tokens"] = n.clone();
    }
    for k in ["temperature", "top_p"] {
        if let Some(v) = req.get(k) {
            out[k] = v.clone();
        }
    }
    if stream {
        out["stream"] = true.into();
        out["stream_options"] = json!({"include_usage": true});
    }
    let tools = request_tools(req)
        .into_iter()
        .filter_map(|(tool, namespace)| responses_tool_def(tool, namespace))
        .collect::<Result<Vec<_>, _>>()?;
    let mut names = std::collections::HashSet::new();
    if !tools.iter().all(|tool| names.insert(tool["function"]["name"].as_str())) {
        return Err("转发到 Chat 后存在重名工具。".into());
    }
    if !tools.is_empty() {
        if let Some(tc) = req.get("tool_choice").filter(|tc| !tc.is_null()) {
            out["tool_choice"] = responses_tool_choice(tc)?;
        }
        out["tools"] = tools.into();
    }
    if let Some(parallel) = req["parallel_tool_calls"].as_bool() {
        out["parallel_tool_calls"] = parallel.into();
    }
    Ok(out)
}

fn responses_item_to_chat(item: &Value, msgs: &mut Vec<Value>, system: &mut Vec<String>) -> Result<(), String> {
    let kind = item["type"].as_str().unwrap_or("message");
    match kind {
        "message" => {
            let role = item["role"].as_str().unwrap_or("user");
            if role == "user" {
                let content = responses_user_content(&item["content"])?;
                msgs.push(json!({"role": role, "content": content}));
                return Ok(());
            }
            let text = responses_content_text(&item["content"])?;
            if role == "assistant" {
                let last = assistant_message(msgs);
                let content = last["content"].as_str().unwrap_or("");
                last["content"] = if content.is_empty() { text.into() } else { format!("{content}\n\n{text}").into() };
            } else if matches!(role, "system" | "developer") {
                if !text.is_empty() {
                    system.push(text);
                }
            } else {
                msgs.push(json!({"role": role, "content": text}));
            }
        }
        "reasoning" => {}
        "function_call" | "custom_tool_call" | "local_shell_call" => {
            let call_id = item["call_id"]
                .as_str()
                .or_else(|| item["id"].as_str())
                .filter(|s| !s.is_empty())
                .ok_or("工具调用缺少 call_id。")?;
            let (name, arguments) = match kind {
                "custom_tool_call" => {
                    (item["name"].as_str().unwrap_or(""), json!({"input": item["input"]}).to_string())
                }
                "local_shell_call" => {
                    let action = &item["action"];
                    let mut args = json!({"command": action["command"]});
                    for key in ["workdir", "timeout_ms"] {
                        if let Some(value) = action.get(key) {
                            args[key] = value.clone();
                        }
                    }
                    ("local_shell", args.to_string())
                }
                _ => (item["name"].as_str().unwrap_or(""), item["arguments"].as_str().unwrap_or("{}").to_owned()),
            };
            let name = chat_tool_name(name, item["namespace"].as_str());
            let last = assistant_message(msgs);
            if last["tool_calls"].is_null() {
                last["tool_calls"] = json!([]);
            }
            last["tool_calls"].as_array_mut().unwrap().push(json!({
                "id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}
            }));
        }
        "function_call_output" | "custom_tool_call_output" | "local_shell_call_output" => {
            let call_id = item["call_id"]
                .as_str()
                .or_else(|| item["id"].as_str())
                .filter(|s| !s.is_empty())
                .ok_or("工具结果缺少 call_id。")?;
            let output = match item.get("output") {
                Some(value) if tool_output_has_media(value) => {
                    return Err("Chat 工具结果不支持图像或文件内容，请换用原生 Responses 上游。".into());
                }
                Some(Value::String(s)) => s.clone(),
                Some(v) => v.to_string(),
                None => String::new(),
            };
            msgs.push(json!({"role": "tool", "tool_call_id": call_id, "content": output}));
        }
        other => return Err(format!("OneX 暂不支持转发 {other} 输入条目到 Chat，请换用原生 Responses 上游。")),
    }
    Ok(())
}

fn assistant_message(msgs: &mut Vec<Value>) -> &mut Value {
    if !msgs.last().is_some_and(|message| message["role"] == "assistant") {
        msgs.push(json!({"role": "assistant", "content": null}));
    }
    msgs.last_mut().unwrap()
}

fn responses_user_content(content: &Value) -> Result<Value, String> {
    let Some(parts) = content.as_array().filter(|parts| parts.iter().any(|part| part["type"] == "input_image")) else {
        return responses_content_text(content).map(Value::String);
    };
    let mut chat_parts = Vec::with_capacity(parts.len());
    for part in parts {
        let kind = part["type"].as_str();
        let chat_part = match kind {
            Some("input_text" | "output_text") => json!({"type":"text", "text":part["text"].as_str().unwrap_or("")}),
            Some("input_image") => {
                let url = part["image_url"].as_str().filter(|url| image_url_for_chat(url));
                let Some(url) = url.filter(|_| part["file_id"].is_null()) else {
                    return Err(
                        "Chat 的 input_image 需要有效的图片 URL 或内联图片，文件 ID 需用原生 Responses。".into()
                    );
                };
                let mut image = json!({"url": url});
                if let Some(detail) = part.get("detail").filter(|value| !value.is_null()) {
                    let detail = detail.as_str().ok_or("input_image 的 detail 必须是字符串。")?;
                    image["detail"] = detail.into();
                }
                json!({"type":"image_url", "image_url":image})
            }
            other => return Err(unsupported_content(other)),
        };
        chat_parts.push(chat_part);
    }
    Ok(chat_parts.into())
}

fn image_url_for_chat(url: &str) -> bool {
    if let Some(inline) = url.strip_prefix("data:image/") {
        return inline.split_once(',').is_some_and(|(format, data)| {
            format.strip_suffix(";base64").is_some_and(|mime| !mime.is_empty()) && !data.is_empty()
        });
    }
    reqwest::Url::parse(url).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.has_host()
            && url.username().is_empty()
            && url.password().is_none()
    })
}

fn tool_output_has_media(output: &Value) -> bool {
    let is_media =
        |value: &Value| matches!(value["type"].as_str(), Some("input_image" | "input_file" | "image_url" | "file"));
    is_media(output) || output.as_array().is_some_and(|parts| parts.iter().any(is_media))
}

fn unsupported_content(kind: Option<&str>) -> String {
    format!(
        "OneX 把 Responses 请求转换到 OpenAI Chat 接口时不支持 content 里的 {} 类型，请换用原生 Responses 上游。",
        kind.unwrap_or("?")
    )
}

fn responses_content_text(v: &Value) -> Result<String, String> {
    match v {
        Value::String(s) => Ok(s.clone()),
        Value::Array(parts) => {
            let mut out = Vec::new();
            for p in parts {
                match p.get("type").and_then(Value::as_str) {
                    Some("input_text" | "output_text") => {
                        out.push(p.get("text").and_then(Value::as_str).unwrap_or("").to_string())
                    }
                    other => return Err(unsupported_content(other)),
                }
            }
            Ok(out.join("\n\n"))
        }
        Value::Null => Ok(String::new()),
        _ => Err("message content 的格式无效。".into()),
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum ToolKind {
    #[default]
    Function,
    Custom,
    LocalShell,
}

struct ToolTarget {
    kind: ToolKind,
    name: String,
    namespace: Option<String>,
}

type ToolKinds = HashMap<String, ToolTarget>;

fn request_tools(req: &Value) -> Vec<(&Value, Option<&str>)> {
    let mut tools = Vec::new();
    for tool in req["tools"].as_array().into_iter().flatten() {
        if tool["type"] == "namespace"
            && let (Some(namespace), Some(children)) = (tool["name"].as_str(), tool["tools"].as_array())
        {
            tools.extend(children.iter().map(|child| (child, Some(namespace))));
        } else {
            tools.push((tool, None));
        }
    }
    tools
}

fn chat_tool_name(name: &str, namespace: Option<&str>) -> String {
    let Some(namespace) = namespace else { return name.into() };
    let full = format!("{namespace}__{name}");
    if full.len() <= 64 {
        return full;
    }
    use sha2::{Digest, Sha256};
    let digest = format!("{:x}", Sha256::digest(full.as_bytes()));
    let short: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(48).collect();
    format!("ns_{}_{}", &digest[..12], short)
}

fn chat_tool_kinds(req: &Value) -> ToolKinds {
    request_tools(req)
        .into_iter()
        .filter_map(|(tool, namespace)| {
            let kind = match tool["type"].as_str()? {
                "function" if namespace.is_some() => ToolKind::Function,
                "custom" => ToolKind::Custom,
                "local_shell" => ToolKind::LocalShell,
                _ => return None,
            };
            let name = if kind == ToolKind::LocalShell { "local_shell" } else { tool["name"].as_str()? };
            Some((
                chat_tool_name(name, namespace),
                ToolTarget { kind, name: name.into(), namespace: namespace.map(str::to_owned) },
            ))
        })
        .collect()
}

fn responses_tool_def(tool: &Value, namespace: Option<&str>) -> Option<Result<Value, String>> {
    let kind = tool["type"].as_str().unwrap_or("function");
    let name = if kind == "local_shell" { "local_shell" } else { tool["name"].as_str().unwrap_or("") };
    let parameters = match kind {
        "function" => tool.get("parameters").cloned().unwrap_or(json!({"type": "object"})),
        "custom" => json!({"type": "object", "properties": {"input": {"type": "string"}},
            "required": ["input"], "additionalProperties": false}),
        "local_shell" => json!({"type": "object", "properties": {
            "command": {"type": "array", "items": {"type": "string"}, "minItems": 1},
            "workdir": {"type": "string"}, "timeout_ms": {"type": "integer", "minimum": 0}},
            "required": ["command"], "additionalProperties": false}),
        "web_search"
        | "web_search_preview"
        | "file_search"
        | "code_interpreter"
        | "image_generation"
        | "computer_use_preview"
        | "mcp"
        | "tool_search" => return None,
        other => return Some(Err(format!("OneX 暂不支持转发 {other} 工具到 Chat。"))),
    };
    if name.is_empty() {
        return Some(Err("工具定义缺少 name。".into()));
    }
    let mut function = json!({"name": chat_tool_name(name, namespace), "parameters": parameters});
    if let Some(description) = tool["description"].as_str() {
        function["description"] = description.into();
    }
    Some(Ok(json!({"type": "function", "function": function})))
}

fn responses_tool_choice(tc: &Value) -> Result<Value, String> {
    match tc {
        Value::String(s) if matches!(s.as_str(), "auto" | "none" | "required") => Ok(json!(s)),
        Value::Object(o)
            if matches!(o.get("type").and_then(Value::as_str), Some("function" | "custom" | "local_shell")) =>
        {
            let name = o.get("name").and_then(Value::as_str).unwrap_or("local_shell");
            let name = chat_tool_name(name, o.get("namespace").and_then(Value::as_str));
            Ok(json!({"type": "function", "function": {"name": name}}))
        }
        other => Err(format!("不支持的 tool_choice {other:?}。")),
    }
}

// ---- 同协议转发（上游 openai_responses） ----

/// 同协议转发：正文原样转给客户端，只旁路解析用量。流式边转发边从 `response.completed`/
/// `response.incomplete`/`response.failed` 里取 `usage`；非流式读完整个响应体后从顶层 `usage` 取。
async fn native_response(
    mut req: ReqCtx,
    resp: reqwest::Response,
    status: StatusCode,
    is_sse: bool,
    resp_headers: HeaderMap,
    wire: Wire,
) -> Response {
    if status.is_success() && is_sse {
        let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(16);
        tokio::spawn(native_pump(req, resp, tx, wire));
        let body = Body::from_stream(tokio_stream_from(rx));
        return (status, resp_headers, body).into_response();
    }
    let body = tokio::select! {
        body = read_limited(resp, MAX_UPSTREAM_BODY) => body,
        block = req.ticket().stopped() => {
            req.rec.outcome = Outcome::Stopped(block);
            req.finish();
            return err_before_headers_block(block);
        }
    };
    let bytes = match body {
        Ok(b) => b,
        Err(e) => {
            warn!(request_id = %req.rec.request_id, error = %e, "responses upstream body read failed");
            req.finish();
            return err_before_headers(StatusCode::BAD_GATEWAY, "upstream_error", "上游模型服务的响应中断，请重试。");
        }
    };
    if status.is_success() {
        req.rec.outcome = Outcome::Ok;
        if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
            req.rec.message_id = v.get("id").and_then(Value::as_str).map(str::to_owned);
            req.rec.usage_final = match wire {
                Wire::Responses => req.observe_usage(&v["usage"]),
                Wire::Chat => observe_chat_usage(&mut req, &v["usage"]),
            };
            if !req.rec.usage_final {
                match wire {
                    Wire::Responses => req.observe_output(output_bytes(&v["output"])),
                    Wire::Chat => req.observe_output(chat_output_bytes(&v["choices"], "message")),
                }
            }
        }
        if !req.rec.usage_final {
            warn!(request_id = %req.rec.request_id, "responses upstream response has no usage");
        }
        if let Err(b) = req.check_budget() {
            req.rec.outcome = Outcome::Stopped(b);
            req.finish();
            return err_before_headers_block(b);
        }
    } else {
        req.rec.outcome = Outcome::UpstreamStatus(status.as_u16());
        req.rec.usage_final = true;
        req.finish();
        let (_, message) = chat::error_to_anthropic(status.as_u16(), &bytes);
        return err_before_headers(StatusCode::BAD_GATEWAY, "upstream_error", &message);
    }
    req.finish();
    (status, resp_headers, bytes).into_response()
}

/// 同协议 SSE 的旁路计量：不改写任何字节，只在 `response.completed`/`incomplete`/`failed` 的
/// `response.usage` 里取用量；没见过终态就 EOF 判为截断。
async fn native_pump(
    mut req: ReqCtx,
    mut resp: reqwest::Response,
    tx: mpsc::Sender<Result<Bytes, std::io::Error>>,
    wire: Wire,
) {
    let mut split = Splitter::default();
    let mut stopped_by: Option<Block> = None;
    let mut native_failure = false;
    let outcome = 'pump: loop {
        let chunk = tokio::select! {
            _ = tx.closed() => break Outcome::ClientCancelled,
            b = req.ticket().stopped() => { stopped_by = Some(b); break Outcome::Stopped(b); }
            c = resp.chunk() => c,
        };
        match chunk {
            Ok(Some(c)) => {
                let batch = split.push_framed(&c);
                let mut boundary = batch.raw.len();
                let mut terminal = None;
                let mut previous = 0;
                for (end, ev) in &batch.events {
                    let boundary_before_error = previous;
                    terminal = match wire {
                        Wire::Responses => observe_native(&mut req, ev),
                        Wire::Chat => observe_native_chat(&mut req, ev),
                    };
                    if let Err(block) = req.check_budget() {
                        stopped_by = Some(block);
                        boundary = previous;
                        break;
                    }
                    previous = *end;
                    if terminal.is_some() {
                        boundary = if wire == Wire::Chat && terminal == Some(Outcome::UpstreamError) {
                            boundary_before_error
                        } else {
                            *end
                        };
                        break;
                    }
                }
                if boundary > 0 {
                    let raw = batch.raw.slice(..boundary);
                    let sent = if stopped_by.is_some() {
                        tokio::time::timeout(Duration::from_secs(1), tx.send(Ok(raw)))
                            .await
                            .is_ok_and(|result| result.is_ok())
                    } else {
                        tokio::select! {
                            r = tx.send(Ok(raw)) => r.is_ok(),
                            block = req.ticket().stopped() => {
                                stopped_by = Some(block);
                                break 'pump Outcome::Stopped(block);
                            }
                        }
                    };
                    if !sent && stopped_by.is_none() {
                        break Outcome::ClientCancelled;
                    }
                }
                if let Some(block) = stopped_by {
                    break Outcome::Stopped(block);
                }
                if let Some(outcome) = terminal {
                    native_failure = wire == Wire::Responses && outcome == Outcome::UpstreamError;
                    break outcome;
                }
                if batch.oversized {
                    warn!(request_id = %req.rec.request_id, "responses upstream SSE line or event exceeded the byte limit");
                    break Outcome::UpstreamError;
                }
            }
            Ok(None) => {
                warn!(request_id = %req.rec.request_id, partial = split.has_partial(), "responses upstream stream ended before a terminal event");
                break Outcome::UpstreamError;
            }
            Err(e) => {
                warn!(request_id = %req.rec.request_id, error = %e.without_url(), "responses upstream stream error");
                break Outcome::UpstreamError;
            }
        }
    };
    drop(resp);
    if let Some(b) = stopped_by {
        let (_, _, code, msg) = block_error(b);
        let _ = tokio::time::timeout(
            Duration::from_secs(1),
            tx.send(Ok(native_failed_event(wire, code, &format!("{msg}本次回复已被中断。")))),
        )
        .await;
    } else if outcome == Outcome::UpstreamError && !native_failure {
        let _ = tokio::time::timeout(
            Duration::from_secs(1),
            tx.send(Ok(native_failed_event(
                wire,
                "upstream_error",
                "上游模型服务的连接中断，本次回复不完整，请重试。",
            ))),
        )
        .await;
    }
    req.rec.outcome = outcome;
    req.finish();
}

fn native_failed_event(wire: Wire, code: &str, message: &str) -> Bytes {
    match wire {
        Wire::Responses => response_failed_event(code, message),
        Wire::Chat => Bytes::from(format!("data: {}\n\n", err_body(error_kind(code), code, message))),
    }
}

fn observe_chat_usage(req: &mut ReqCtx, usage: &Value) -> bool {
    chat_usage_complete(usage) && req.observe_usage(&chat_usage_to_responses(usage))
}

fn observe_native_chat(req: &mut ReqCtx, ev: &Event) -> Option<Outcome> {
    if ev.data.trim() == "[DONE]" {
        return Some(Outcome::Ok);
    }
    let value: Value = serde_json::from_str(&ev.data).ok()?;
    if req.rec.message_id.is_none() {
        req.rec.message_id = value["id"].as_str().map(str::to_owned);
    }
    if observe_chat_usage(req, &value["usage"]) {
        req.rec.usage_final = true;
    }
    req.observe_output(chat_output_bytes(&value["choices"], "delta"));
    value.get("error").filter(|error| !error.is_null()).map(|_| Outcome::UpstreamError)
}

fn chat_output_bytes(choices: &Value, field: &str) -> usize {
    let bytes = |value: &Value| value.as_str().map_or(0, str::len);
    choices
        .as_array()
        .into_iter()
        .flatten()
        .map(|choice| {
            let message = &choice[field];
            let tools = message["tool_calls"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|tool| bytes(&tool["function"]["name"]) + bytes(&tool["function"]["arguments"]))
                .sum::<usize>();
            bytes(&message["content"])
                + bytes(&message["reasoning_content"])
                + bytes(&message["refusal"])
                + tools
                + bytes(&message["function_call"]["arguments"])
        })
        .sum()
}

fn observe_native(req: &mut ReqCtx, ev: &Event) -> Option<Outcome> {
    let value: Value = serde_json::from_str(&ev.data).ok()?;
    match ev.event.as_deref().or_else(|| value["type"].as_str())? {
        "response.output_text.delta"
        | "response.function_call_arguments.delta"
        | "response.custom_tool_call_input.delta"
        | "response.refusal.delta"
        | "response.reasoning_text.delta" => {
            req.observe_output(value["delta"].as_str().map_or(0, str::len));
            None
        }
        kind @ ("response.completed" | "response.incomplete" | "response.failed") => {
            req.rec.message_id = value.pointer("/response/id").and_then(Value::as_str).map(str::to_owned);
            let usage = req.observe_usage(&value["response"]["usage"]);
            req.rec.usage_final = usage && kind != "response.failed";
            if !usage && req.output_bytes == 0 {
                req.observe_output(output_bytes(&value["response"]["output"]));
            }
            Some(if kind == "response.failed" { Outcome::UpstreamError } else { Outcome::Ok })
        }
        _ => None,
    }
}

fn output_bytes(items: &Value) -> usize {
    items
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| match item["type"].as_str() {
            Some("message") => item["content"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|part| part["text"].as_str().or_else(|| part["refusal"].as_str()).map_or(0, str::len))
                .sum::<usize>(),
            Some("function_call") => item["arguments"].as_str().map_or(0, str::len),
            Some("custom_tool_call") => item["input"].as_str().map_or(0, str::len),
            Some("local_shell_call") => item["action"].to_string().len(),
            _ => 0,
        })
        .sum()
}

// ---- 转 Chat（上游 openai_chat） ----

/// Chat 上游的响应：流开始前的错误转成 Responses 错误；SSE 边译边转；非流式整包转换。
async fn chat_backed_response(
    mut req: ReqCtx,
    resp: reqwest::Response,
    status: StatusCode,
    is_sse: bool,
    stream: bool,
    kinds: ToolKinds,
) -> Response {
    if status.is_success() && is_sse && stream {
        let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(16);
        tokio::spawn(chat_pump(req, resp, tx, kinds));
        let headers = [(header::CONTENT_TYPE, "text/event-stream"), (header::CACHE_CONTROL, "no-cache")];
        return (StatusCode::OK, headers, Body::from_stream(tokio_stream_from(rx))).into_response();
    }
    let bytes = match read_limited(resp, MAX_UPSTREAM_BODY).await {
        Ok(b) => b,
        Err(e) => {
            warn!(request_id = %req.rec.request_id, error = %e, "responses chat upstream body read failed");
            req.finish();
            return err_before_headers(StatusCode::BAD_GATEWAY, "upstream_error", "上游模型服务的响应中断，请重试。");
        }
    };
    if !status.is_success() {
        req.rec.outcome = Outcome::UpstreamStatus(status.as_u16());
        req.rec.usage_final = true;
        req.finish();
        // 复用 chat.rs 的错误文本提取（含 "prompt is too long" 识别），错误类别不需要
        // Anthropic 的 error.type，这里统一用 errors.md 的 upstream_error。
        let (_, msg) = chat::error_to_anthropic(status.as_u16(), &bytes);
        return err_before_headers(StatusCode::BAD_GATEWAY, "upstream_error", &msg);
    }
    let parsed = if is_sse {
        collect_chat_sse_to_responses(&bytes, kinds)
    } else {
        serde_json::from_slice::<Value>(&bytes)
            .map_err(|_| "上游响应不是有效的 JSON。".to_string())
            .and_then(|v| chat_response_to_responses_with_tools(&v, &kinds))
    };
    match parsed {
        Ok((body, has_usage)) => {
            req.rec.usage_final = has_usage && req.observe_usage(&body["usage"]);
            if !req.rec.usage_final {
                req.observe_output(output_bytes(&body["output"]));
            }
            req.rec.outcome = Outcome::Ok;
            if let Err(b) = req.check_budget() {
                req.rec.outcome = Outcome::Stopped(b);
                req.finish();
                return err_before_headers_block(b);
            }
            req.finish();
            axum::Json(body).into_response()
        }
        Err(e) => {
            warn!(request_id = %req.rec.request_id, error = %e, "responses chat conversion failed");
            req.finish();
            err_before_headers(StatusCode::BAD_GATEWAY, "upstream_error", &format!("OneX 无法转换上游模型的响应：{e}"))
        }
    }
}

/// 非流式 Chat 响应 → Responses 响应体。返回 (body, 是否有 usage)。
#[cfg(test)]
fn chat_response_to_responses(v: &Value) -> Result<(Value, bool), String> {
    chat_response_to_responses_with_tools(v, &ToolKinds::new())
}

fn chat_response_to_responses_with_tools(v: &Value, kinds: &ToolKinds) -> Result<(Value, bool), String> {
    if let Some(e) = v.get("error") {
        let msg = match e {
            Value::String(s) => s.clone(),
            _ => e.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
        };
        return Err(msg.chars().take(500).collect());
    }
    let choices = v.get("choices").and_then(Value::as_array).ok_or("上游响应缺少 choices。")?;
    let c = choices.first().ok_or("上游响应没有内容。")?;
    let msg = &c["message"];
    let mut output = Vec::new();
    let mut content = Vec::new();
    if let Some(t) = msg.get("content").and_then(Value::as_str).filter(|t| !t.is_empty()) {
        content.push(json!({"type": "output_text", "text": t, "annotations": []}));
    }
    if !content.is_empty() {
        output.push(json!({"type": "message", "id": id::new("msg"), "role": "assistant", "status": "completed", "content": content}));
    }
    for tc in msg.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
        let args = tc.pointer("/function/arguments").and_then(Value::as_str).unwrap_or("{}");
        let name = tc.pointer("/function/name").and_then(Value::as_str).unwrap_or("");
        let call_id =
            tc["id"].as_str().filter(|id| !id.is_empty()).map(str::to_owned).unwrap_or_else(|| id::new("call"));
        output.push(tool_output_item(kinds.get(name), &id::new("fc"), &call_id, name, args, "completed"));
    }
    let finish = c.get("finish_reason").and_then(Value::as_str).unwrap_or("stop");
    let usage = v.get("usage").filter(|u| chat_usage_complete(u));
    let body = json!({
        "id": id::new("resp"),
        "object": "response",
        "status": if finish == "length" { "incomplete" } else { "completed" },
        "output": output,
        "usage": usage.map(chat_usage_to_responses).unwrap_or(Value::Null),
    });
    Ok((body, usage.is_some()))
}

/// 一整段 Chat SSE（非流式客户端但上游仍吐 SSE）聚合成一个 Responses 响应体。
fn collect_chat_sse_to_responses(bytes: &[u8], kinds: ToolKinds) -> Result<(Value, bool), String> {
    let mut split = Splitter::default();
    let mut tr = ResponsesStreamTranslator::with_tools(kinds);
    let mut out = Vec::new();
    let mut done = false;
    for chunk in [bytes, b"\n\n"] {
        let batch = split.push_framed(chunk);
        for (_, event) in &batch.events {
            if tr.push(event, &mut out) {
                done = true;
                break;
            }
        }
        if batch.oversized {
            return Err("上游的流式响应单行或单个事件超过了字节上限。".to_string());
        }
        if done {
            break;
        }
    }
    if !done {
        done = tr.eof(&mut out);
    }
    if !done {
        return Err("上游的流式响应不完整。".into());
    }
    let completed = out
        .iter()
        .rev()
        .find(|ev| matches!(ev.event.as_deref(), Some("response.completed" | "response.incomplete")))
        .ok_or("上游的流式响应没有终态事件。")?;
    let v: Value = serde_json::from_str(&completed.data).map_err(|_| "终态事件不是有效 JSON。".to_string())?;
    let has_usage = v.pointer("/response/usage").is_some();
    Ok((v["response"].clone(), has_usage))
}

/// 把上游 Chat SSE 转发给客户端（译成 Responses SSE），直到结束、出错、客户端断开或租约中断。
async fn chat_pump(
    mut req: ReqCtx,
    mut resp: reqwest::Response,
    tx: mpsc::Sender<Result<Bytes, std::io::Error>>,
    kinds: ToolKinds,
) {
    let mut split = Splitter::default();
    let mut tr = ResponsesStreamTranslator::with_tools(kinds);
    let mut translated = Vec::new();
    let mut stopped_by: Option<Block> = None;
    // true 表示 translator 自己已经吐过一个带上游原话的 response.failed，收尾时不再补发泛化的那个。
    let mut upstream_errored = false;
    let outcome = 'pump: loop {
        let chunk = tokio::select! {
            _ = tx.closed() => break Outcome::ClientCancelled,
            b = req.ticket().stopped() => { stopped_by = Some(b); break Outcome::Stopped(b); }
            c = resp.chunk() => c,
        };
        match chunk {
            Ok(Some(c)) => {
                let batch = split.push_framed(&c);
                translated.clear();
                let mut done = false;
                for (_, ev) in &batch.events {
                    if tr.push(ev, &mut translated) {
                        done = true;
                        upstream_errored =
                            translated.last().is_some_and(|e| e.event.as_deref() == Some("response.failed"));
                        break;
                    }
                }
                req.output_bytes = tr.output_bytes;
                req.meter.observe_output_bytes(tr.output_bytes);
                if let Some(usage) = &tr.usage {
                    req.observe_usage(&chat_usage_to_responses(usage));
                }
                let out = chat::encode(&translated);
                if !batch.events.is_empty()
                    && let Err(b) = req.check_budget()
                {
                    stopped_by = Some(b);
                    break Outcome::Stopped(b);
                }
                if !out.is_empty() {
                    let sent = tokio::select! {
                        r = tx.send(Ok(out)) => r.is_ok(),
                        b = req.ticket().stopped() => { stopped_by = Some(b); break 'pump Outcome::Stopped(b); }
                    };
                    if !sent {
                        break Outcome::ClientCancelled;
                    }
                }
                if done {
                    break if upstream_errored { Outcome::UpstreamError } else { Outcome::Ok };
                }
                if batch.oversized {
                    warn!(request_id = %req.rec.request_id, "responses chat upstream SSE line or event exceeded the byte limit");
                    break Outcome::UpstreamError;
                }
            }
            Ok(None) => {
                translated.clear();
                if tr.eof(&mut translated) {
                    let out = chat::encode(&translated);
                    if let Err(b) = req.check_budget() {
                        stopped_by = Some(b);
                        break Outcome::Stopped(b);
                    }
                    let _ = tokio::time::timeout(Duration::from_secs(1), tx.send(Ok(out))).await;
                    break Outcome::Ok;
                }
                warn!(request_id = %req.rec.request_id, "responses chat upstream ended without finish_reason");
                break Outcome::UpstreamError;
            }
            Err(e) => {
                warn!(request_id = %req.rec.request_id, error = %e.without_url(), "responses chat upstream stream error");
                break Outcome::UpstreamError;
            }
        }
    };
    drop(resp);
    req.rec.usage_final = matches!(outcome, Outcome::Ok) && tr.has_usage();
    // upstream_errored 为真时 translator 自己已经吐过一个带着上游原话的 response.failed，
    // 不能在这里再补发一个泛化的，否则客户端会看到两个终态事件，后一个还盖掉了有用的错误原文。
    if let Some(b) = stopped_by {
        let (_, _, code, msg) = block_error(b);
        let _ = tokio::time::timeout(
            Duration::from_secs(1),
            tx.send(Ok(response_failed_event(code, &format!("{msg}本次回复已被中断。")))),
        )
        .await;
    } else if outcome == Outcome::UpstreamError && !upstream_errored {
        let _ = tokio::time::timeout(
            Duration::from_secs(1),
            tx.send(Ok(response_failed_event("upstream_error", "上游模型服务的连接中断，本次回复不完整，请重试。"))),
        )
        .await;
    }
    req.rec.outcome = outcome;
    req.finish();
}

/// 把 Chat SSE 事件逐个译成 Responses SSE 事件。只跟第一个带正文或结束原因的 choice
/// （和 `chat::StreamTranslator` 同一个简化假设）：一条文本 message item，工具调用各自一个
/// function_call item；用 output_index 跟踪 item 生命周期。
struct ToolCall {
    key: u64,
    id: String,
    call_id: String,
    name: String,
    args: String,
    output_index: Option<usize>,
    announced: bool,
}

struct ResponsesStreamTranslator {
    id: String,
    created: bool,
    choice: Option<u64>,
    next_output_index: usize,
    text_index: Option<usize>,
    text_id: String,
    text: String,
    kinds: ToolKinds,
    output_bytes: usize,
    tools: Vec<ToolCall>,
    finish: Option<String>,
    usage: Option<Value>,
    done: bool,
}

impl ResponsesStreamTranslator {
    #[cfg(test)]
    fn new() -> Self {
        Self::with_tools(ToolKinds::new())
    }

    fn with_tools(kinds: ToolKinds) -> Self {
        Self {
            id: id::new("resp"),
            created: false,
            choice: None,
            next_output_index: 0,
            text_index: None,
            text_id: id::new("msg"),
            text: String::new(),
            kinds,
            output_bytes: 0,
            tools: Vec::new(),
            finish: None,
            usage: None,
            done: false,
        }
    }

    fn has_usage(&self) -> bool {
        self.usage.is_some()
    }

    /// 返回 true 表示已经输出了终态事件（`response.completed`/`response.incomplete`/`response.failed`）。
    fn push(&mut self, ev: &Event, out: &mut Vec<Event>) -> bool {
        if self.done {
            return true;
        }
        let data = ev.data.trim();
        if data == "[DONE]" {
            return self.finish_stream(out);
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            warn!(len = data.len(), "unparsable chat stream frame in responses translation");
            return false;
        };
        if let Some(e) = v.get("error") {
            self.ensure_created(out);
            let msg = e.get("message").and_then(Value::as_str).unwrap_or("上游模型服务报错").to_string();
            out.push(responses_event(
                "response.failed",
                json!({"type": "response.failed",
                "response": {"id": self.id, "status": "failed",
                    "error": {"code": "upstream_error", "message": msg}}}),
            ));
            self.done = true;
            return true;
        }
        for c in v.get("choices").and_then(Value::as_array).into_iter().flatten() {
            self.choice_delta(c, out);
        }
        if let Some(u) = v.get("usage").filter(|u| chat_usage_complete(u)) {
            self.usage = Some(u.clone());
        }
        false
    }

    /// 上游连接结束。见过 finish_reason 就算正常结束；否则截断，调用方补 `response.failed`。
    fn eof(&mut self, out: &mut Vec<Event>) -> bool {
        if self.done {
            return true;
        }
        if self.finish.is_some() { self.finish_stream(out) } else { false }
    }

    fn finish_stream(&mut self, out: &mut Vec<Event>) -> bool {
        let Some(finish) = self.finish.clone() else { return false };
        self.ensure_created(out);
        self.close_all(out);
        let output = self.output_items();
        let status = if finish == "length" { "incomplete" } else { "completed" };
        let usage = self.usage.as_ref().map(chat_usage_to_responses).unwrap_or(Value::Null);
        let event_name = format!("response.{}", if status == "completed" { "completed" } else { "incomplete" });
        out.push(responses_event(
            &event_name,
            json!({"type": event_name, "response": {
            "id": self.id, "object": "response", "status": status, "output": output, "usage": usage}}),
        ));
        self.done = true;
        true
    }

    fn output_items(&self) -> Vec<Value> {
        let mut items: Vec<(usize, Value)> = Vec::new();
        if let Some(i) = self.text_index {
            items.push((i, self.text_item()));
        }
        for t in &self.tools {
            if let Some(i) = t.output_index {
                items.push((i, self.tool_item(t, &t.args, "completed")));
            }
        }
        items.sort_by_key(|(i, _)| *i);
        items.into_iter().map(|(_, v)| v).collect()
    }

    fn ensure_created(&mut self, out: &mut Vec<Event>) {
        if self.created {
            return;
        }
        self.created = true;
        out.push(responses_event(
            "response.created",
            json!({"type": "response.created", "response": {"id": self.id, "object": "response", "status": "in_progress"}}),
        ));
    }

    fn choice_delta(&mut self, c: &Value, out: &mut Vec<Event>) {
        let idx = index_of(c.get("index"));
        let d = c.get("delta").unwrap_or(&Value::Null);
        let text = d.get("content").and_then(Value::as_str).filter(|s| !s.is_empty());
        let calls = d.get("tool_calls").and_then(Value::as_array).filter(|a| !a.is_empty());
        let finish = c.get("finish_reason").and_then(Value::as_str);
        let substantive = text.is_some() || calls.is_some() || finish.is_some();
        match (self.choice, idx) {
            (None, _) if !substantive => return,
            (None, i) => self.choice = Some(i.unwrap_or(0)),
            (Some(ch), Some(i)) if ch != i => return,
            _ => {}
        }
        self.ensure_created(out);
        if let Some(t) = text {
            self.output_bytes = self.output_bytes.saturating_add(t.len());
            self.text_delta(t, out);
        }
        for tc in calls.into_iter().flatten() {
            self.output_bytes = self
                .output_bytes
                .saturating_add(tc.pointer("/function/arguments").and_then(Value::as_str).map_or(0, str::len));
            self.tool_delta(tc, out);
        }
        if let Some(f) = finish {
            self.finish = Some(f.to_string());
        }
    }

    fn text_item(&self) -> Value {
        json!({"type": "message", "id": self.text_id, "role": "assistant", "status": "completed",
            "content": [{"type": "output_text", "text": self.text, "annotations": []}]})
    }

    fn tool_item(&self, tool: &ToolCall, args: &str, status: &str) -> Value {
        tool_output_item(self.kinds.get(&tool.name), &tool.id, &tool.call_id, &tool.name, args, status)
    }

    fn text_delta(&mut self, text: &str, out: &mut Vec<Event>) {
        let index = match self.text_index {
            Some(index) => index,
            None => {
                let index = self.next_output_index;
                self.next_output_index += 1;
                self.text_index = Some(index);
                out.push(responses_event(
                    "response.output_item.added",
                    json!({
                        "output_index": index, "item": {"type": "message", "id": self.text_id,
                            "role": "assistant", "status": "in_progress", "content": []}
                    }),
                ));
                out.push(responses_event(
                    "response.content_part.added",
                    json!({
                        "output_index": index, "item_id": self.text_id, "content_index": 0,
                        "part": {"type": "output_text", "text": "", "annotations": []}
                    }),
                ));
                index
            }
        };
        self.text.push_str(text);
        out.push(responses_event(
            "response.output_text.delta",
            json!({
                "output_index": index, "item_id": self.text_id, "content_index": 0, "delta": text
            }),
        ));
    }

    fn tool_delta(&mut self, tc: &Value, out: &mut Vec<Event>) {
        let key = index_of(tc.get("index")).unwrap_or(0);
        let pos = match self.tools.iter().position(|t| t.key == key) {
            Some(p) => p,
            None => {
                let call_id = tc.get("id").and_then(Value::as_str).filter(|s| !s.is_empty());
                self.tools.push(ToolCall {
                    key,
                    id: id::new("fc"),
                    call_id: call_id.map(str::to_owned).unwrap_or_else(|| id::new("call")),
                    name: String::new(),
                    args: String::new(),
                    output_index: None,
                    announced: false,
                });
                self.tools.len() - 1
            }
        };
        let frag = tc.pointer("/function/arguments").and_then(Value::as_str).unwrap_or("");
        let name = tc.pointer("/function/name").and_then(Value::as_str).unwrap_or("");
        let t = &mut self.tools[pos];
        if t.name.is_empty() && !name.is_empty() {
            t.name = name.to_string();
        }
        if t.output_index.is_none() && !t.name.is_empty() {
            self.next_output_index += 1;
            t.output_index = Some(self.next_output_index - 1);
        }
        let Some(i) = t.output_index else {
            // 还没见到工具名，先缓冲参数片段
            t.args.push_str(frag);
            return;
        };
        let target = self.kinds.get(&t.name);
        let kind = target.map(|tool| tool.kind).unwrap_or_default();
        if !t.announced {
            t.announced = true;
            out.push(responses_event(
                "response.output_item.added",
                json!({
                    "output_index": i, "item": tool_output_item(target, &t.id, &t.call_id, &t.name, "", "in_progress")
                }),
            ));
            if kind == ToolKind::Function && !t.args.is_empty() {
                out.push(responses_event(
                    "response.function_call_arguments.delta",
                    json!({"output_index": i, "item_id": t.id, "delta": t.args}),
                ));
            }
        }
        if kind == ToolKind::Function && !frag.is_empty() {
            out.push(responses_event(
                "response.function_call_arguments.delta",
                json!({"output_index": i, "item_id": t.id, "delta": frag}),
            ));
        }
        t.args.push_str(frag);
    }

    fn close_all(&self, out: &mut Vec<Event>) {
        if let Some(index) = self.text_index {
            let item = self.text_item();
            out.push(responses_event(
                "response.output_text.done",
                json!({
                    "output_index": index, "item_id": self.text_id, "content_index": 0, "text": self.text
                }),
            ));
            out.push(responses_event(
                "response.content_part.done",
                json!({
                    "output_index": index, "item_id": self.text_id, "content_index": 0, "part": item["content"][0]
                }),
            ));
            out.push(responses_event("response.output_item.done", json!({"output_index": index, "item": item})));
        }
        for tool in &self.tools {
            let Some(index) = tool.output_index else { continue };
            let item = self.tool_item(tool, &tool.args, "completed");
            match item["type"].as_str() {
                Some("function_call") => out.push(responses_event(
                    "response.function_call_arguments.done",
                    json!({"output_index": index, "item_id": tool.id, "arguments": tool.args}),
                )),
                Some("custom_tool_call") => out.push(responses_event(
                    "response.custom_tool_call_input.done",
                    json!({"output_index": index, "item_id": tool.id, "input": item["input"]}),
                )),
                _ => {}
            }
            out.push(responses_event("response.output_item.done", json!({"output_index": index, "item": item})));
        }
    }
}

fn tool_output_item(
    target: Option<&ToolTarget>,
    id: &str,
    call_id: &str,
    name: &str,
    arguments: &str,
    status: &str,
) -> Value {
    let kind = target.map(|tool| tool.kind).unwrap_or_default();
    let name = target.map_or(name, |tool| tool.name.as_str());
    let mut item = match kind {
        ToolKind::Function => json!({"type": "function_call", "id": id, "call_id": call_id,
            "name": name, "arguments": arguments, "status": status}),
        ToolKind::Custom => {
            let value = serde_json::from_str::<Value>(arguments).unwrap_or(Value::Null);
            let input = value["input"].as_str().unwrap_or("");
            json!({"type": "custom_tool_call", "id": id, "call_id": call_id, "name": name, "input": input, "status": status})
        }
        ToolKind::LocalShell => {
            let value = serde_json::from_str::<Value>(arguments).unwrap_or(Value::Null);
            let command = value["command"].as_array().cloned().unwrap_or_default();
            let mut action = json!({"type": "exec", "command": command});
            for key in ["workdir", "timeout_ms"] {
                if let Some(value) = value.get(key) {
                    action[key] = value.clone();
                }
            }
            json!({"type": "local_shell_call", "id": id, "call_id": call_id, "status": status, "action": action})
        }
    };
    if let Some(namespace) = target.and_then(|tool| tool.namespace.as_deref()) {
        item["namespace"] = namespace.into();
    }
    item
}

fn responses_event(name: &str, mut data: Value) -> Event {
    data["type"] = name.into();
    Event { event: Some(name.into()), data: data.to_string() }
}

fn index_of(v: Option<&Value>) -> Option<u64> {
    match v? {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(e: &str, d: Value) -> Event {
        Event { event: Some(e.into()), data: d.to_string() }
    }

    /// Chat SSE 的 `[DONE]` 是裸文本，不是 JSON 字符串字面量。
    fn done() -> Event {
        Event { event: None, data: "[DONE]".into() }
    }

    #[test]
    fn usage_mapping_responses_native() {
        let u = json!({"input_tokens": 1000, "input_tokens_details": {"cached_tokens": 300},
            "output_tokens": 50, "output_tokens_details": {"reasoning_tokens": 20}});
        let t = responses_usage_to_tokens(&u);
        // 计费输入 = input_tokens - cached_tokens；reasoning 只是 output 的子集，不单独计入
        assert_eq!(t, Tokens { input: 700, output: 50, cache_read: 300, cache_write: 0 });
    }

    #[test]
    fn usage_mapping_chat_to_responses() {
        let u = json!({"prompt_tokens": 1000, "prompt_tokens_details": {"cached_tokens": 300},
            "completion_tokens": 50, "completion_tokens_details": {"reasoning_tokens": 20}});
        let v = chat_usage_to_responses(&u);
        assert_eq!(
            v,
            json!({"input_tokens": 1000, "input_tokens_details": {"cached_tokens": 300},
                "output_tokens": 50, "total_tokens": 1050, "output_tokens_details": {"reasoning_tokens": 20}})
        );
        // chat → responses 的计费输入换算要和 native 一致
        assert_eq!(responses_usage_to_tokens(&v), Tokens { input: 700, output: 50, cache_read: 300, cache_write: 0 });
    }

    #[test]
    fn request_to_chat_basics() {
        let req = json!({
            "model": "m",
            "instructions": "be brief",
            "input": [
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hello"}]},
            ],
            "max_output_tokens": 64,
        });
        let out = request_to_chat(&req, "wire-m", false).unwrap();
        assert_eq!(
            out,
            json!({"model": "wire-m", "messages": [
                {"role": "system", "content": "be brief"},
                {"role": "user", "content": "hello"},
            ], "max_tokens": 64})
        );
    }

    #[test]
    fn chat_templates_get_one_system_message_before_the_conversation() {
        let req = json!({
            "instructions": "initial instructions",
            "input": [
                {"role":"user", "content":"first prompt"},
                {"role":"developer", "content":[{"type":"input_text", "text":"environment context"}]},
                {"role":"assistant", "content":"first answer"},
                {"role":"system", "content":"later system instructions"},
                {"role":"user", "content":"follow-up"}
            ]
        });
        let converted = request_to_chat(&req, "Qwen", true).unwrap();
        assert_eq!(
            converted["messages"],
            json!([
                {"role":"system", "content":"initial instructions\n\nenvironment context\n\nlater system instructions"},
                {"role":"user", "content":"first prompt"},
                {"role":"assistant", "content":"first answer"},
                {"role":"user", "content":"follow-up"}
            ])
        );
    }

    #[test]
    fn request_to_chat_round_trips_function_call_and_output() {
        let req = json!({
            "model": "m",
            "input": [
                {"type": "message", "role": "user", "content": "look up SZ"},
                {"type": "function_call", "call_id": "call_1", "name": "lookup", "arguments": "{\"city\":\"SZ\"}"},
                {"type": "function_call_output", "call_id": "call_1", "output": "in stock"},
            ],
        });
        let out = request_to_chat(&req, "wire-m", true).unwrap();
        assert_eq!(
            out["messages"],
            json!([
                {"role": "user", "content": "look up SZ"},
                {"role": "assistant", "content": null, "tool_calls": [
                    {"id": "call_1", "type": "function", "function": {"name": "lookup", "arguments": "{\"city\":\"SZ\"}"}}]},
                {"role": "tool", "tool_call_id": "call_1", "content": "in stock"},
            ])
        );
        assert_eq!(out["stream"], true);
        assert_eq!(out["stream_options"], json!({"include_usage": true}));
    }

    #[test]
    fn request_to_chat_rejects_unsupported_item_and_content() {
        let reasoning =
            json!({"model": "m", "input": [{"type": "reasoning", "summary": []}, {"role": "user", "content": "hi"}]});
        assert_eq!(
            request_to_chat(&reasoning, "m", false).unwrap()["messages"],
            json!([{"role": "user", "content": "hi"}])
        );
        let bad_item = json!({"model": "m", "input": [{"type": "unknown"}]});
        assert!(request_to_chat(&bad_item, "m", false).unwrap_err().contains("unknown"));
        let bad_content =
            json!({"model": "m", "input": [{"type": "message", "role": "user", "content": [{"type": "input_image"}]}]});
        assert!(request_to_chat(&bad_content, "m", false).unwrap_err().contains("input_image"));
    }

    #[test]
    fn request_to_chat_rejects_files_and_unusable_image_references() {
        for (part, expected) in [
            (json!({"type":"input_file","file_data":"data:application/pdf;base64,JVBERg=="}), "input_file"),
            (json!({"type":"input_image","file_id":"file_fixture"}), "input_image"),
            (json!({"type":"input_image","image_url":"file:///tmp/picture.png"}), "input_image"),
        ] {
            let payload = json!({"input":[{"role":"user","content":[part]}]});
            assert!(request_to_chat(&payload, "m", false).unwrap_err().contains(expected));
        }
        let attachment = json!({"input":[{"type":"function_call_output","call_id":"reply","output":[
            {"type":"input_image","image_url":"https://example.test/fixture.png"}]}]});
        assert!(request_to_chat(&attachment, "m", false).is_err());
    }

    #[test]
    fn request_to_chat_maps_tools_and_tool_choice() {
        let req = json!({"model": "m", "input": "hi",
            "tools": [{"type": "function", "name": "f", "parameters": {"type": "object"}}],
            "tool_choice": {"type": "function", "name": "f"}});
        let out = request_to_chat(&req, "m", false).unwrap();
        assert_eq!(
            out["tools"][0],
            json!({"type": "function", "function": {"name": "f", "parameters": {"type": "object"}}})
        );
        assert_eq!(out["tool_choice"], json!({"type": "function", "function": {"name": "f"}}));
    }

    #[test]
    fn chat_groups_parallel_native_tools_and_restores_their_types() {
        let request = json!({"input": [
            {"type":"message","role":"developer","content":"instruction"},
            {"type":"message","role":"assistant","content":"working"},
            {"type":"reasoning","summary":[]},
            {"type":"custom_tool_call","name":"patch","call_id":"one","input":"sample change"},
            {"type":"local_shell_call","call_id":"two","action":{"type":"exec","command":["printf","ok"]}},
            {"type":"custom_tool_call_output","call_id":"one","output":"done"},
            {"type":"local_shell_call_output","call_id":"two","output":"ok"}
        ], "tools":[{"type":"custom","name":"patch"},{"type":"local_shell"},{"type":"web_search"}]});
        let chat = request_to_chat(&request, "m", true).unwrap();
        assert_eq!(chat["messages"].as_array().unwrap().len(), 4);
        assert_eq!(chat["messages"][0]["role"], "system");
        assert_eq!(chat["messages"][1]["content"], "working");
        assert_eq!(chat["messages"][1]["tool_calls"].as_array().unwrap().len(), 2);
        assert_eq!(chat["messages"][1]["tool_calls"][0]["function"]["arguments"], r#"{"input":"sample change"}"#);
        assert_eq!(chat["messages"][3]["tool_call_id"], "two");
        assert_eq!(chat["tools"].as_array().unwrap().len(), 2);

        let kinds = chat_tool_kinds(&request);
        let output = json!({"choices":[{"message":{"tool_calls":[
            {"id":"one","function":{"name":"patch","arguments":r#"{"input":"sample change"}"#}},
            {"id":"two","function":{"name":"local_shell","arguments":r#"{"command":["printf","ok"]}"#}}
        ]}}]});
        let (output, _) = chat_response_to_responses_with_tools(&output, &kinds).unwrap();
        assert_eq!(output["output"][0]["type"], "custom_tool_call");
        assert_eq!(output["output"][0]["input"], "sample change");
        assert_eq!(output["output"][1]["type"], "local_shell_call");
        assert_eq!(output["output"][1]["action"]["command"], json!(["printf", "ok"]));
    }

    #[test]
    fn non_stream_chat_response_to_responses_text() {
        let v = json!({"choices": [{"index": 0, "message": {"role": "assistant", "content": "hi there"},
            "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 5}});
        let (body, has_usage) = chat_response_to_responses(&v).unwrap();
        assert!(has_usage);
        assert_eq!(body["status"], "completed");
        assert_eq!(body["output"][0]["type"], "message");
        assert_eq!(
            body["output"][0]["content"][0],
            json!({"type": "output_text", "text": "hi there", "annotations": []})
        );
        assert_eq!(body["usage"]["input_tokens"], 10);
        assert_eq!(body["usage"]["output_tokens"], 5);
    }

    #[test]
    fn non_stream_chat_response_to_responses_tool_call_and_length() {
        let v = json!({"choices": [{"index": 0, "message": {"role": "assistant", "content": null,
            "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "f", "arguments": "{}"}}]},
            "finish_reason": "length"}]});
        let (body, has_usage) = chat_response_to_responses(&v).unwrap();
        assert!(!has_usage);
        assert_eq!(body["status"], "incomplete");
        assert_eq!(
            body["output"][0],
            json!({"type": "function_call", "id": body["output"][0]["id"].clone(),
            "call_id": "call_1", "name": "f", "arguments": "{}", "status": "completed"})
        );
    }

    #[test]
    fn non_stream_chat_response_to_responses_propagates_error() {
        let v = json!({"error": {"message": "bad request"}});
        assert_eq!(chat_response_to_responses(&v).unwrap_err(), "bad request");
    }

    /// 流式 Chat → Responses：文本片段应连续派发 delta，终态带完整 usage。
    #[test]
    fn stream_translator_text_and_terminal_usage() {
        let mut tr = ResponsesStreamTranslator::new();
        let mut out = Vec::new();
        assert!(!tr.push(&ev("", json!({"choices":[{"index":0,"delta":{"content":"Hi "}}]})), &mut out));
        assert!(!tr.push(&ev("", json!({"choices":[{"index":0,"delta":{"content":"there"}}]})), &mut out));
        assert!(!tr.push(&ev("", json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})), &mut out));
        assert!(!tr.push(&ev("", json!({"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}})), &mut out));
        assert!(tr.push(&done(), &mut out));
        let names: Vec<&str> = out.iter().map(|e| e.event.as_deref().unwrap()).collect();
        assert_eq!(
            names,
            [
                "response.created",
                "response.output_item.added",
                "response.content_part.added",
                "response.output_text.delta",
                "response.output_text.delta",
                "response.output_text.done",
                "response.content_part.done",
                "response.output_item.done",
                "response.completed"
            ]
        );
        let last: Value = serde_json::from_str(&out.last().unwrap().data).unwrap();
        assert_eq!(last["response"]["status"], "completed");
        let added: Value = serde_json::from_str(&out[1].data).unwrap();
        let done: Value = serde_json::from_str(&out[out.len() - 2].data).unwrap();
        assert_eq!(added["item"]["id"], done["item"]["id"]);
        assert_eq!(done["item"]["role"], "assistant");
        assert_eq!(done["item"]["content"][0]["text"], "Hi there");
        assert_eq!(last["response"]["output"][0], done["item"]);
        assert_eq!(last["response"]["usage"]["input_tokens"], 10);
        assert_eq!(last["response"]["usage"]["output_tokens"], 5);
        assert!(tr.has_usage());
    }

    /// 流式 Chat → Responses：工具调用的参数片段要先到名字才开块，done 事件带完整参数。
    #[test]
    fn stream_translator_tool_call_arguments() {
        let mut tr = ResponsesStreamTranslator::new();
        let mut out = Vec::new();
        let frag = |args: &str, id: Option<&str>| {
            let mut tc = json!({"index": 0, "function": {"name": "lookup", "arguments": args}});
            if let Some(id) = id {
                tc["id"] = id.into();
            }
            json!({"choices": [{"index": 0, "delta": {"tool_calls": [tc]}}]})
        };
        tr.push(&ev("", frag("{\"ci", Some("call_1"))), &mut out);
        tr.push(&ev("", frag("ty\":\"SZ\"}", None)), &mut out);
        tr.push(&ev("", json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]})), &mut out);
        assert!(tr.push(&done(), &mut out));
        let added = out.iter().find(|e| e.event.as_deref() == Some("response.output_item.added")).unwrap();
        let v: Value = serde_json::from_str(&added.data).unwrap();
        assert_eq!(v["item"]["call_id"], "call_1");
        assert_eq!(v["item"]["name"], "lookup");
        let done = out.iter().find(|e| e.event.as_deref() == Some("response.function_call_arguments.done")).unwrap();
        let v: Value = serde_json::from_str(&done.data).unwrap();
        assert_eq!(v["arguments"], "{\"city\":\"SZ\"}");
        let terminal = out.last().unwrap();
        assert_eq!(terminal.event.as_deref(), Some("response.completed"));
        let v: Value = serde_json::from_str(&terminal.data).unwrap();
        assert_eq!(v["response"]["output"][0]["type"], "function_call");
        assert_eq!(v["response"]["output"][0]["call_id"], "call_1");
    }

    /// 上游在流中途报错：已输出 `response.failed`，不是正常完成。
    #[test]
    fn stream_translator_upstream_error_event() {
        let mut tr = ResponsesStreamTranslator::new();
        let mut out = Vec::new();
        assert!(tr.push(&ev("", json!({"error": {"message": "overloaded"}})), &mut out));
        let last = out.last().unwrap();
        assert_eq!(last.event.as_deref(), Some("response.failed"));
        assert!(last.data.contains("overloaded"));
    }

    /// 没见过 finish_reason 就 EOF：截断，调用方要补 `response.failed`。
    #[test]
    fn stream_translator_eof_without_finish_is_not_terminal() {
        let mut tr = ResponsesStreamTranslator::new();
        let mut out = Vec::new();
        tr.push(&ev("", json!({"choices":[{"index":0,"delta":{"content":"partial"}}]})), &mut out);
        assert!(!tr.eof(&mut out));
    }
}
