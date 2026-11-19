//! 本机 router：`127.0.0.1:<port>` 上的 Anthropic Messages 透传。
//!
//! 校验本机令牌 → 按 `config.routes` 选上游和单价 → 租约放行 → 换成上游密钥 → 转发；流式响应按完整 SSE 事件转发，
//! 同时从 `message_start`、`message_delta` 提取 usage，实时计价。越过租约额度、租约过期或 cutoff 时中断流，
//! 给客户端补一个 Anthropic 格式的 `error` 事件。客户端断开时丢弃上游响应（reqwest 随之关闭连接）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router as AxumRouter;
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, State as AxState};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use onex_core::ws::{Rate, Route, UpstreamAuth};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio::sync::mpsc;
use tracing::{info, warn};

pub use crate::pricing::Tokens;

use crate::lease::{Block, CutoffReason, Ticket};
use crate::outbox::now_ms;
use crate::pricing::{cost_milli, estimate_tokens, format_ms, pick_rate};
use crate::sse::{Event, Splitter};
use crate::state::State;
use crate::{chat, id};

/// Claude Code 带图片和长上下文时请求体可达数十 MB。
const MAX_BODY: usize = 64 * 1024 * 1024;
const MAX_UPSTREAM_BODY: usize = 64 * 1024 * 1024;
const MVP_LOCAL_QWEN_PROVIDER_ID: &str = "prv_mvp_local_qwen";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// 上游正常结束（流式见到 `message_stop`，非流式 2xx）。
    Ok,
    /// 上游返回非 2xx，原样转给客户端。
    UpstreamStatus(u16),
    /// 上游连接失败或中途断开。
    UpstreamError,
    /// 客户端中途断开，已取消上游请求。
    ClientCancelled,
    /// Edge 因租约或 cutoff 中断了请求。
    Stopped(Block),
}

impl Outcome {
    pub fn as_str(&self) -> String {
        match self {
            Outcome::Ok => "ok".into(),
            Outcome::UpstreamStatus(s) => format!("upstream_{s}"),
            Outcome::UpstreamError => "upstream_error".into(),
            Outcome::ClientCancelled => "client_cancelled".into(),
            // CONTRACT-PENDING: 契约的 status 取值里没有 Edge 主动断流，这是 Edge 的提议。
            Outcome::Stopped(Block::Exhausted | Block::TooLarge { .. }) => "lease_exhausted".into(),
            Outcome::Stopped(Block::Expired | Block::NoLease) => "lease_expired".into(),
            Outcome::Stopped(Block::Cutoff(_)) => "cutoff".into(),
        }
    }
}

/// 一次请求的计量结果，写入 outbox 的 usage。
#[derive(Debug, Clone)]
pub struct UsageRecord {
    pub request_id: String,
    /// 上游的 message id（`msg_...`）
    pub message_id: Option<String>,
    pub provider_id: String,
    /// Agent 请求的模型名
    pub model: String,
    pub model_id: String,
    /// 实际发给上游的模型名
    pub upstream_model: String,
    pub tokens: Tokens,
    /// 是否拿到了最终用量。流式中途断开时只有部分数字，`complete=false`，Server 记为待结算。
    pub usage_final: bool,
    pub cost_milli: i64,
    pub lease_id: Option<String>,
    pub outcome: Outcome,
    pub stream: bool,
    pub started_at_ms: i64,
    pub duration_ms: u64,
    /// 请求开始时正在运行的受管会话（MVP 一次一个）
    pub session_id: Option<String>,
}

impl UsageRecord {
    /// outbox 里的 usage 条目，`seq` 由 outbox 填。
    pub fn to_item(&self) -> Value {
        json!({
            "request_id": self.request_id,
            "session_id": self.session_id,
            "provider_id": self.provider_id,
            "model": self.model,
            "model_id": self.model_id,
            "input_tokens": self.tokens.input,
            "output_tokens": self.tokens.output,
            "cache_read_tokens": self.tokens.cache_read,
            "cache_write_tokens": self.tokens.cache_write,
            "cost_milli": self.cost_milli,
            "at": format_ms(self.started_at_ms),
            "status": self.outcome.as_str(),
            "complete": self.usage_final,
            "lease_id": self.lease_id,
        })
    }
}

/// 一次请求的计量。预留只用于放行，不参与任何花费计算。
struct Meter {
    rate: Rate,
    tokens: Tokens,
    /// 从 content_block_delta 估算的输出 token
    est_output: u64,
    /// 上游报过输入侧用量（`input_tokens` 是数字）
    input_reported: bool,
    reservation: i64,
}

impl Meter {
    /// 预留 = max_tokens × 输出单价 + 估算输入 × 输入单价（sprint-1 范围决定）。
    fn new(rate: Rate, max_tokens: u64, est_input: u64) -> Self {
        let reservation = cost_milli(&rate, &Tokens { input: est_input, output: max_tokens, ..Default::default() });
        Self { rate, tokens: Tokens::default(), est_output: 0, input_reported: false, reservation }
    }

    fn seen(&self) -> Tokens {
        Tokens { output: self.tokens.output.max(self.est_output), ..self.tokens }
    }

    /// 已见用量（含输出字节估算）的花费，越过租约额度就中断流。
    fn seen_cost(&self) -> i64 {
        cost_milli(&self.rate, &self.seen())
    }

    /// 结束时的用量：拿到最终用量按实际，否则按已见部分。
    fn final_tokens(&self, usage_final: bool) -> Tokens {
        if usage_final { self.tokens } else { self.seen() }
    }
}

/// Anthropic usage 是否是完整的最终用量：输入、输出都是数字。
fn usage_complete(u: &Value) -> bool {
    ["input_tokens", "output_tokens"].iter().all(|k| u.get(*k).is_some_and(Value::is_u64))
}

pub struct Router {
    state: Arc<State>,
    local_token: String,
    /// 遵从环境变量代理的默认客户端
    http: reqwest::Client,
    direct: reqwest::Client,
    /// route.proxy 指定代理时的客户端，按代理地址缓存
    proxied: Mutex<HashMap<String, reqwest::Client>>,
    usage_tx: mpsc::UnboundedSender<UsageRecord>,
}

impl Router {
    pub fn new(
        state: Arc<State>,
        local_token: String,
        http: reqwest::Client,
        usage_tx: mpsc::UnboundedSender<UsageRecord>,
    ) -> Arc<Self> {
        let direct = client_builder().no_proxy().build().expect("http client");
        Arc::new(Self { state, local_token, http, direct, proxied: Mutex::default(), usage_tx })
    }

    pub fn app(self: Arc<Self>) -> AxumRouter {
        // TODO(claude-code.md): Claude Code 是否还会调 /v1/messages/count_tokens、/v1/models，规格出来后补。
        AxumRouter::new().route("/v1/messages", post(messages)).layer(DefaultBodyLimit::max(MAX_BODY)).with_state(self)
    }

    fn authorized(&self, h: &HeaderMap) -> bool {
        // Claude Code 用 ANTHROPIC_API_KEY 时发 x-api-key，用 ANTHROPIC_AUTH_TOKEN 时发 Bearer。
        let presented = h.get("x-api-key").and_then(|v| v.to_str().ok()).or_else(|| {
            h.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "))
        });
        presented.is_some_and(|p| p.as_bytes().ct_eq(self.local_token.as_bytes()).into())
    }

    /// 回环地址一律直连；`proxy` 为 `"none"` 直连，为 URL 用指定代理；不填用环境变量代理。
    fn client_for(&self, url: &str, proxy: Option<&str>) -> Result<reqwest::Client, String> {
        let host = reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default();
        if matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]" | "::1") {
            return Ok(self.direct.clone());
        }
        match proxy {
            None => Ok(self.http.clone()),
            Some("none") => Ok(self.direct.clone()),
            Some(p) => {
                let mut m = self.proxied.lock().unwrap();
                if let Some(c) = m.get(p) {
                    return Ok(c.clone());
                }
                let proxy = reqwest::Proxy::all(p).map_err(|e| e.to_string())?;
                let c = client_builder().proxy(proxy).build().map_err(|e| e.to_string())?;
                m.insert(p.to_string(), c.clone());
                Ok(c)
            }
        }
    }
}

/// 上游只设连接超时：流式响应可能持续很久，读超时由 Agent 自己判断。
pub fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().connect_timeout(Duration::from_secs(10))
}

/// 精确匹配优先，然后是最长前缀（`claude-*`），最后是 `*`。
pub fn select_route<'a>(routes: &'a [Route], model: &str) -> Option<&'a Route> {
    if let Some(r) = routes.iter().find(|r| r.model == model) {
        return Some(r);
    }
    routes
        .iter()
        .filter_map(|r| r.model.strip_suffix('*').filter(|p| model.starts_with(p)).map(|p| (p.len(), r)))
        .max_by_key(|(n, _)| *n)
        .map(|(_, r)| r)
}

async fn messages(AxState(rt): AxState<Arc<Router>>, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    let started = Instant::now();
    if !rt.authorized(&headers) {
        return anthropic_error(
            StatusCode::UNAUTHORIZED,
            "authentication_error",
            "OneX 本机令牌无效。请从 OneX Desktop 重新启动这个 Agent。",
        );
    }

    let mut req: Value = match serde_json::from_slice(&body) {
        Ok(v @ Value::Object(_)) => v,
        _ => return anthropic_error(StatusCode::BAD_REQUEST, "invalid_request_error", "请求体不是有效的 JSON 对象。"),
    };
    let Some(model) = req.get("model").and_then(Value::as_str).map(str::to_owned) else {
        return anthropic_error(StatusCode::BAD_REQUEST, "invalid_request_error", "请求缺少 model 字段。");
    };
    let stream = req.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let max_tokens = req.get("max_tokens").and_then(Value::as_u64).unwrap_or(0);

    let (route, rate) = {
        let cfg = rt.state.config.read().unwrap();
        let route = select_route(&cfg.routes, &model).cloned();
        let rate = route.as_ref().and_then(|r| pick_rate(&cfg.rates, &r.model_id, now_ms()).cloned());
        (route, rate)
    };
    // TODO(gateway.md): 未配置路由时用哪个错误类型和状态码，等规格确定。
    let Some(route) = route else {
        return anthropic_error(
            StatusCode::NOT_FOUND,
            "not_found_error",
            &format!("OneX 没有为模型 {model} 配置路由，请联系管理员开通，或换用已开通的模型。"),
        );
    };
    let to_chat = match route.protocol.as_str() {
        "anthropic" => false,
        "openai_chat" => true,
        other => {
            return anthropic_error(
                StatusCode::NOT_IMPLEMENTED,
                "api_error",
                &format!("OneX Edge 暂不支持 {other} 协议的上游。"),
            );
        }
    };
    // 没有单价就无法计费，不放行。
    let Some(rate) = rate else {
        warn!(model = %model, model_id = %route.model_id, "no rate for model");
        return anthropic_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "api_error",
            &format!("OneX 还没有收到模型 {model} 的计价配置，请稍后重试；如果持续出现，请联系管理员检查倍率表。"),
        );
    };
    let Some(key) = rt.state.secrets.read().unwrap().get(&route.provider_id).cloned() else {
        return anthropic_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "api_error",
            "OneX 还没有收到这个模型的上游密钥。请确认 OneX Desktop 已登录并在线，稍后重试。",
        );
    };

    let upstream_model = route.upstream_model.clone().unwrap_or_else(|| model.clone());
    let (url, body) = if to_chat {
        // `?beta=true` 之类的查询参数属于 Anthropic，不带给 Chat 上游。
        // MVP 本机 Qwen 的 chat template 只接受一条置于开头的 system 消息。
        let system_messages = if route.provider_id == MVP_LOCAL_QWEN_PROVIDER_ID {
            chat::SystemMessages::SingleLeading
        } else {
            chat::SystemMessages::InOrder
        };
        let chat_req = match chat::build_request(&req, &upstream_model, stream, system_messages) {
            Ok(v) => v,
            Err(msg) => return anthropic_error(StatusCode::BAD_REQUEST, "invalid_request_error", &msg),
        };
        (chat::chat_url(&route.base_url), Bytes::from(serde_json::to_vec(&chat_req).unwrap()))
    } else {
        let mut url = format!("{}/v1/messages", route.base_url.trim_end_matches('/'));
        if let Some(q) = uri.query() {
            url.push('?');
            url.push_str(q);
        }
        let body = if upstream_model != model {
            req["model"] = Value::String(upstream_model.clone());
            Bytes::from(serde_json::to_vec(&req).unwrap())
        } else {
            body
        };
        (url, body)
    };
    let client = match rt.client_for(&url, route.proxy.as_deref()) {
        Ok(c) => c,
        Err(e) => {
            warn!(provider_id = %route.provider_id, error = %e, "bad route proxy");
            return anthropic_error(StatusCode::BAD_GATEWAY, "api_error", "OneX 路由的代理设置无效，请联系管理员。");
        }
    };

    let meter = Meter::new(rate, max_tokens, estimate_input(&req));
    let ticket = match rt.state.lease.admit(meter.reservation) {
        Ok(t) => t,
        Err(b) => {
            info!(model = %model, reason = ?b, reservation_milli = meter.reservation, "request blocked by lease");
            return block_response(b);
        }
    };
    rt.state.upstream.lock().unwrap().inflight += 1;

    // Anthropic 的请求头（anthropic-version、anthropic-beta）对 Chat 上游没有意义，不转发。
    let mut out_headers = if to_chat {
        let mut h = HeaderMap::new();
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
        h
    } else {
        forward_headers(&headers)
    };
    match route.auth {
        UpstreamAuth::XApiKey => out_headers.insert("x-api-key", header_value(&key)),
        UpstreamAuth::Bearer => out_headers.insert(header::AUTHORIZATION, header_value(&format!("Bearer {key}"))),
    };
    // 不要压缩，才能边转发边解析 SSE。
    out_headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("identity"));

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
        session_id: rt.state.active_session.read().unwrap().clone(),
    };
    let mut req = Req { rt: rt.clone(), rec, meter, ticket, started };

    // 只在没收到任何响应头时重试一次，不换路。每次尝试各记一条 usage。
    let mut attempt = 0;
    let resp = loop {
        attempt += 1;
        let send = client.post(&url).headers(out_headers.clone()).body(body.clone()).send();
        let r = tokio::select! {
            r = send => r,
            b = req.ticket.stopped() => {
                req.rec.outcome = Outcome::Stopped(b);
                req.finish();
                return block_response(b);
            }
        };
        let e = match r {
            Ok(resp) => break resp,
            Err(e) => e,
        };
        // 连不上时请求肯定没到上游，按零计；其余情况上游可能已经处理并收费，标待结算。
        let reached = !e.is_connect();
        warn!(request_id = %req.rec.request_id, provider_id = %req.rec.provider_id, attempt, reached, error = %e.without_url(), "upstream request failed");
        if attempt >= 2 {
            req.rec.usage_final = !reached;
            req.finish();
            return anthropic_error(StatusCode::BAD_GATEWAY, "api_error", "OneX 连接上游模型服务失败，请稍后重试。");
        }
        req.record_failed_attempt(!reached);
    };

    let status = resp.status();
    let resp_headers = response_headers(resp.headers());
    let is_sse = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/event-stream"));

    if to_chat {
        return chat_response(req, resp, status, is_sse, stream).await;
    }

    if status.is_success() && is_sse {
        let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(16);
        tokio::spawn(pump(req, resp, tx, None));
        let body = Body::from_stream(tokio_stream_from(rx));
        return (status, resp_headers, body).into_response();
    }

    // 非流式，或上游返回错误：读完整个响应再转发。
    let (mut req, bytes) = match req.read_body(resp).await {
        Ok(x) => x,
        Err(r) => return r,
    };
    if status.is_success() {
        req.rec.outcome = Outcome::Ok;
        if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
            req.rec.message_id = v.get("id").and_then(Value::as_str).map(str::to_owned);
            if let Some(u) = v.get("usage") {
                apply_usage(&mut req.meter.tokens, u);
                req.rec.usage_final = usage_complete(u);
            }
        }
        if !req.rec.usage_final {
            // 2xx 却没有完整 usage：只按已见部分计（可能是 0），标待结算，不拿预留充数。
            warn!(request_id = %req.rec.request_id, "upstream response has no complete usage");
        }
        req = match req.check_budget() {
            Ok(r) => r,
            Err(r) => return *r,
        };
    } else {
        req.rec.outcome = Outcome::UpstreamStatus(status.as_u16());
        // 上游 4xx/5xx 不计 token。
        req.rec.usage_final = true;
    }
    req.finish();
    (status, resp_headers, bytes).into_response()
}

/// 估算请求的输入 token：所有字符串值的字节数按 3 字节 1 个 token 算，跳过图片等 base64 的 `data`。
fn estimate_input(req: &Value) -> u64 {
    fn walk(v: &Value, n: &mut usize) {
        match v {
            Value::String(s) => *n += s.len(),
            Value::Array(a) => a.iter().for_each(|x| walk(x, n)),
            Value::Object(o) => o.iter().filter(|(k, _)| k.as_str() != "data").for_each(|(_, x)| walk(x, n)),
            _ => {}
        }
    }
    let mut n = 0;
    for k in ["system", "messages", "tools"] {
        if let Some(v) = req.get(k) {
            walk(v, &mut n);
        }
    }
    estimate_tokens(n)
}

/// 进行中的请求：计量、租约票据和收尾。
struct Req {
    rt: Arc<Router>,
    rec: UsageRecord,
    meter: Meter,
    ticket: Ticket,
    started: Instant,
}

impl Req {
    /// 读完整个上游响应。cutoff 或过期时放弃读取；读失败返回 502。失败时已结算。
    async fn read_body(self, resp: reqwest::Response) -> Result<(Req, Bytes), Response> {
        let mut req = self;
        let read = tokio::select! {
            r = read_limited(resp, MAX_UPSTREAM_BODY) => r,
            b = req.ticket.stopped() => {
                req.rec.outcome = Outcome::Stopped(b);
                req.finish();
                return Err(block_response(b));
            }
        };
        match read {
            Ok(b) => Ok((req, b)),
            Err(e) => {
                warn!(request_id = %req.rec.request_id, error = %e, "upstream body read failed");
                req.finish();
                Err(anthropic_error(StatusCode::BAD_GATEWAY, "api_error", "上游模型服务的响应中断，请重试。"))
            }
        }
    }

    /// 第一次尝试没收到响应头就失败了，另记一条 usage，之后重试。
    fn record_failed_attempt(&self, nothing_sent: bool) {
        let mut rec = self.rec.clone();
        rec.request_id = id::new("req");
        rec.outcome = Outcome::UpstreamError;
        rec.usage_final = nothing_sent;
        rec.lease_id = self.ticket.lease_id().map(str::to_owned);
        rec.duration_ms = self.started.elapsed().as_millis() as u64;
        info!(request_id = %rec.request_id, retry_of = %self.rec.request_id, "upstream attempt failed before headers; retrying once");
        self.rt.note_upstream(&rec);
        let _ = self.rt.usage_tx.send(rec);
    }

    /// 非流式响应读完后按实际花费检查额度，和流式一样：越过额度的内容不发给客户端。
    /// 越过时已结算并返回给客户端的错误响应。
    fn check_budget(mut self) -> Result<Req, Box<Response>> {
        let cost = cost_milli(&self.meter.rate, &self.meter.final_tokens(self.rec.usage_final));
        let Err(b) = self.ticket.update(cost) else { return Ok(self) };
        warn!(request_id = %self.rec.request_id, cost_milli = cost, "response over lease budget; withheld");
        self.rec.outcome = Outcome::Stopped(b);
        self.finish();
        Err(Box::new(block_response(b)))
    }

    fn finish(self) {
        let Req { rt, mut rec, meter, ticket, started } = self;
        // 用量不完整时只按已见部分计价，标 complete=false，预留绝不当作已发生的花费。
        rec.tokens = meter.final_tokens(rec.usage_final);
        rec.cost_milli = cost_milli(&meter.rate, &rec.tokens);
        rec.lease_id = ticket.finish(rec.cost_milli);
        rec.duration_ms = started.elapsed().as_millis() as u64;
        info!(
            request_id = %rec.request_id,
            provider_id = %rec.provider_id,
            model = %rec.model,
            outcome = %rec.outcome.as_str(),
            input = rec.tokens.input,
            output = rec.tokens.output,
            cache_read = rec.tokens.cache_read,
            cache_write = rec.tokens.cache_write,
            cost_milli = rec.cost_milli,
            usage_final = rec.usage_final,
            duration_ms = rec.duration_ms,
            "request done"
        );
        rt.note_upstream(&rec);
        {
            let mut u = rt.state.upstream.lock().unwrap();
            u.inflight = u.inflight.saturating_sub(1);
            u.completed += 1;
        }
        let _ = rt.usage_tx.send(rec);
    }
}

impl Router {
    fn note_upstream(&self, rec: &UsageRecord) {
        let entry = (rec.outcome.as_str(), rec.request_id.clone(), now_ms());
        let mut u = self.state.upstream.lock().unwrap();
        if rec.outcome == Outcome::UpstreamError {
            u.last_error = Some(entry.clone());
        }
        u.last = Some(entry);
    }
}

/// Chat 上游的响应：流开始前的错误转成 Anthropic 错误；SSE 边译边转；非流式整包转换。
async fn chat_response(req: Req, resp: reqwest::Response, status: StatusCode, is_sse: bool, stream: bool) -> Response {
    let client_model = req.rec.model.clone();
    if status.is_success() && is_sse && stream {
        let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(16);
        tokio::spawn(pump(req, resp, tx, Some(chat::StreamTranslator::new(&client_model))));
        let headers = [(header::CONTENT_TYPE, "text/event-stream"), (header::CACHE_CONTROL, "no-cache")];
        return (StatusCode::OK, headers, Body::from_stream(tokio_stream_from(rx))).into_response();
    }
    let (mut req, bytes) = match req.read_body(resp).await {
        Ok(x) => x,
        Err(r) => return r,
    };
    if !status.is_success() {
        req.rec.outcome = Outcome::UpstreamStatus(status.as_u16());
        req.rec.usage_final = true;
        req.finish();
        let (kind, msg) = chat::error_to_anthropic(status.as_u16(), &bytes);
        return anthropic_error(status, kind, &msg);
    }
    // 非流式客户端拿到了 SSE（上游无视 stream:false）也照样译完再整包返回。
    let parsed = if is_sse {
        collect_chat_sse(&bytes, &client_model)
    } else {
        serde_json::from_slice::<Value>(&bytes)
            .map_err(|_| "上游响应不是有效的 JSON。".to_string())
            .and_then(|v| chat::response_to_anthropic(&v, &client_model))
    };
    match parsed {
        Ok((msg, has_usage)) => {
            if has_usage {
                apply_usage(&mut req.meter.tokens, &msg["usage"]);
            }
            req.rec.usage_final = has_usage;
            req.rec.outcome = Outcome::Ok;
            let req = match req.check_budget() {
                Ok(r) => r,
                Err(r) => return *r,
            };
            req.finish();
            axum::Json(msg).into_response()
        }
        Err(e) => {
            warn!(request_id = %req.rec.request_id, error = %e, "chat response conversion failed");
            req.finish();
            anthropic_error(StatusCode::BAD_GATEWAY, "api_error", &format!("OneX 无法转换上游模型的响应：{e}"))
        }
    }
}

/// 把一整段 Chat SSE 译完，聚合成一个 Anthropic message。
fn collect_chat_sse(bytes: &[u8], client_model: &str) -> Result<(Value, bool), String> {
    let mut split = Splitter::default();
    let (_, mut events) = split.push(bytes);
    events.extend(split.push(b"\n\n").1);
    let mut tr = chat::StreamTranslator::new(client_model);
    let mut out = Vec::new();
    let mut step = chat::Step::Continue;
    for ev in &events {
        step = tr.push(ev, &mut out);
        if step != chat::Step::Continue {
            break;
        }
    }
    if step == chat::Step::Continue {
        step = tr.eof(&mut out);
    }
    if step != chat::Step::Done {
        return Err("上游的流式响应不完整。".into());
    }
    let mut content: Vec<Value> = Vec::new();
    let mut json_buf: Vec<String> = Vec::new();
    let mut msg = Value::Null;
    for ev in &out {
        let v: Value = serde_json::from_str(&ev.data).unwrap();
        match ev.event.as_deref() {
            Some("message_start") => msg = v["message"].clone(),
            Some("content_block_start") => {
                content.push(v["content_block"].clone());
                json_buf.push(String::new());
            }
            Some("content_block_delta") => {
                let i = v["index"].as_u64().unwrap() as usize;
                let d = &v["delta"];
                if let Some(t) = d.get("text").and_then(Value::as_str) {
                    let cur = content[i]["text"].as_str().unwrap_or("").to_string();
                    content[i]["text"] = (cur + t).into();
                } else if let Some(p) = d.get("partial_json").and_then(Value::as_str) {
                    json_buf[i].push_str(p);
                }
            }
            Some("message_delta") => {
                msg["stop_reason"] = v["delta"]["stop_reason"].clone();
                msg["usage"] = v["usage"].clone();
            }
            _ => {}
        }
    }
    for (i, b) in content.iter_mut().enumerate() {
        if b["type"] == "tool_use" {
            let s = if json_buf[i].is_empty() { "{}" } else { &json_buf[i] };
            b["input"] = serde_json::from_str(s).map_err(|_| "上游返回的工具参数不是有效 JSON。".to_string())?;
        }
    }
    msg["content"] = content.into();
    Ok((msg, tr.usage_final()))
}

/// 把上游 SSE 转发给客户端，直到上游结束、上游出错、客户端断开或租约中断。
/// `tr` 不为空时上游是 Chat，逐事件译成 Anthropic 再发。
async fn pump(
    mut req: Req,
    mut resp: reqwest::Response,
    tx: mpsc::Sender<Result<Bytes, std::io::Error>>,
    mut tr: Option<chat::StreamTranslator>,
) {
    let mut split = Splitter::default();
    let mut stopped = false;
    let mut translated = Vec::new();
    // Chat 上游在流里报的错，translator 已经输出了 error 事件
    let mut reported = false;
    let outcome = 'pump: loop {
        let chunk = tokio::select! {
            // 慢流期间客户端断开也要及时发现，不能等到上游下一个字节。
            _ = tx.closed() => break Outcome::ClientCancelled,
            b = req.ticket.stopped() => break Outcome::Stopped(b),
            c = resp.chunk() => c,
        };
        let chunk = match (chunk, tr.as_mut()) {
            // Chat 上游结束：有终态就补发 message_delta 和 message_stop
            (Ok(None), Some(t)) => {
                translated.clear();
                let step = t.eof(&mut translated);
                for ev in &translated {
                    observe(&mut req.rec, &mut req.meter, &mut stopped, ev);
                }
                if step == chat::Step::Done {
                    let _ = tx.send(Ok(chat::encode(&translated))).await;
                    break Outcome::Ok;
                }
                warn!(request_id = %req.rec.request_id, "chat upstream ended without finish_reason");
                break Outcome::UpstreamError;
            }
            (c, _) => c,
        };
        match chunk {
            Ok(Some(c)) => {
                let (raw, mut events) = split.push(&c);
                let mut out = raw;
                if let Some(t) = tr.as_mut() {
                    translated.clear();
                    let mut step = chat::Step::Continue;
                    for ev in &events {
                        step = t.push(ev, &mut translated);
                        if step != chat::Step::Continue {
                            break;
                        }
                    }
                    events = std::mem::take(&mut translated);
                    out = chat::encode(&events);
                    match step {
                        chat::Step::UpstreamError => {
                            warn!(request_id = %req.rec.request_id, "chat upstream reported an error mid-stream");
                            let _ = tx.send(Ok(out)).await;
                            reported = true;
                            break Outcome::UpstreamError;
                        }
                        // 见到 [DONE] 就结束，不等上游关连接
                        chat::Step::Done => {
                            for ev in &events {
                                observe(&mut req.rec, &mut req.meter, &mut stopped, ev);
                            }
                            let _ = tx.send(Ok(out)).await;
                            break Outcome::Ok;
                        }
                        _ => {}
                    }
                }
                for ev in &events {
                    observe(&mut req.rec, &mut req.meter, &mut stopped, ev);
                }
                // 先计价再转发：越过额度的那批字节不发给客户端。
                if !events.is_empty() {
                    if let Err(b) = req.ticket.update(req.meter.seen_cost()) {
                        break Outcome::Stopped(b);
                    }
                }
                if !out.is_empty() {
                    let sent = tokio::select! {
                        r = tx.send(Ok(out)) => r.is_ok(),
                        // 客户端读得慢、写被阻塞时，cutoff 也要能打断。
                        b = req.ticket.stopped() => break 'pump Outcome::Stopped(b),
                    };
                    if !sent {
                        break Outcome::ClientCancelled;
                    }
                }
            }
            Ok(None) if stopped => break Outcome::Ok,
            Ok(None) => {
                warn!(request_id = %req.rec.request_id, partial = split.has_partial(), "upstream stream ended before message_stop");
                break Outcome::UpstreamError;
            }
            Err(e) => {
                warn!(request_id = %req.rec.request_id, error = %e.without_url(), "upstream stream error");
                break Outcome::UpstreamError;
            }
        }
    };
    // 先丢掉上游响应，关闭上游连接，再处理收尾。
    drop(resp);
    // 流在中途被打断：先把打开的块关上，Anthropic 客户端才能正确显示 error
    if let (Some(t), true) = (tr.as_mut(), !matches!(outcome, Outcome::Ok | Outcome::ClientCancelled)) {
        let mut closing = Vec::new();
        t.abort(&mut closing);
        if !closing.is_empty() {
            let _ = tokio::time::timeout(Duration::from_secs(1), tx.send(Ok(chat::encode(&closing)))).await;
        }
    }
    // 译出的 message_delta 总带 usage 字段，是否收到真实的尾部用量以 translator 为准
    if let Some(t) = &tr {
        req.rec.usage_final = t.usage_final();
    }
    let ev = match outcome {
        _ if reported => None,
        Outcome::UpstreamError => {
            Some(sse_error("api_error", None, "上游模型服务的连接中断，本次回复不完整，请重试。"))
        }
        Outcome::Stopped(b) => {
            let (_, kind, code, msg) = block_error(b);
            Some(sse_error(kind, Some(code), &format!("{msg}本次回复已被中断。")))
        }
        _ => None,
    };
    if let Some(ev) = ev {
        // 客户端不读时不能卡住收尾。
        let _ = tokio::time::timeout(Duration::from_secs(1), tx.send(Ok(ev))).await;
    }
    req.rec.outcome = outcome;
    req.finish();
}

fn observe(rec: &mut UsageRecord, m: &mut Meter, stopped: &mut bool, ev: &Event) {
    let ty = ev.event.as_deref().unwrap_or("");
    if !matches!(ty, "message_start" | "message_delta" | "message_stop" | "content_block_delta") {
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(&ev.data) else { return };
    match ty {
        "message_start" => {
            let msg = &v["message"];
            rec.message_id = msg.get("id").and_then(Value::as_str).map(str::to_owned);
            if let Some(u) = msg.get("usage") {
                // 有的兼容上游在 message_start 里全给 0，只在终帧报真实数字；0 不算报过输入。
                apply_usage(&mut m.tokens, u);
                m.input_reported = u.get("input_tokens").and_then(Value::as_u64).is_some_and(|n| n > 0);
            }
        }
        "content_block_delta" => {
            let d = &v["delta"];
            let n: usize = ["text", "partial_json", "thinking"]
                .iter()
                .filter_map(|k| d.get(*k).and_then(Value::as_str))
                .map(str::len)
                .sum();
            m.est_output += estimate_tokens(n);
        }
        "message_delta" => {
            // message_delta 里的 usage 是累计值，出现就覆盖。
            // 只有 output_tokens 是数字、且输入侧已知（这里或 message_start 报过）才算最终用量；
            // 空对象或缺字段的 usage 不能冒充完整计量。
            if let Some(u) = v.get("usage") {
                apply_usage(&mut m.tokens, u);
                let input_here = u.get("input_tokens").is_some_and(Value::is_u64);
                m.input_reported |= input_here;
                rec.usage_final = u.get("output_tokens").is_some_and(Value::is_u64) && m.input_reported;
            }
        }
        _ => *stopped = true,
    }
}

fn apply_usage(t: &mut Tokens, u: &Value) {
    let get = |k: &str| u.get(k).and_then(Value::as_u64);
    // 只用非零值覆盖：有的兼容上游在 message_delta 里把没变的字段写成 0。
    let set = |dst: &mut u64, v: Option<u64>| {
        if let Some(n) = v.filter(|&n| n > 0 || *dst == 0) {
            *dst = n;
        }
    };
    set(&mut t.input, get("input_tokens"));
    set(&mut t.output, get("output_tokens"));
    set(&mut t.cache_read, get("cache_read_input_tokens"));
    set(&mut t.cache_write, get("cache_creation_input_tokens"));
}

/// (HTTP 状态, Anthropic error.type, errors.md 的 code, 中文说明)
fn block_error(b: Block) -> (StatusCode, &'static str, &'static str, &'static str) {
    const PAY: StatusCode = StatusCode::PAYMENT_REQUIRED;
    match b {
        Block::NoLease => (
            PAY,
            "billing_error",
            "lease_expired",
            "OneX 还没有拿到额度租约。请确认 OneX Desktop 已登录并能连上服务器，稍后重试。",
        ),
        Block::Expired => (
            PAY,
            "billing_error",
            "lease_expired",
            "OneX 额度租约已过期，暂时无法续约。请检查网络连接，恢复后会自动续约。",
        ),
        Block::Exhausted => (
            PAY,
            "billing_error",
            "balance_exhausted",
            "OneX 本机额度已用完，正在向服务器续约。请稍后重试；如果持续出现，请联系管理员充值橡皮。",
        ),
        Block::TooLarge { .. } => (
            PAY,
            "billing_error",
            "balance_exhausted",
            "这次请求按 max_tokens 预估的花费超过了 OneX 单个额度租约的上限。请调小 max_tokens 或缩短上下文后重试；如果需要更大的单次请求，请联系管理员调高租约额度。",
        ),
        Block::Cutoff(CutoffReason::Balance) => {
            (PAY, "billing_error", "balance_exhausted", "OneX 橡皮余额已用完，请联系管理员充值。")
        }
        Block::Cutoff(CutoffReason::Disabled) => {
            (StatusCode::FORBIDDEN, "permission_error", "forbidden", "你的 OneX 账号或这台设备已被停用，请联系管理员。")
        }
        Block::Cutoff(CutoffReason::Contract) => {
            (StatusCode::FORBIDDEN, "permission_error", "forbidden", "租户合约已不允许继续使用模型，请联系管理员。")
        }
        Block::Cutoff(CutoffReason::Other) => {
            (StatusCode::FORBIDDEN, "permission_error", "forbidden", "OneX 服务器停止了模型访问，请联系管理员。")
        }
    }
}

fn block_response(b: Block) -> Response {
    let (status, kind, code, msg) = block_error(b);
    (status, axum::Json(error_body(kind, Some(code), msg))).into_response()
}

const HOP_BY_HOP: &[&str] =
    &["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade"];

fn forward_headers(h: &HeaderMap) -> HeaderMap {
    let mut out = HeaderMap::new();
    for (k, v) in h {
        let n = k.as_str();
        if HOP_BY_HOP.contains(&n)
            || matches!(n, "host" | "content-length" | "authorization" | "x-api-key" | "accept-encoding" | "cookie")
        {
            continue;
        }
        out.append(k.clone(), v.clone());
    }
    out
}

fn response_headers(h: &reqwest::header::HeaderMap) -> HeaderMap {
    let mut out = HeaderMap::new();
    for (k, v) in h {
        let n = k.as_str();
        if HOP_BY_HOP.contains(&n) || n == "content-length" || n == "set-cookie" {
            continue;
        }
        if let (Ok(k), Ok(v)) = (HeaderName::from_bytes(k.as_ref()), HeaderValue::from_bytes(v.as_bytes())) {
            out.append(k, v);
        }
    }
    out
}

fn header_value(s: &str) -> HeaderValue {
    let mut v = HeaderValue::from_str(s).unwrap_or_else(|_| HeaderValue::from_static(""));
    v.set_sensitive(true);
    v
}

async fn read_limited(mut resp: reqwest::Response, max: usize) -> anyhow::Result<Bytes> {
    let mut buf = Vec::new();
    while let Some(c) = resp.chunk().await.map_err(|e| e.without_url())? {
        if buf.len() + c.len() > max {
            anyhow::bail!("upstream body over {max} bytes");
        }
        buf.extend_from_slice(&c);
    }
    Ok(buf.into())
}

fn tokio_stream_from<T: Send + 'static>(mut rx: mpsc::Receiver<T>) -> impl futures_util::Stream<Item = T> + Send {
    futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx))
}

/// Anthropic 错误体。`code` 是 errors.md 的错误码，放在 `error.code`，Anthropic 客户端会忽略这个多余字段。
fn error_body(kind: &str, code: Option<&str>, message: &str) -> Value {
    let mut e = json!({"type": kind, "message": message});
    if let Some(c) = code {
        e["code"] = c.into();
    }
    json!({"type": "error", "error": e})
}

pub fn anthropic_error_body(kind: &str, message: &str) -> Value {
    error_body(kind, None, message)
}

pub fn anthropic_error(status: StatusCode, kind: &str, message: &str) -> Response {
    (status, axum::Json(anthropic_error_body(kind, message))).into_response()
}

fn sse_error(kind: &str, code: Option<&str>, message: &str) -> Bytes {
    Bytes::from(format!("event: error\ndata: {}\n\n", error_body(kind, code, message)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(model: &str, p: &str) -> Route {
        Route {
            model: model.into(),
            model_id: "mdl".into(),
            provider_id: p.into(),
            protocol: "anthropic".into(),
            base_url: "http://x".into(),
            upstream_model: None,
            auth: UpstreamAuth::XApiKey,
            proxy: None,
        }
    }

    fn rate() -> Rate {
        Rate {
            model_id: "mdl".into(),
            input_milli_per_mtok: 3_000,
            output_milli_per_mtok: 15_000,
            cache_read_milli_per_mtok: 300,
            cache_write_milli_per_mtok: 3_750,
            effective_from: None,
        }
    }

    fn rec() -> UsageRecord {
        UsageRecord {
            request_id: "r".into(),
            message_id: None,
            provider_id: "p".into(),
            model: "m".into(),
            model_id: "mdl".into(),
            upstream_model: "m".into(),
            tokens: Tokens::default(),
            usage_final: false,
            cost_milli: 0,
            lease_id: None,
            outcome: Outcome::UpstreamError,
            stream: true,
            started_at_ms: 0,
            duration_ms: 0,
            session_id: None,
        }
    }

    fn ev(e: &str, d: Value) -> Event {
        Event { event: Some(e.into()), data: d.to_string() }
    }

    #[test]
    fn route_selection() {
        let rs =
            [route("*", "any"), route("claude-*", "c"), route("claude-opus-*", "o"), route("claude-haiku-5-5", "h")];
        assert_eq!(select_route(&rs, "claude-haiku-5-5").unwrap().provider_id, "h");
        assert_eq!(select_route(&rs, "claude-opus-5-5").unwrap().provider_id, "o");
        assert_eq!(select_route(&rs, "claude-sonnet-5-5").unwrap().provider_id, "c");
        assert_eq!(select_route(&rs, "kimi-k3").unwrap().provider_id, "any");
        assert!(select_route(&rs[1..], "kimi-k3").is_none());
    }

    #[test]
    fn usage_from_events() {
        let mut rec = rec();
        let mut m = Meter::new(rate(), 1000, 0);
        let mut stopped = false;
        observe(
            &mut rec,
            &mut m,
            &mut stopped,
            &ev(
                "message_start",
                json!({"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":100,"cache_creation_input_tokens":20}}}),
            ),
        );
        assert_eq!(m.tokens, Tokens { input: 10, output: 1, cache_read: 100, cache_write: 20 });
        assert!(m.input_reported && !rec.usage_final);
        observe(
            &mut rec,
            &mut m,
            &mut stopped,
            &ev("message_delta", json!({"type":"message_delta","usage":{"output_tokens":42}})),
        );
        assert_eq!(m.tokens, Tokens { input: 10, output: 42, cache_read: 100, cache_write: 20 });
        assert!(rec.usage_final && !stopped);
        observe(&mut rec, &mut m, &mut stopped, &ev("message_stop", json!({"type":"message_stop"})));
        assert!(stopped);
        assert_eq!(rec.message_id.as_deref(), Some("msg_1"));
    }

    #[test]
    fn zero_fields_in_delta_do_not_erase_start_usage() {
        let mut rec = rec();
        let mut m = Meter::new(rate(), 0, 0);
        let mut s = false;
        observe(
            &mut rec,
            &mut m,
            &mut s,
            &ev("message_start", json!({"message":{"usage":{"input_tokens":10,"cache_read_input_tokens":5}}})),
        );
        observe(
            &mut rec,
            &mut m,
            &mut s,
            &ev("message_delta", json!({"usage":{"input_tokens":0,"cache_read_input_tokens":0,"output_tokens":7}})),
        );
        assert_eq!(m.tokens, Tokens { input: 10, output: 7, cache_read: 5, cache_write: 0 });
    }

    #[test]
    fn seen_cost_never_includes_reservation() {
        let mut rec = rec();
        // 预留 = 1000 × 15000 / 1e6 = 15，只用于放行
        let mut m = Meter::new(rate(), 1000, 0);
        assert_eq!(m.reservation, 15);
        assert_eq!(m.seen_cost(), 0);
        let mut s = false;
        observe(
            &mut rec,
            &mut m,
            &mut s,
            &ev("message_start", json!({"message":{"usage":{"input_tokens":0,"output_tokens":0}}})),
        );
        assert!(!m.input_reported);
        assert_eq!(m.seen_cost(), 0);
        // 6000 字节 ≈ 2000 token ≈ 30
        let text = "x".repeat(6000);
        observe(
            &mut rec,
            &mut m,
            &mut s,
            &ev("content_block_delta", json!({"delta":{"type":"text_delta","text":text}})),
        );
        assert_eq!(m.est_output, 2000);
        assert_eq!(m.seen_cost(), 30);
        // 中断时按已见部分计
        assert_eq!(m.final_tokens(false).output, 2000);
    }

    #[test]
    fn incomplete_delta_usage_is_not_final() {
        let mut m = Meter::new(rate(), 1000, 0);
        let mut s = false;
        // 空对象、缺 output_tokens、output_tokens 不是数字：都不算最终用量
        for u in [json!({}), json!({"input_tokens": 5}), json!({"output_tokens": "7"}), json!({"output_tokens": null})]
        {
            let mut r = rec();
            observe(&mut r, &mut m, &mut s, &ev("message_delta", json!({"usage": u})));
            assert!(!r.usage_final, "{u}");
        }
        // 有输出数字，但输入侧从没报过（message_start 只有 0 占位）：仍不完整
        let mut r = rec();
        observe(&mut r, &mut m, &mut s, &ev("message_start", json!({"message":{"usage":{"input_tokens":0}}})));
        observe(&mut r, &mut m, &mut s, &ev("message_delta", json!({"usage":{"output_tokens":7}})));
        assert!(!r.usage_final);
        // 终帧同时报了输入和输出：完整
        observe(&mut r, &mut m, &mut s, &ev("message_delta", json!({"usage":{"input_tokens":3,"output_tokens":7}})));
        assert!(r.usage_final);
        assert!(usage_complete(&json!({"input_tokens":0,"output_tokens":0})));
        assert!(!usage_complete(&json!({"output_tokens":3})));
    }

    #[test]
    fn live_cost_after_usage_known_tracks_deltas() {
        let mut rec = rec();
        let mut m = Meter::new(rate(), 100_000, 0);
        let mut s = false;
        observe(
            &mut rec,
            &mut m,
            &mut s,
            &ev("message_start", json!({"message":{"usage":{"input_tokens":1_000_000,"output_tokens":1}}})),
        );
        // 输入 1M × 3000 = 3000，输出 1 token 向上取整后并入
        assert_eq!(m.seen_cost(), 3_000 + 1);
        observe(
            &mut rec,
            &mut m,
            &mut s,
            &ev("content_block_delta", json!({"delta":{"type":"input_json_delta","partial_json":"x".repeat(300_000)}})),
        );
        // 100_000 token × 15000 / 1e6 = 1500
        assert_eq!(m.seen_cost(), 4_500);
    }

    #[test]
    fn reservation_includes_estimated_input() {
        let req = json!({"model":"m","max_tokens":1000,"system":"x".repeat(300),
            "messages":[{"role":"user","content":[{"type":"text","text":"y".repeat(2700)},
                {"type":"image","source":{"type":"base64","media_type":"image/png","data":"z".repeat(90000)}}]}]});
        // 300 + 2700 + "user" + "text" + "image" + "base64" + "image/png" 字节，图片数据不算
        let n = estimate_input(&req);
        assert!((1000..1020).contains(&n), "{n}");
        // 1000 输入 × 3000 + 1000 输出 × 15000 = 18
        assert_eq!(Meter::new(rate(), 1000, 1000).reservation, 18);
    }

    #[test]
    fn usage_item_matches_contract() {
        let mut r = rec();
        r.tokens = Tokens { input: 1, output: 2, cache_read: 3, cache_write: 4 };
        r.cost_milli = 9;
        r.outcome = Outcome::Stopped(Block::Cutoff(CutoffReason::Balance));
        r.lease_id = Some("lse_1".into());
        r.started_at_ms = 1_795_420_800_000;
        let v = r.to_item();
        for k in [
            "request_id",
            "session_id",
            "lease_id",
            "provider_id",
            "model",
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
            "cost_milli",
            "at",
            "status",
            "complete",
        ] {
            assert!(v.get(k).is_some(), "missing {k}");
        }
        assert_eq!(v["status"], "cutoff");
        assert_eq!(v["complete"], false);
        assert_eq!(v["at"], "2026-11-23T08:00:00Z");
    }

    #[test]
    fn header_filtering() {
        let mut h = HeaderMap::new();
        h.insert("x-api-key", "local".parse().unwrap());
        h.insert("authorization", "Bearer local".parse().unwrap());
        h.insert("anthropic-version", "2023-06-01".parse().unwrap());
        h.insert("anthropic-beta", "x".parse().unwrap());
        h.insert("host", "127.0.0.1".parse().unwrap());
        h.insert("connection", "keep-alive".parse().unwrap());
        let out = forward_headers(&h);
        assert_eq!(out.len(), 2);
        assert!(out.contains_key("anthropic-version") && out.contains_key("anthropic-beta"));
    }
}
