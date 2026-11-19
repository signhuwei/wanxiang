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

use crate::id;
use crate::lease::{Block, CutoffReason, Ticket};
use crate::outbox::now_ms;
use crate::pricing::{cost_milli, estimate_tokens, format_ms, pick_rate};
use crate::sse::{Event, Splitter};
use crate::state::State;

/// Claude Code 带图片和长上下文时请求体可达数十 MB。
const MAX_BODY: usize = 64 * 1024 * 1024;
const MAX_UPSTREAM_BODY: usize = 64 * 1024 * 1024;

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
            Outcome::Stopped(Block::Exhausted) => "lease_exhausted".into(),
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
    // TODO(claude-code.md): 从请求头或 metadata 里取会话 id。
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

/// 一次请求的实时计量。
struct Meter {
    rate: Rate,
    tokens: Tokens,
    /// 从 content_block_delta 估算的输出 token
    est_output: u64,
    /// 上游在 message_start 报了用量，之后按实际数字计价；否则一直按预留计
    metered: bool,
    reservation: i64,
}

impl Meter {
    fn new(rate: Rate, max_tokens: u64) -> Self {
        let reservation = cost_milli(&rate, &Tokens { output: max_tokens, ..Default::default() });
        Self { rate, tokens: Tokens::default(), est_output: 0, metered: false, reservation }
    }

    fn seen(&self) -> Tokens {
        Tokens { output: self.tokens.output.max(self.est_output), ..self.tokens }
    }

    /// 已见用量的花费，越过租约额度就中断流。
    fn seen_cost(&self) -> i64 {
        cost_milli(&self.rate, &self.seen())
    }

    /// 计入放行判断的花费：上游还没报用量时不低于预留。
    fn live(&self) -> i64 {
        let c = self.seen_cost();
        if self.metered { c } else { c.max(self.reservation) }
    }

    /// 结束时的花费：拿到终帧用量按实际，否则按已见部分。
    fn final_tokens(&self, usage_final: bool) -> Tokens {
        if usage_final { self.tokens } else { self.seen() }
    }
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
    if route.protocol != "anthropic" {
        // TODO(S1 之后): 协议转换
        return anthropic_error(
            StatusCode::NOT_IMPLEMENTED,
            "api_error",
            &format!("OneX Edge 暂不支持 {} 协议的上游。", route.protocol),
        );
    }
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

    let mut url = format!("{}/v1/messages", route.base_url.trim_end_matches('/'));
    if let Some(q) = uri.query() {
        url.push('?');
        url.push_str(q);
    }
    let client = match rt.client_for(&url, route.proxy.as_deref()) {
        Ok(c) => c,
        Err(e) => {
            warn!(provider_id = %route.provider_id, error = %e, "bad route proxy");
            return anthropic_error(StatusCode::BAD_GATEWAY, "api_error", "OneX 路由的代理设置无效，请联系管理员。");
        }
    };

    let meter = Meter::new(rate, max_tokens);
    let ticket = match rt.state.lease.admit(meter.reservation) {
        Ok(t) => t,
        Err(b) => {
            info!(model = %model, reason = ?b, "request blocked by lease");
            return block_response(b);
        }
    };

    let upstream_model = route.upstream_model.clone().unwrap_or_else(|| model.clone());
    let body = if upstream_model != model {
        req["model"] = Value::String(upstream_model.clone());
        Bytes::from(serde_json::to_vec(&req).unwrap())
    } else {
        body
    };

    let mut out_headers = forward_headers(&headers);
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
        session_id: None,
    };
    let mut req = Req { rt: rt.clone(), rec, meter, ticket, started };

    let send = client.post(&url).headers(out_headers).body(body).send();
    let resp = tokio::select! {
        r = send => r,
        b = req.ticket.stopped() => {
            req.rec.outcome = Outcome::Stopped(b);
            req.finish();
            return block_response(b);
        }
    };
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            warn!(request_id = %req.rec.request_id, provider_id = %req.rec.provider_id, error = %e.without_url(), "upstream request failed");
            // 没收到任何响应，按零计。
            req.rec.usage_final = true;
            req.finish();
            return anthropic_error(StatusCode::BAD_GATEWAY, "api_error", "OneX 连接上游模型服务失败，请稍后重试。");
        }
    };

    let status = resp.status();
    let resp_headers = response_headers(resp.headers());
    let is_sse = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/event-stream"));

    if status.is_success() && is_sse {
        let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(16);
        tokio::spawn(pump(req, resp, tx));
        let body = Body::from_stream(tokio_stream_from(rx));
        return (status, resp_headers, body).into_response();
    }

    // 非流式，或上游返回错误：读完整个响应再转发。cutoff 和过期时放弃读取。
    let read = tokio::select! {
        r = read_limited(resp, MAX_UPSTREAM_BODY) => r,
        b = req.ticket.stopped() => {
            req.rec.outcome = Outcome::Stopped(b);
            req.finish();
            return block_response(b);
        }
    };
    let bytes = match read {
        Ok(b) => b,
        Err(e) => {
            warn!(request_id = %req.rec.request_id, error = %e, "upstream body read failed");
            req.finish();
            return anthropic_error(StatusCode::BAD_GATEWAY, "api_error", "上游模型服务的响应中断，请重试。");
        }
    };
    if status.is_success() {
        req.rec.outcome = Outcome::Ok;
        if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
            req.rec.message_id = v.get("id").and_then(Value::as_str).map(str::to_owned);
            if let Some(u) = v.get("usage") {
                apply_usage(&mut req.meter.tokens, u);
                req.rec.usage_final = true;
            }
        }
        if !req.rec.usage_final {
            // 2xx 却没有 usage：按预留计，标待结算。
            warn!(request_id = %req.rec.request_id, "upstream response has no usage");
        }
    } else {
        req.rec.outcome = Outcome::UpstreamStatus(status.as_u16());
        // 上游 4xx/5xx 不计 token。
        req.rec.usage_final = true;
    }
    req.finish();
    (status, resp_headers, bytes).into_response()
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
    fn finish(self) {
        let Req { rt, mut rec, meter, ticket, started } = self;
        rec.tokens = meter.final_tokens(rec.usage_final);
        rec.cost_milli = if rec.usage_final {
            cost_milli(&meter.rate, &rec.tokens)
        } else if matches!(rec.outcome, Outcome::Ok) {
            // 正常结束却没有用量（非流式 2xx 无 usage）：没有任何依据，按预留计
            meter.live()
        } else {
            cost_milli(&meter.rate, &rec.tokens)
        };
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
        let _ = rt.usage_tx.send(rec);
    }
}

/// 把上游 SSE 转发给客户端，直到上游结束、上游出错、客户端断开或租约中断。
async fn pump(mut req: Req, mut resp: reqwest::Response, tx: mpsc::Sender<Result<Bytes, std::io::Error>>) {
    let mut split = Splitter::default();
    let mut stopped = false;
    let outcome = 'pump: loop {
        let chunk = tokio::select! {
            // 慢流期间客户端断开也要及时发现，不能等到上游下一个字节。
            _ = tx.closed() => break Outcome::ClientCancelled,
            b = req.ticket.stopped() => break Outcome::Stopped(b),
            c = resp.chunk() => c,
        };
        match chunk {
            Ok(Some(c)) => {
                let (out, events) = split.push(&c);
                for ev in &events {
                    observe(&mut req.rec, &mut req.meter, &mut stopped, ev);
                }
                // 先计价再转发：越过额度的那批字节不发给客户端。
                if !events.is_empty() {
                    if let Err(b) = req.ticket.update(req.meter.live(), req.meter.seen_cost()) {
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
    let ev = match outcome {
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
                apply_usage(&mut m.tokens, u);
                // 兼容上游有的在 message_start 里全给 0，只在终帧报真实数字，这种继续按预留计。
                let t = &m.tokens;
                m.metered = t.input + t.cache_read + t.cache_write > 0;
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
            if let Some(u) = v.get("usage") {
                apply_usage(&mut m.tokens, u);
                rec.usage_final = true;
                m.metered = true;
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
        let mut m = Meter::new(rate(), 1000);
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
        assert!(m.metered && !rec.usage_final);
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
        let mut m = Meter::new(rate(), 0);
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
    fn live_cost_uses_reservation_until_usage_known() {
        let mut rec = rec();
        // 预留 = 1000 × 15000 / 1e6 = 15
        let mut m = Meter::new(rate(), 1000);
        assert_eq!(m.live(), 15);
        let mut s = false;
        // message_start 全是 0：继续按预留
        observe(
            &mut rec,
            &mut m,
            &mut s,
            &ev("message_start", json!({"message":{"usage":{"input_tokens":0,"output_tokens":0}}})),
        );
        assert!(!m.metered);
        assert_eq!(m.live(), 15);
        // 估算的输出超过预留时取较大者：3000 字节 ≈ 1000 token ≈ 15，再多就超过
        let text = "x".repeat(6000);
        observe(
            &mut rec,
            &mut m,
            &mut s,
            &ev("content_block_delta", json!({"delta":{"type":"text_delta","text":text}})),
        );
        assert_eq!(m.est_output, 2000);
        assert_eq!(m.live(), 30);
        // 中断时按已见部分计
        assert_eq!(m.final_tokens(false).output, 2000);
    }

    #[test]
    fn live_cost_after_usage_known_tracks_deltas() {
        let mut rec = rec();
        let mut m = Meter::new(rate(), 100_000);
        let mut s = false;
        observe(
            &mut rec,
            &mut m,
            &mut s,
            &ev("message_start", json!({"message":{"usage":{"input_tokens":1_000_000,"output_tokens":1}}})),
        );
        // 输入 1M × 3000 = 3000，输出 1 token 向上取整后并入
        assert_eq!(m.live(), 3_000 + 1);
        observe(
            &mut rec,
            &mut m,
            &mut s,
            &ev("content_block_delta", json!({"delta":{"type":"input_json_delta","partial_json":"x".repeat(300_000)}})),
        );
        // 100_000 token × 15000 / 1e6 = 1500
        assert_eq!(m.live(), 4_500);
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
