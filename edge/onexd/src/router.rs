//! 本机 router：`127.0.0.1:<port>` 上的 Anthropic Messages 透传。
//!
//! 校验本机令牌 → 按 `config.routes` 选上游 → 换成上游密钥 → 转发；流式响应按完整 SSE 事件转发，
//! 同时从 `message_start`、`message_delta` 提取 usage。客户端断开时丢弃上游响应（reqwest 随之关闭连接）；
//! 上游中途断开时给客户端补一个 Anthropic 格式的 `error` 事件。

use std::sync::Arc;
use std::time::Instant;

use axum::Router as AxumRouter;
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, State as AxState};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use onex_core::ws::{Route, UpstreamAuth};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::id;
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
}

impl Outcome {
    // CONTRACT-PENDING: usage.status 的取值契约没定义，这是 Edge 的提议。
    pub fn as_str(&self) -> String {
        match self {
            Outcome::Ok => "ok".into(),
            Outcome::UpstreamStatus(s) => format!("upstream_{s}"),
            Outcome::UpstreamError => "upstream_error".into(),
            Outcome::ClientCancelled => "client_cancelled".into(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

/// 一次请求的计量结果。S1-E2 在这里计价并写 outbox。
#[derive(Debug, Clone)]
pub struct UsageRecord {
    pub request_id: String,
    /// 上游的 message id（`msg_...`）
    pub message_id: Option<String>,
    pub provider_id: String,
    /// Agent 请求的模型名
    pub model: String,
    /// 实际发给上游的模型名
    pub upstream_model: String,
    pub tokens: Tokens,
    /// 是否拿到了最终用量。流式中途断开时只有 `message_start` 的部分数字，
    /// 按访谈记录要“标为待结算，不能当作零”。
    pub usage_final: bool,
    pub outcome: Outcome,
    pub stream: bool,
    pub duration_ms: u64,
    // TODO(claude-code.md): 从请求头或 metadata 里取会话 id。
    pub session_id: Option<String>,
}

pub struct Router {
    state: Arc<State>,
    local_token: String,
    http: reqwest::Client,
    usage_tx: mpsc::UnboundedSender<UsageRecord>,
}

impl Router {
    pub fn new(
        state: Arc<State>,
        local_token: String,
        http: reqwest::Client,
        usage_tx: mpsc::UnboundedSender<UsageRecord>,
    ) -> Arc<Self> {
        Arc::new(Self { state, local_token, http, usage_tx })
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

    let route = {
        let cfg = rt.state.config.read().unwrap();
        select_route(&cfg.routes, &model).cloned()
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
    let Some(key) = rt.state.secrets.read().unwrap().get(&route.provider_id).cloned() else {
        return anthropic_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "api_error",
            "OneX 还没有收到这个模型的上游密钥。请确认 OneX Desktop 已登录并在线，稍后重试。",
        );
    };

    let upstream_model = route.upstream_model.clone().unwrap_or_else(|| model.clone());
    let body = if upstream_model != model {
        req["model"] = Value::String(upstream_model.clone());
        Bytes::from(serde_json::to_vec(&req).unwrap())
    } else {
        body
    };

    let mut url = format!("{}/v1/messages", route.base_url.trim_end_matches('/'));
    if let Some(q) = uri.query() {
        url.push('?');
        url.push_str(q);
    }

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
        upstream_model,
        tokens: Tokens::default(),
        usage_final: false,
        outcome: Outcome::UpstreamError,
        stream,
        duration_ms: 0,
        session_id: None,
    };

    let resp = match rt.http.post(&url).headers(out_headers).body(body).send().await {
        Ok(r) => r,
        Err(e) => {
            warn!(request_id = %rec.request_id, provider_id = %rec.provider_id, error = %e.without_url(), "upstream request failed");
            rt.finish(rec, started);
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
        tokio::spawn(pump(rt.clone(), resp, tx, rec, started));
        let body = Body::from_stream(tokio_stream_from(rx));
        return (status, resp_headers, body).into_response();
    }

    // 非流式，或上游返回错误：读完整个响应再转发。
    let mut rec = rec;
    let bytes = match read_limited(resp, MAX_UPSTREAM_BODY).await {
        Ok(b) => b,
        Err(e) => {
            warn!(request_id = %rec.request_id, error = %e, "upstream body read failed");
            rt.finish(rec, started);
            return anthropic_error(StatusCode::BAD_GATEWAY, "api_error", "上游模型服务的响应中断，请重试。");
        }
    };
    if status.is_success() {
        rec.outcome = Outcome::Ok;
        if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
            rec.message_id = v.get("id").and_then(Value::as_str).map(str::to_owned);
            if let Some(u) = v.get("usage") {
                apply_usage(&mut rec.tokens, u);
                rec.usage_final = true;
            }
        }
    } else {
        rec.outcome = Outcome::UpstreamStatus(status.as_u16());
        // 上游 4xx/5xx 不计 token。
        rec.usage_final = true;
    }
    rt.finish(rec, started);
    (status, resp_headers, bytes).into_response()
}

impl Router {
    fn finish(&self, mut rec: UsageRecord, started: Instant) {
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
            usage_final = rec.usage_final,
            duration_ms = rec.duration_ms,
            "request done"
        );
        let _ = self.usage_tx.send(rec);
    }
}

/// 把上游 SSE 转发给客户端，直到上游结束、上游出错或客户端断开。
async fn pump(
    rt: Arc<Router>,
    mut resp: reqwest::Response,
    tx: mpsc::Sender<Result<Bytes, std::io::Error>>,
    mut rec: UsageRecord,
    started: Instant,
) {
    let mut split = Splitter::default();
    let mut stopped = false;
    let outcome = loop {
        let chunk = tokio::select! {
            // 慢流期间客户端断开也要及时发现，不能等到上游下一个字节。
            _ = tx.closed() => break Outcome::ClientCancelled,
            c = resp.chunk() => c,
        };
        match chunk {
            Ok(Some(c)) => {
                let (out, events) = split.push(&c);
                for ev in &events {
                    observe(&mut rec, &mut stopped, ev);
                }
                if !out.is_empty() && tx.send(Ok(out)).await.is_err() {
                    break Outcome::ClientCancelled;
                }
            }
            Ok(None) if stopped => break Outcome::Ok,
            Ok(None) => {
                warn!(request_id = %rec.request_id, partial = split.has_partial(), "upstream stream ended before message_stop");
                break Outcome::UpstreamError;
            }
            Err(e) => {
                warn!(request_id = %rec.request_id, error = %e.without_url(), "upstream stream error");
                break Outcome::UpstreamError;
            }
        }
    };
    // 先丢掉上游响应，关闭上游连接，再处理收尾。
    drop(resp);
    if outcome == Outcome::UpstreamError {
        let ev = sse_error("api_error", "上游模型服务的连接中断，本次回复不完整，请重试。");
        let _ = tx.send(Ok(ev)).await;
    }
    rec.outcome = outcome;
    rt.finish(rec, started);
}

fn observe(rec: &mut UsageRecord, stopped: &mut bool, ev: &Event) {
    let ty = ev.event.as_deref().unwrap_or("");
    if !matches!(ty, "message_start" | "message_delta" | "message_stop") {
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(&ev.data) else { return };
    match ty {
        "message_start" => {
            let msg = &v["message"];
            rec.message_id = msg.get("id").and_then(Value::as_str).map(str::to_owned);
            if let Some(u) = msg.get("usage") {
                apply_usage(&mut rec.tokens, u);
            }
        }
        "message_delta" => {
            // message_delta 里的 usage 是累计值，出现就覆盖。
            if let Some(u) = v.get("usage") {
                apply_usage(&mut rec.tokens, u);
                rec.usage_final = true;
            }
        }
        _ => *stopped = true,
    }
}

fn apply_usage(t: &mut Tokens, u: &Value) {
    let get = |k: &str| u.get(k).and_then(Value::as_u64);
    if let Some(n) = get("input_tokens") {
        t.input = n;
    }
    if let Some(n) = get("output_tokens") {
        t.output = n;
    }
    if let Some(n) = get("cache_read_input_tokens") {
        t.cache_read = n;
    }
    if let Some(n) = get("cache_creation_input_tokens") {
        t.cache_write = n;
    }
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

pub fn anthropic_error_body(kind: &str, message: &str) -> Value {
    json!({"type": "error", "error": {"type": kind, "message": message}})
}

pub fn anthropic_error(status: StatusCode, kind: &str, message: &str) -> Response {
    (status, axum::Json(anthropic_error_body(kind, message))).into_response()
}

fn sse_error(kind: &str, message: &str) -> Bytes {
    Bytes::from(format!("event: error\ndata: {}\n\n", anthropic_error_body(kind, message)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(model: &str, p: &str) -> Route {
        Route {
            model: model.into(),
            provider_id: p.into(),
            protocol: "anthropic".into(),
            base_url: "http://x".into(),
            upstream_model: None,
            auth: UpstreamAuth::XApiKey,
        }
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
        let mut rec = UsageRecord {
            request_id: "r".into(),
            message_id: None,
            provider_id: "p".into(),
            model: "m".into(),
            upstream_model: "m".into(),
            tokens: Tokens::default(),
            usage_final: false,
            outcome: Outcome::UpstreamError,
            stream: true,
            duration_ms: 0,
            session_id: None,
        };
        let mut stopped = false;
        let ev = |e: &str, d: Value| Event { event: Some(e.into()), data: d.to_string() };
        observe(
            &mut rec,
            &mut stopped,
            &ev(
                "message_start",
                json!({"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":100,"cache_creation_input_tokens":20}}}),
            ),
        );
        assert_eq!(rec.tokens, Tokens { input: 10, output: 1, cache_read: 100, cache_write: 20 });
        assert!(!rec.usage_final);
        observe(
            &mut rec,
            &mut stopped,
            &ev("message_delta", json!({"type":"message_delta","usage":{"output_tokens":42}})),
        );
        assert_eq!(rec.tokens, Tokens { input: 10, output: 42, cache_read: 100, cache_write: 20 });
        assert!(rec.usage_final && !stopped);
        observe(&mut rec, &mut stopped, &ev("message_stop", json!({"type":"message_stop"})));
        assert!(stopped);
        assert_eq!(rec.message_id.as_deref(), Some("msg_1"));
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
