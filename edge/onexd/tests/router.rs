//! 本机 router 对进程内假 Anthropic 上游的测试。
//!
//! 假上游按请求头 `x-test-scenario` 决定行为（router 会把这个头原样转发）。

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use futures_util::StreamExt;
use onex_core::ws::{Route, UpstreamAuth};
use onexd::router::{Outcome, Router, Tokens, UsageRecord};
use onexd::state::{ConfigSnapshot, State};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{sleep, timeout};

const T: Duration = Duration::from_secs(5);
const LOCAL: &str = "local-token";
const KEY: &str = "sk-upstream-secret";

#[derive(Default)]
struct Seen {
    headers: Option<HeaderMap>,
    body: Option<Value>,
    query: Option<String>,
}

struct Upstream {
    addr: SocketAddr,
    seen: Arc<Mutex<Seen>>,
    /// 流被丢弃（连接关闭）时收到通知
    dropped: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

struct DropSignal(Option<oneshot::Sender<()>>);
impl Drop for DropSignal {
    fn drop(&mut self) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(());
        }
    }
}

fn sse(event: &str, data: Value) -> Bytes {
    Bytes::from(format!("event: {event}\ndata: {data}\n\n"))
}

fn stream_events(text: &str) -> Vec<Bytes> {
    vec![
        sse(
            "message_start",
            json!({"type":"message_start","message":{"id":"msg_up_1","type":"message","role":"assistant","model":"claude-up",
            "content":[],"stop_reason":null,"usage":{"input_tokens":12,"output_tokens":1,"cache_read_input_tokens":3000,"cache_creation_input_tokens":200}}}),
        ),
        sse(
            "content_block_start",
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        ),
        sse("ping", json!({"type":"ping"})),
        sse(
            "content_block_delta",
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":text}}),
        ),
        sse("content_block_stop", json!({"type":"content_block_stop","index":0})),
        sse(
            "message_delta",
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":57}}),
        ),
        sse("message_stop", json!({"type":"message_stop"})),
    ]
}

impl Upstream {
    async fn start() -> Self {
        let seen = Arc::new(Mutex::new(Seen::default()));
        let dropped: Arc<Mutex<Option<oneshot::Sender<()>>>> = Arc::default();
        let (s, d) = (seen.clone(), dropped.clone());
        let app = axum::Router::new().route(
            "/v1/messages",
            post(move |uri: axum::http::Uri, headers: HeaderMap, body: Bytes| {
                let (s, d) = (s.clone(), d.clone());
                async move {
                    let scenario =
                        headers.get("x-test-scenario").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                    {
                        let mut s = s.lock().unwrap();
                        s.headers = Some(headers);
                        s.body = serde_json::from_slice(&body).ok();
                        s.query = uri.query().map(String::from);
                    }
                    upstream_response(&scenario, d.lock().unwrap().take())
                }
            }),
        );
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        Self { addr, seen, dropped }
    }

    fn on_drop(&self) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        *self.dropped.lock().unwrap() = Some(tx);
        rx
    }
}

fn sse_response(chunks: impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static) -> Response {
    Response::builder()
        .header("content-type", "text/event-stream")
        .header("request-id", "req_upstream_1")
        .body(Body::from_stream(chunks))
        .unwrap()
}

fn upstream_response(scenario: &str, drop_tx: Option<oneshot::Sender<()>>) -> Response {
    match scenario {
        "stream" => {
            // 故意按奇怪的位置切块，测试 router 的 SSE 重组。
            let all: Vec<u8> = stream_events("你好").concat();
            let chunks: Vec<Result<Bytes, std::io::Error>> = all.chunks(7).map(|c| Ok(Bytes::copy_from_slice(c))).collect();
            sse_response(futures_util::stream::iter(chunks))
        }
        "slow" => {
            let guard = DropSignal(drop_tx);
            let s = futures_util::stream::iter(stream_events("slow")).then(move |b| {
                let _g = &guard;
                async move {
                    sleep(Duration::from_millis(60)).await;
                    Ok::<_, std::io::Error>(b)
                }
            });
            sse_response(s)
        }
        "hang" => {
            // 发完 message_start 后不再发任何东西，用来测客户端断开。
            let guard = DropSignal(drop_tx);
            let first = stream_events("x").remove(0);
            let s = futures_util::stream::once(async move { Ok::<_, std::io::Error>(first) })
                .chain(futures_util::stream::pending())
                .map(move |x| {
                    let _g = &guard;
                    x
                });
            sse_response(s)
        }
        "cut" => {
            // 发到一半（含半个事件）就断开连接。
            let evs = stream_events("partial");
            let mut chunks: Vec<Result<Bytes, std::io::Error>> = evs[..4].iter().cloned().map(Ok).collect();
            chunks.push(Ok(Bytes::from_static(b"event: content_block_delta\ndata: {\"ty")));
            // 先让前面的块真正发出去，再断开。
            let boom = futures_util::stream::once(async {
                sleep(Duration::from_millis(50)).await;
                Err(std::io::Error::other("boom"))
            });
            sse_response(futures_util::stream::iter(chunks).chain(boom))
        }
        "eof" => {
            // 干净地结束，但没有 message_stop。
            let evs = stream_events("eof");
            sse_response(futures_util::stream::iter(evs[..3].iter().cloned().map(Ok).collect::<Vec<_>>()))
        }
        "overloaded" => (
            StatusCode::from_u16(529).unwrap(),
            [("content-type", "application/json")],
            json!({"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}).to_string(),
        )
            .into_response(),
        _ => (
            [("content-type", "application/json"), ("request-id", "req_upstream_2")],
            json!({"id":"msg_up_2","type":"message","role":"assistant","model":"claude-up","content":[{"type":"text","text":"hi"}],
                "stop_reason":"end_turn","usage":{"input_tokens":20,"output_tokens":5,"cache_read_input_tokens":7,"cache_creation_input_tokens":0}})
            .to_string(),
        )
            .into_response(),
    }
}

struct Env {
    url: String,
    upstream: Upstream,
    usage: mpsc::UnboundedReceiver<UsageRecord>,
    state: Arc<State>,
    http: reqwest::Client,
}

async fn env_with(auth: UpstreamAuth, upstream_model: Option<&str>) -> Env {
    let upstream = Upstream::start().await;
    let state = Arc::new(State::default());
    *state.config.write().unwrap() = ConfigSnapshot {
        revision: 1,
        routes: vec![Route {
            model: "claude-*".into(),
            provider_id: "prv_1".into(),
            protocol: "anthropic".into(),
            base_url: format!("http://{}/", upstream.addr),
            upstream_model: upstream_model.map(String::from),
            auth,
        }],
    };
    state.secrets.write().unwrap().insert("prv_1".into(), KEY.into());
    let (tx, usage) = mpsc::unbounded_channel();
    let app = Router::new(state.clone(), LOCAL.into(), direct_client(), tx).app();
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/messages", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    Env { url, upstream, usage, state, http: direct_client() }
}

/// 环境里可能配了 HTTP 代理，测试只走回环地址，不经代理。
fn direct_client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

async fn env() -> Env {
    env_with(UpstreamAuth::XApiKey, None).await
}

impl Env {
    fn req(&self, scenario: &str, stream: bool) -> reqwest::RequestBuilder {
        self.http
            .post(&self.url)
            .header("x-api-key", LOCAL)
            .header("anthropic-version", "2023-06-01")
            .header("anthropic-beta", "prompt-caching-2024-07-31")
            .header("x-test-scenario", scenario)
            .json(&json!({"model":"claude-sonnet-5-5","max_tokens":100,"stream":stream,"messages":[{"role":"user","content":"hi"}]}))
    }

    async fn usage(&mut self) -> UsageRecord {
        timeout(T, self.usage.recv()).await.expect("no usage record").unwrap()
    }
}

/// 把 SSE 文本解析成 (event, data JSON) 列表。
fn parse_sse(text: &str) -> Vec<(String, Value)> {
    text.split("\n\n")
        .filter(|b| !b.trim().is_empty())
        .map(|b| {
            let mut ev = String::new();
            let mut data = String::new();
            for line in b.lines() {
                if let Some(v) = line.strip_prefix("event: ") {
                    ev = v.into();
                } else if let Some(v) = line.strip_prefix("data: ") {
                    data = v.into();
                }
            }
            (ev, serde_json::from_str(&data).unwrap())
        })
        .collect()
}

#[tokio::test]
async fn streaming_passthrough_and_usage() {
    let mut e = env().await;
    let resp = e.req("stream", true).send().await.unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers()["content-type"], "text/event-stream");
    assert_eq!(resp.headers()["request-id"], "req_upstream_1");
    let text = resp.text().await.unwrap();
    // 字节级原样转发
    assert_eq!(text.as_bytes(), stream_events("你好").concat().as_slice());

    let u = e.usage().await;
    assert_eq!(u.outcome, Outcome::Ok);
    assert!(u.stream && u.usage_final);
    assert_eq!(u.tokens, Tokens { input: 12, output: 57, cache_read: 3000, cache_write: 200 });
    assert_eq!(u.message_id.as_deref(), Some("msg_up_1"));
    assert_eq!((u.provider_id.as_str(), u.model.as_str()), ("prv_1", "claude-sonnet-5-5"));
    assert!(u.request_id.starts_with("req_"));
}

#[tokio::test]
async fn upstream_auth_headers_are_replaced() {
    let e = env().await;
    e.req("", false).header("authorization", "Bearer local-token").header("cookie", "a=b").send().await.unwrap();
    let seen = e.upstream.seen.lock().unwrap();
    let h = seen.headers.as_ref().unwrap();
    assert_eq!(h["x-api-key"], KEY);
    assert!(h.get("authorization").is_none());
    assert!(h.get("cookie").is_none());
    assert_eq!(h["anthropic-version"], "2023-06-01");
    assert_eq!(h["anthropic-beta"], "prompt-caching-2024-07-31");
    assert_eq!(seen.body.as_ref().unwrap()["model"], "claude-sonnet-5-5");
}

#[tokio::test]
async fn bearer_upstream_and_model_rewrite_and_query() {
    let e = env_with(UpstreamAuth::Bearer, Some("anthropic/claude-sonnet-5.5")).await;
    let url = format!("{}?beta=true", e.url);
    let r = e
        .http
        .post(url)
        .header("authorization", format!("Bearer {LOCAL}"))
        .json(&json!({"model":"claude-sonnet-5-5","max_tokens":1,"messages":[]}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let seen = e.upstream.seen.lock().unwrap();
    let h = seen.headers.as_ref().unwrap();
    assert_eq!(h["authorization"], format!("Bearer {KEY}"));
    assert!(h.get("x-api-key").is_none());
    assert_eq!(seen.body.as_ref().unwrap()["model"], "anthropic/claude-sonnet-5.5");
    assert_eq!(seen.query.as_deref(), Some("beta=true"));
}

#[tokio::test]
async fn slow_stream_is_forwarded_incrementally() {
    let mut e = env().await;
    let started = Instant::now();
    let resp = e.req("slow", true).send().await.unwrap();
    let mut body = resp.bytes_stream();
    let first = timeout(T, body.next()).await.unwrap().unwrap().unwrap();
    let first_at = started.elapsed();
    assert!(String::from_utf8_lossy(&first).contains("message_start"));
    let mut rest = Vec::new();
    while let Some(c) = timeout(T, body.next()).await.unwrap() {
        rest.extend_from_slice(&c.unwrap());
    }
    let total = started.elapsed();
    // 7 个事件各隔 60 ms；第一个事件不能等到全部结束才到。
    assert!(total >= Duration::from_millis(400), "{total:?}");
    assert!(first_at < total - Duration::from_millis(250), "first {first_at:?} total {total:?}");
    let u = e.usage().await;
    assert_eq!(u.outcome, Outcome::Ok);
    assert_eq!(u.tokens.output, 57);
}

#[tokio::test]
async fn upstream_cut_mid_stream_sends_error_event() {
    let mut e = env().await;
    let text = e.req("cut", true).send().await.unwrap().text().await.unwrap();
    let evs = parse_sse(&text);
    let names: Vec<&str> = evs.iter().map(|(n, _)| n.as_str()).collect();
    // 完整的 4 个事件，半个事件被丢弃，最后是 error。
    assert_eq!(names, ["message_start", "content_block_start", "ping", "content_block_delta", "error"]);
    let (_, err) = evs.last().unwrap();
    assert_eq!(err["type"], "error");
    assert_eq!(err["error"]["type"], "api_error");
    assert!(err["error"]["message"].as_str().unwrap().contains("中断"));

    let u = e.usage().await;
    assert_eq!(u.outcome, Outcome::UpstreamError);
    assert!(!u.usage_final, "partial usage must be marked as not final");
    assert_eq!(u.tokens.input, 12);
}

#[tokio::test]
async fn upstream_eof_without_message_stop_is_error() {
    let mut e = env().await;
    let text = e.req("eof", true).send().await.unwrap().text().await.unwrap();
    assert_eq!(parse_sse(&text).last().unwrap().0, "error");
    assert_eq!(e.usage().await.outcome, Outcome::UpstreamError);
}

#[tokio::test]
async fn client_disconnect_cancels_upstream() {
    let mut e = env().await;
    let dropped = e.upstream.on_drop();
    let resp = e.req("hang", true).send().await.unwrap();
    let mut body = resp.bytes_stream();
    let first = timeout(T, body.next()).await.unwrap().unwrap().unwrap();
    assert!(String::from_utf8_lossy(&first).contains("message_start"));
    drop(body);

    timeout(T, dropped).await.expect("upstream stream was not cancelled").unwrap();
    let u = e.usage().await;
    assert_eq!(u.outcome, Outcome::ClientCancelled);
    assert!(!u.usage_final);
    assert_eq!(u.tokens.cache_read, 3000);
}

#[tokio::test]
async fn client_disconnect_during_slow_stream() {
    let mut e = env().await;
    let dropped = e.upstream.on_drop();
    let resp = e.req("slow", true).send().await.unwrap();
    let mut body = resp.bytes_stream();
    timeout(T, body.next()).await.unwrap().unwrap().unwrap();
    drop(body);
    timeout(T, dropped).await.expect("upstream stream was not cancelled").unwrap();
    assert_eq!(e.usage().await.outcome, Outcome::ClientCancelled);
}

#[tokio::test]
async fn non_streaming_passthrough_and_usage() {
    let mut e = env().await;
    let r = e.req("", false).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["request-id"], "req_upstream_2");
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["content"][0]["text"], "hi");
    let u = e.usage().await;
    assert_eq!(u.outcome, Outcome::Ok);
    assert!(!u.stream && u.usage_final);
    assert_eq!(u.tokens, Tokens { input: 20, output: 5, cache_read: 7, cache_write: 0 });
    assert_eq!(u.message_id.as_deref(), Some("msg_up_2"));
}

#[tokio::test]
async fn upstream_error_status_is_passed_through() {
    let mut e = env().await;
    let r = e.req("overloaded", true).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 529);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["error"]["type"], "overloaded_error");
    let u = e.usage().await;
    assert_eq!(u.outcome, Outcome::UpstreamStatus(529));
    assert_eq!(u.tokens, Tokens::default());
}

#[tokio::test]
async fn rejects_bad_local_token() {
    let e = env().await;
    for r in [
        e.http.post(&e.url).json(&json!({"model":"claude-x"})),
        e.http.post(&e.url).header("x-api-key", "nope").json(&json!({"model":"claude-x"})),
        e.http.post(&e.url).header("x-api-key", KEY).json(&json!({"model":"claude-x"})),
    ] {
        let r = r.send().await.unwrap();
        assert_eq!(r.status(), 401);
        let v: Value = r.json().await.unwrap();
        assert_eq!(v["type"], "error");
        assert_eq!(v["error"]["type"], "authentication_error");
    }
    assert!(e.upstream.seen.lock().unwrap().headers.is_none());
}

#[tokio::test]
async fn unknown_model_and_missing_secret_and_bad_body() {
    let e = env().await;
    let r = e.http.post(&e.url).header("x-api-key", LOCAL).json(&json!({"model":"gpt-9"})).send().await.unwrap();
    assert_eq!(r.status(), 404);
    let v: Value = r.json().await.unwrap();
    assert!(v["error"]["message"].as_str().unwrap().contains("gpt-9"));

    let r = e.http.post(&e.url).header("x-api-key", LOCAL).body("{").send().await.unwrap();
    assert_eq!(r.status(), 400);
    assert_eq!(r.json::<Value>().await.unwrap()["error"]["type"], "invalid_request_error");

    e.state.secrets.write().unwrap().clear();
    let r = e.req("", false).send().await.unwrap();
    assert_eq!(r.status(), 503);
    assert_eq!(r.json::<Value>().await.unwrap()["type"], "error");
    assert!(e.upstream.seen.lock().unwrap().headers.is_none());
}

#[tokio::test]
async fn upstream_unreachable() {
    let mut e = env().await;
    let dead = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap();
    e.state.config.write().unwrap().routes[0].base_url = format!("http://{dead}");
    let r = e.req("", true).send().await.unwrap();
    assert_eq!(r.status(), 502);
    assert_eq!(r.json::<Value>().await.unwrap()["error"]["type"], "api_error");
    assert_eq!(e.usage().await.outcome, Outcome::UpstreamError);
}
