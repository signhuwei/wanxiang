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
use onex_core::ws::{Lease, Rate, Route, UpstreamAuth};
use onexd::lease::{Block, CutoffReason};
use onexd::outbox::now_ms;
use onexd::pricing::format_ms;
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
    /// 上游收到的请求数
    calls: usize,
    headers: Option<HeaderMap>,
    body: Option<Value>,
    query: Option<String>,
    path: Option<String>,
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
        let messages = post(move |uri: axum::http::Uri, headers: HeaderMap, body: Bytes| {
            let (s, d) = (s.clone(), d.clone());
            async move {
                let scenario = headers.get("x-test-scenario").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                {
                    let mut s = s.lock().unwrap();
                    s.calls += 1;
                    s.headers = Some(headers);
                    s.body = serde_json::from_slice(&body).ok();
                    s.query = uri.query().map(String::from);
                    s.path = Some(uri.path().into());
                }
                if uri.path() == "/v1/messages/count_tokens" && scenario == "count" {
                    return axum::Json(json!({"input_tokens": 128})).into_response();
                }
                upstream_response(&scenario, d.lock().unwrap().take())
            }
        });
        let app =
            axum::Router::new().route("/v1/messages", messages.clone()).route("/v1/messages/count_tokens", messages);
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
        "long" => {
            // message_start 之后 40 个各 300 字节的 delta，每个约 100 token
            let guard = DropSignal(drop_tx);
            let evs = stream_events("x");
            let delta = sse(
                "content_block_delta",
                json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"y".repeat(300)}}),
            );
            let mut all = vec![evs[0].clone(), evs[1].clone()];
            all.extend(std::iter::repeat_n(delta, 40));
            all.extend(evs[4..].iter().cloned());
            let s = futures_util::stream::iter(all).then(move |b| {
                let _g = &guard;
                async move {
                    sleep(Duration::from_millis(10)).await;
                    Ok::<_, std::io::Error>(b)
                }
            });
            sse_response(s)
        }
        "hang_zero" => {
            // 只在终帧报用量的上游：message_start 全是 0，然后挂住
            let guard = DropSignal(drop_tx);
            let first = sse(
                "message_start",
                json!({"type":"message_start","message":{"id":"msg_z","usage":{"input_tokens":0,"output_tokens":0}}}),
            );
            let s = futures_util::stream::once(async move { Ok::<_, std::io::Error>(first) })
                .chain(futures_util::stream::pending())
                .map(move |x| {
                    let _g = &guard;
                    x
                });
            sse_response(s)
        }
        "late_usage" => {
            let s = vec![
                sse("message_start", json!({"type":"message_start","message":{"id":"msg_l","usage":{"input_tokens":0,"output_tokens":0}}})),
                sse("content_block_delta", json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}})),
                sse("message_delta", json!({"type":"message_delta","usage":{"input_tokens":100,"output_tokens":10}})),
                sse("message_stop", json!({"type":"message_stop"})),
            ];
            sse_response(futures_util::stream::iter(s.into_iter().map(Ok)))
        }
        "no_final_usage" | "empty_final_usage" => {
            // 只发零占位、正文、message_stop；没有真实尾用量（或尾用量是空对象）
            let mut s = vec![
                sse("message_start", json!({"type":"message_start","message":{"id":"msg_n","usage":{"input_tokens":0,"output_tokens":0}}})),
                sse("content_block_delta", json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"y".repeat(30)}})),
            ];
            if scenario == "empty_final_usage" {
                s.push(sse("message_delta", json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}})));
            }
            s.push(sse("message_stop", json!({"type":"message_stop"})));
            sse_response(futures_util::stream::iter(s.into_iter().map(Ok)))
        }
        "no_usage" => (
            [("content-type", "application/json")],
            json!({"id":"msg_nu","type":"message","role":"assistant","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn"})
                .to_string(),
        )
            .into_response(),
        "eof" => {
            // 干净地结束，但没有 message_stop。
            let evs = stream_events("eof");
            sse_response(futures_util::stream::iter(evs[..3].iter().cloned().map(Ok).collect::<Vec<_>>()))
        }
        "error_event" => {
            // HTTP 200 的 SSE，中途一个真实的业务 error 事件，之后连接正常关闭。
            let evs = vec![
                stream_events("x").remove(0),
                sse("error", json!({"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}})),
            ];
            sse_response(futures_util::stream::iter(evs.into_iter().map(Ok)))
        }
        "stop_then_error_same_chunk" => {
            // message_stop 和一个之后多余的 error 事件在同一个网络块里到达：
            // 协议上 message_stop 先到，就是这次请求的终态，后面那个 error 不该再改变结局。
            let mut all: Vec<u8> = stream_events("same-chunk").concat();
            all.extend_from_slice(
                &sse("error", json!({"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}})),
            );
            sse_response(futures_util::stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from(all))]))
        }
        "error_then_stop_same_chunk" => {
            let mut all = stream_events("same-chunk")[0].to_vec();
            all.extend_from_slice(
                &sse("error", json!({"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}})),
            );
            all.extend_from_slice(&sse("message_stop", json!({"type":"message_stop"})));
            sse_response(futures_util::stream::iter([Ok::<_, std::io::Error>(Bytes::from(all))]))
        }
        "stop_then_hang" => {
            // message_stop 已发，但连接不关闭（有的上游在终态后还保持连接）。
            let guard = DropSignal(drop_tx);
            let evs = stream_events("stop-then-hang");
            let s = futures_util::stream::iter(evs).chain(futures_util::stream::pending()).map(move |x| {
                let _g = &guard;
                Ok::<_, std::io::Error>(x)
            });
            sse_response(s)
        }
        "business_error_200" => (
            [("content-type", "application/json")],
            json!({"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}).to_string(),
        )
            .into_response(),
        "overloaded" => (
            StatusCode::from_u16(529).unwrap(),
            [("content-type", "application/json")],
            json!({"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}).to_string(),
        )
            .into_response(),
        "redirect" => {
            // 上游用 3xx 重定向把客户端指向别处；router 不能自己跟过去。
            (StatusCode::FOUND, [("location", "http://127.0.0.1:1/elsewhere")]).into_response()
        }
        "oversized_line" => {
            // message_start 之后一行超大的 data，始终没有换行：router 必须结束而不是无限攒内存。
            let guard = DropSignal(drop_tx);
            let first = stream_events("x").remove(0);
            let huge = Bytes::from(format!("event: content_block_delta\ndata: {}", "y".repeat(2 * 1024 * 1024)));
            let s = futures_util::stream::iter(vec![first, huge]).chain(futures_util::stream::pending()).map(
                move |x| {
                    let _g = &guard;
                    Ok::<_, std::io::Error>(x)
                },
            );
            sse_response(s)
        }
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
        tools: vec![],
        agent_cache: false,
        revision: 1,
        capability_contract: None,
        policy: None,
        policy_blocked: false,
        agents: vec![],
        routes: vec![Route {
            model: "claude-*".into(),
            model_id: "mdl_sonnet".into(),
            provider_id: "prv_1".into(),
            protocol: "anthropic".into(),
            base_url: format!("http://{}/", upstream.addr),
            upstream_model: upstream_model.map(String::from),
            auth,
            proxy: None,
            input_capabilities: None,
        }],
        rates: vec![rate()],
    };
    state.secrets.write().unwrap().insert("prv_1".into(), KEY.into());
    grant(&state, "lse_1", 1, 1_000_000, 600_000);
    let (tx, usage) = mpsc::unbounded_channel();
    let app = Router::new(state.clone(), LOCAL.into(), direct_client(), tx).app();
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/messages", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    Env { url, upstream, usage, state, http: direct_client() }
}

/// 每 token：输入 1、输出 2、缓存读 0.1、缓存写 1.25 毫橡皮。
fn rate() -> Rate {
    Rate {
        model_id: "mdl_sonnet".into(),
        input_milli_per_mtok: 1_000_000,
        output_milli_per_mtok: 2_000_000,
        cache_read_milli_per_mtok: 100_000,
        cache_write_milli_per_mtok: 1_250_000,
        effective_from: None,
    }
}

/// stream_events 的用量：12 + 57×2 + 3000×0.1 + 200×1.25
const STREAM_COST: i64 = 12 + 114 + 300 + 250;

fn grant(state: &State, id: &str, seq: u64, budget: i64, ttl_ms: i64) {
    state
        .lease
        .grant(&Lease {
            model_budgets: Default::default(),
            commerce_plan_id: None,
            id: format!("m_{id}"),
            re: None,
            lease_id: id.into(),
            expires_at: format_ms(now_ms() + ttl_ms),
            budget_milli: budget,
            seq,
        })
        .unwrap();
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

    fn count_req(&self, scenario: &str) -> reqwest::RequestBuilder {
        self.http
            .post(format!("{}/count_tokens?beta=true", self.url))
            .header("x-api-key", LOCAL)
            .header("anthropic-beta", "fixture-beta")
            .header("x-test-scenario", scenario)
            .json(&json!({"model":"claude-sonnet-5-5","messages":[{"role":"user","content":"hi"}]}))
    }

    /// max_tokens=1：预留 = 1×2 + 估算输入 2×1 = 4，用来测实际花费超过预留的情形。
    fn small(&self, scenario: &str, stream: bool) -> reqwest::RequestBuilder {
        self.req(scenario, stream)
            .json(&json!({"model":"claude-sonnet-5-5","max_tokens":1,"stream":stream,"messages":[{"role":"user","content":"hi"}]}))
    }

    fn calls(&self) -> usize {
        self.upstream.seen.lock().unwrap().calls
    }

    fn ledger(&self) -> (i64, i64) {
        let s = self.state.lease.snapshot();
        (s.used_milli, s.inflight_milli)
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
async fn upstream_business_error_event_ends_once_without_doubled_error() {
    let mut e = env().await;
    let text = e.req("error_event", true).send().await.unwrap().text().await.unwrap();
    let evs = parse_sse(&text);
    let names: Vec<&str> = evs.iter().map(|(n, _)| n.as_str()).collect();
    // 上游自己的 error 原样转发一次，不会再被追加一个通用截断错误。
    assert_eq!(names, ["message_start", "error"]);
    assert_eq!(evs[1].1["error"]["type"], "overloaded_error");

    let u = e.usage().await;
    assert_eq!(u.outcome, Outcome::UpstreamError);
    assert!(!u.usage_final);
}

#[tokio::test]
async fn message_stop_ends_stream_without_waiting_for_upstream_eof() {
    let mut e = env().await;
    let dropped = e.upstream.on_drop();
    let started = Instant::now();
    let text = timeout(T, async { e.req("stop_then_hang", true).send().await.unwrap().text().await.unwrap() })
        .await
        .expect("response body did not end after message_stop");
    let elapsed = started.elapsed();
    assert_eq!(parse_sse(&text).last().unwrap().0, "message_stop");
    // 上游在 message_stop 后挂住连接；router 必须在终态后就收尾，不能一直等 EOF。
    timeout(T, dropped).await.expect("upstream connection was not closed after message_stop").unwrap();
    assert!(elapsed < T, "{elapsed:?}");

    let u = e.usage().await;
    assert_eq!(u.outcome, Outcome::Ok);
    assert!(u.usage_final);
}

#[tokio::test]
async fn message_stop_wins_over_a_later_error_in_the_same_chunk() {
    let mut e = env().await;
    let text = e.req("stop_then_error_same_chunk", true).send().await.unwrap().text().await.unwrap();
    // 原样转发至首个终态；随后同批到达的 error 不传给客户端。
    let evs = parse_sse(&text);
    let names: Vec<&str> = evs.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(
        names,
        [
            "message_start",
            "content_block_start",
            "ping",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop"
        ]
    );

    let u = e.usage().await;
    assert_eq!(u.outcome, Outcome::Ok, "first terminal event (message_stop) must win");
    assert!(u.usage_final);
}

#[tokio::test]
async fn upstream_error_wins_over_a_later_stop_in_the_same_chunk() {
    let mut e = env().await;
    let text = e.req("error_then_stop_same_chunk", true).send().await.unwrap().text().await.unwrap();
    let evs = parse_sse(&text);
    let names: Vec<&str> = evs.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names, ["message_start", "error"]);
    assert_eq!(evs[1].1["error"]["type"], "overloaded_error");
    let u = e.usage().await;
    assert_eq!(u.outcome, Outcome::UpstreamError);
    assert!(!u.usage_final);
}

#[tokio::test]
async fn oversized_sse_line_ends_the_stream_cleanly() {
    let mut e = env().await;
    let dropped = e.upstream.on_drop();
    let text = timeout(T, async { e.req("oversized_line", true).send().await.unwrap().text().await.unwrap() })
        .await
        .expect("response body did not end after the oversized line");
    let evs = parse_sse(&text);
    let names: Vec<&str> = evs.iter().map(|(n, _)| n.as_str()).collect();
    // 完整收到 message_start，超限的那行从没组成完整事件，不会被转发；收尾是一个正常的 error 事件。
    assert_eq!(names, ["message_start", "error"]);
    assert_eq!(evs[1].1["error"]["type"], "api_error");
    // 超限必须释放上游连接，不能一直攒内存等换行。
    timeout(T, dropped).await.expect("upstream not cancelled").unwrap();

    let u = e.usage().await;
    assert_eq!(u.outcome, Outcome::UpstreamError);
    assert!(!u.usage_final);
}

#[tokio::test]
async fn upstream_redirect_is_not_followed() {
    let mut e = env().await;
    // 测试客户端自己也不能跟过去，否则看到的是跟随后的结果，不是 router 原样转发的 302。
    let no_redirect =
        reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    let r = no_redirect
        .post(&e.url)
        .header("x-api-key", LOCAL)
        .header("x-test-scenario", "redirect")
        .json(&json!({"model":"claude-sonnet-5-5","max_tokens":1,"messages":[]}))
        .send()
        .await
        .unwrap();
    // reqwest 默认会跟到 location 指向的地址；这里必须原样把 302 和 location 还给客户端。
    assert_eq!(r.status(), 302);
    assert_eq!(r.headers()["location"], "http://127.0.0.1:1/elsewhere");
    assert_eq!(e.calls(), 1);
    let u = e.usage().await;
    assert_eq!(u.outcome, Outcome::UpstreamStatus(302));
    assert_eq!(u.tokens, Tokens::default());
}

#[tokio::test]
async fn business_error_with_200_status_is_not_recorded_as_ok() {
    let mut e = env().await;
    let r = e.req("business_error_200", false).send().await.unwrap();
    // 下游状态码和响应体原样转发：客户端仍按 Anthropic 的 error 体识别，Edge 不改写成别的状态码。
    assert_eq!(r.status(), 200);
    let text = r.text().await.unwrap();
    assert_eq!(text, json!({"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}).to_string());

    let u = e.usage().await;
    // 内部计量：不算成功终态，已知这次没有消费（不是"未知待结算"），不拿预留充数。
    assert_eq!(u.outcome, Outcome::UpstreamStatus(200));
    assert_eq!(u.tokens, Tokens::default());
    assert_eq!(u.cost_milli, 0);
    assert!(u.usage_final, "zero usage here is a known fact, not pending reconciliation");
    let item = u.to_item();
    assert_eq!((item["status"].as_str(), item["complete"].as_bool()), (Some("upstream_200"), Some(true)));
    assert_eq!(e.ledger(), (0, 0));
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
async fn messages_select_compatible_prefix_over_incompatible_exact_model() {
    let mut e = env_with(UpstreamAuth::XApiKey, Some("claude-up")).await;
    {
        let mut config = e.state.config.write().unwrap();
        let incompatible = Route {
            model: "claude-sonnet-5-5".into(),
            protocol: "openai_responses".into(),
            model_id: "mdl_responses".into(),
            provider_id: "prv_responses".into(),
            ..config.routes[0].clone()
        };
        config.routes.insert(0, incompatible);
    }
    let response = e.req("normal", false).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.json::<Value>().await.unwrap()["id"], "msg_up_2");
    assert_eq!(e.usage().await.provider_id, "prv_1");

    let count = e.count_req("count").send().await.unwrap();
    assert_eq!(count.status(), StatusCode::OK);
    assert_eq!(count.json::<Value>().await.unwrap(), json!({"input_tokens":128}));
    let seen = e.upstream.seen.lock().unwrap();
    assert_eq!(seen.calls, 2);
    assert_eq!(seen.body.as_ref().unwrap()["model"], "claude-up");
}

#[tokio::test]
async fn count_tokens_preserves_request_and_sends_no_usage() {
    let mut e = env_with(UpstreamAuth::Bearer, Some("claude-up")).await;
    // No price is needed for an upstream input-token estimate.
    e.state.config.write().unwrap().rates.clear();
    let before = e.state.lease.snapshot();
    let messages = json!([{"role":"user","content":[
        {"type":"text","text":"test"},
        {"type":"image","source":{"type":"base64","media_type":"image/png","data":"fixture"}}
    ]}]);
    let response = e
        .count_req("count")
        .json(&json!({"model":"claude-sonnet-5-5","messages":messages,"tools":[{"name":"fixture"}]}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.json::<Value>().await.unwrap(), json!({"input_tokens":128}));

    {
        let seen = e.upstream.seen.lock().unwrap();
        let headers = seen.headers.as_ref().unwrap();
        let body = seen.body.as_ref().unwrap();
        assert_eq!(seen.path.as_deref(), Some("/v1/messages/count_tokens"));
        assert_eq!(seen.query.as_deref(), Some("beta=true"));
        assert_eq!(headers["anthropic-beta"], "fixture-beta");
        assert_eq!(headers["authorization"], format!("Bearer {KEY}"));
        assert!(!headers.contains_key("x-api-key"));
        assert_eq!(body["model"], "claude-up");
        assert_eq!(body["messages"], messages);
        assert_eq!(body["tools"], json!([{"name":"fixture"}]));
    }
    assert_eq!(e.calls(), 1);
    assert_eq!(e.state.lease.snapshot(), before);
    assert!(matches!(e.usage.try_recv(), Err(mpsc::error::TryRecvError::Empty)));
    assert_eq!(e.state.upstream.lock().unwrap().completed, 0);
}

#[tokio::test]
async fn count_tokens_enforces_access_and_requires_anthropic_upstream() {
    let e = env().await;
    let request = e
        .http
        .post(format!("{}/count_tokens", e.url))
        .header("x-api-key", "wrong")
        .json(&json!({"model":"claude-sonnet-5-5"}));
    assert_eq!(request.send().await.unwrap().status(), StatusCode::UNAUTHORIZED);

    {
        let mut config = e.state.config.write().unwrap();
        let wildcard = Route { model: "*".into(), ..config.routes[0].clone() };
        config.routes[0].protocol = "openai_chat".into();
        config.routes[0].model = "claude-sonnet-5-5".into();
        config.routes.push(wildcard);
    }
    // Count tokens on the same route as Messages. A different Anthropic fallback could count a different model.
    assert_eq!(e.count_req("count").send().await.unwrap().status(), StatusCode::NOT_IMPLEMENTED);

    e.state.config.write().unwrap().routes[0].protocol = "anthropic".into();
    e.state.lease.cutoff("device_disabled", None).unwrap();
    assert_eq!(e.count_req("count").send().await.unwrap().status(), StatusCode::FORBIDDEN);
    assert_eq!(e.calls(), 0);
}

#[tokio::test]
async fn count_tokens_preserves_upstream_http_error_without_retry_or_usage() {
    let mut e = env().await;
    let response = e.count_req("overloaded").send().await.unwrap();
    assert_eq!(response.status().as_u16(), 529);
    assert_eq!(response.json::<Value>().await.unwrap()["error"]["type"], "overloaded_error");
    assert_eq!(e.calls(), 1);
    assert_eq!(e.ledger(), (0, 0));
    assert!(matches!(e.usage.try_recv(), Err(mpsc::error::TryRecvError::Empty)));
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
    // 连不上时重试一次；两次都没到上游，按零计
    for _ in 0..2 {
        let u = e.usage().await;
        assert_eq!(u.outcome, Outcome::UpstreamError);
        assert!(u.usage_final && u.cost_milli == 0);
    }
}

#[tokio::test]
async fn never_replays_a_transmitted_request_when_response_headers_are_lost() {
    let mut e = env().await;
    // 一个接受连接、读完请求后直接关闭、不回任何响应头的上游
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    let accepts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let n = accepts.clone();
    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        loop {
            let (mut s, _) = l.accept().await.unwrap();
            n.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf).await;
            drop(s);
        }
    });
    e.state.config.write().unwrap().routes[0].base_url = format!("http://{addr}");
    let r = e.req("", true).send().await.unwrap();
    assert_eq!(r.status(), 502);
    assert_eq!(accepts.load(std::sync::atomic::Ordering::SeqCst), 1);
    let usage = e.usage().await;
    assert_eq!(usage.outcome, Outcome::UpstreamError);
    assert!(!usage.usage_final);
    assert_eq!(usage.lease_id.as_deref(), Some("lse_1"));
    assert!(timeout(Duration::from_millis(100), e.usage.recv()).await.is_err());
    assert_eq!(e.state.upstream.lock().unwrap().inflight, 0);
}

#[tokio::test]
async fn no_retry_after_response_headers() {
    let mut e = env().await;
    let text = e.req("cut", true).send().await.unwrap().text().await.unwrap();
    assert_eq!(parse_sse(&text).last().unwrap().0, "error");
    assert_eq!(e.usage().await.outcome, Outcome::UpstreamError);
    // 只有一条 usage
    assert!(timeout(Duration::from_millis(100), e.usage.recv()).await.is_err());
}

// ---- S1-E2 计价与租约 ----

async fn expect_blocked(r: reqwest::Response, status: u16, code: &str) -> Value {
    assert_eq!(r.status().as_u16(), status);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["type"], "error");
    assert_eq!(v["error"]["code"], code);
    let msg = v["error"]["message"].as_str().unwrap();
    assert!(msg.contains("OneX"), "message should be Chinese and actionable: {msg}");
    v
}

#[tokio::test]
async fn streaming_cost_is_priced_and_charged_to_lease() {
    let mut e = env().await;
    e.req("stream", true).send().await.unwrap().text().await.unwrap();
    let u = e.usage().await;
    assert_eq!(u.cost_milli, STREAM_COST);
    assert_eq!(u.lease_id.as_deref(), Some("lse_1"));
    assert_eq!(u.model_id, "mdl_sonnet");
    let item = u.to_item();
    assert_eq!((item["status"].as_str(), item["complete"].as_bool()), (Some("ok"), Some(true)));
    assert_eq!(item["cost_milli"], STREAM_COST);
    assert_eq!(e.state.lease.snapshot().used_milli, STREAM_COST);
}

#[tokio::test]
async fn non_streaming_cost() {
    let mut e = env().await;
    e.req("", false).send().await.unwrap();
    // 20 + 5×2 + 7×0.1 = 30.7 → 31
    assert_eq!(e.usage().await.cost_milli, 31);
}

#[tokio::test]
async fn no_lease_rejects_before_upstream() {
    let e = env().await;
    e.state.lease.cutoff("balance", None).unwrap();
    let r = e.req("stream", true).send().await.unwrap();
    expect_blocked(r, 402, "balance_exhausted").await;
    assert!(e.upstream.seen.lock().unwrap().headers.is_none());
}

#[tokio::test]
async fn expired_lease_rejects_new_requests() {
    let e = env().await;
    grant(&e.state, "lse_2", 2, 1_000_000, -1);
    let r = e.req("", false).send().await.unwrap();
    let v = expect_blocked(r, 402, "lease_expired").await;
    assert_eq!(v["error"]["type"], "billing_error");
    assert!(e.upstream.seen.lock().unwrap().headers.is_none());
}

#[tokio::test]
async fn budget_used_up_rejects_next_request() {
    let mut e = env().await;
    grant(&e.state, "lse_2", 2, STREAM_COST, 600_000);
    e.req("stream", true).send().await.unwrap().text().await.unwrap();
    assert_eq!(e.usage().await.outcome, Outcome::Ok);
    let r = e.req("stream", true).send().await.unwrap();
    expect_blocked(r, 402, "balance_exhausted").await;
}

#[tokio::test]
async fn budget_exhausted_mid_stream_cuts_stream() {
    let mut e = env().await;
    // message_start 时已花 12 + 2 + 300 + 250 = 564；之后每个 delta 约 100 token = 200 毫橡皮
    grant(&e.state, "lse_2", 2, 1_000, 600_000);
    let dropped = e.upstream.on_drop();
    let text = e.req("long", true).send().await.unwrap().text().await.unwrap();
    let evs = parse_sse(&text);
    let (name, err) = evs.last().unwrap();
    assert_eq!(name, "error");
    assert_eq!(err["error"]["code"], "balance_exhausted");
    assert!(err["error"]["message"].as_str().unwrap().contains("中断"));
    // 只转发了额度以内的 delta
    let deltas = evs.iter().filter(|(n, _)| n == "content_block_delta").count();
    assert!((1..=3).contains(&deltas), "{deltas} deltas forwarded");
    assert!(!evs.iter().any(|(n, _)| n == "message_stop"));
    timeout(T, dropped).await.expect("upstream not cancelled").unwrap();

    let u = e.usage().await;
    assert_eq!(u.outcome, Outcome::Stopped(Block::Exhausted));
    let item = u.to_item();
    assert_eq!((item["status"].as_str(), item["complete"].as_bool()), (Some("lease_exhausted"), Some(false)));
    // 按已见部分计价，越过额度的那个 delta 也算
    assert!(u.cost_milli > 1_000, "{}", u.cost_milli);
    let r = e.req("", false).send().await.unwrap();
    expect_blocked(r, 402, "balance_exhausted").await;
}

#[tokio::test]
async fn cutoff_interrupts_inflight_stream() {
    let mut e = env().await;
    let dropped = e.upstream.on_drop();
    let resp = e.req("hang", true).send().await.unwrap();
    let mut body = resp.bytes_stream();
    let first = timeout(T, body.next()).await.unwrap().unwrap().unwrap();
    assert!(String::from_utf8_lossy(&first).contains("message_start"));

    e.state.lease.cutoff("disabled", None).unwrap();
    let mut rest = Vec::new();
    while let Some(c) = timeout(T, body.next()).await.unwrap() {
        rest.extend_from_slice(&c.unwrap());
    }
    let evs = parse_sse(&String::from_utf8(rest).unwrap());
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].1["error"]["type"], "permission_error");
    assert_eq!(evs[0].1["error"]["code"], "forbidden");
    timeout(T, dropped).await.expect("upstream not cancelled").unwrap();

    let u = e.usage().await;
    assert_eq!(u.outcome, Outcome::Stopped(Block::Cutoff(CutoffReason::Disabled)));
    assert!(!u.usage_final);
    // 按 message_start 已见部分计
    assert_eq!(u.cost_milli, 12 + 2 + 300 + 250);

    let r = e.req("", false).send().await.unwrap();
    expect_blocked(r, 403, "forbidden").await;
}

#[tokio::test]
async fn lease_expiry_interrupts_inflight_stream() {
    let mut e = env().await;
    tokio::spawn(e.state.lease.clone().run(tokio_util::sync::CancellationToken::new()));
    grant(&e.state, "lse_2", 2, 1_000_000, 300);
    let resp = e.req("hang", true).send().await.unwrap();
    let text = timeout(T, resp.text()).await.unwrap().unwrap();
    let (name, err) = parse_sse(&text).pop().unwrap();
    assert_eq!(name, "error");
    assert_eq!(err["error"]["code"], "lease_expired");
    assert_eq!(e.usage().await.outcome, Outcome::Stopped(Block::Expired));
}

// 预留 = max_tokens 100 × 2 + 估算输入（"user" + "hi" 共 6 字节 ≈ 2 token）× 1 = 202
const RESERVE: i64 = 202;

#[tokio::test]
async fn reservation_over_lease_budget_is_rejected_before_upstream() {
    let e = env().await;
    // magpie 复现场景：额度 150 < 预留 202，首个请求就不出站
    grant(&e.state, "lse_2", 2, RESERVE - 1, 600_000);
    let r = e.req("hang_zero", true).send().await.unwrap();
    let v = expect_blocked(r, 402, "balance_exhausted").await;
    assert!(v["error"]["message"].as_str().unwrap().contains("max_tokens"));
    assert_eq!(e.calls(), 0);
    assert_eq!(e.ledger(), (0, 0));
    assert!(e.state.lease.take_renew().is_none());
}

#[tokio::test]
async fn concurrent_reservations_must_fit_remaining_budget() {
    let mut e = env().await;
    // 正好放下两份预留
    grant(&e.state, "lse_2", 2, 2 * RESERVE, 600_000);
    let mut a = e.req("hang_zero", true).send().await.unwrap().bytes_stream();
    timeout(T, a.next()).await.unwrap().unwrap().unwrap();
    let mut b = e.req("hang_zero", true).send().await.unwrap().bytes_stream();
    timeout(T, b.next()).await.unwrap().unwrap().unwrap();
    assert_eq!(e.calls(), 2);
    assert_eq!(e.ledger(), (0, 2 * RESERVE));
    // 第三个放不下，不出站；只有在途预留，续租腾不出额度，不发续租
    let r = e.req("", false).send().await.unwrap();
    expect_blocked(r, 402, "balance_exhausted").await;
    assert_eq!(e.calls(), 2);
    assert!(e.state.lease.take_renew().is_none());
    drop(a);
    drop(b);
    for _ in 0..2 {
        let u = e.usage().await;
        assert_eq!(u.outcome, Outcome::ClientCancelled);
        // 没有任何用量：按已见的 0 计，标待结算，预留全部释放
        assert_eq!((u.cost_milli, u.usage_final), (0, false));
    }
    assert_eq!(e.ledger(), (0, 0));
}

#[tokio::test]
async fn non_streaming_success_without_usage_is_pending_not_reservation() {
    let mut e = env().await;
    let r = e.req("no_usage", false).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let u = e.usage().await;
    assert_eq!(u.outcome, Outcome::Ok);
    let item = u.to_item();
    assert_eq!((item["cost_milli"].as_i64(), item["complete"].as_bool()), (Some(0), Some(false)));
    assert_eq!(e.ledger(), (0, 0));
}

#[tokio::test]
async fn stream_without_final_usage_is_priced_on_seen_part_only() {
    for scenario in ["no_final_usage", "empty_final_usage"] {
        let mut e = env().await;
        let text = e.req(scenario, true).send().await.unwrap().text().await.unwrap();
        assert_eq!(parse_sse(&text).last().unwrap().0, "message_stop", "{scenario}");
        let u = e.usage().await;
        // 协议正常结束，但计量不完整
        assert_eq!(u.outcome, Outcome::Ok, "{scenario}");
        assert!(!u.usage_final, "{scenario}");
        // 30 字节 ≈ 10 token × 2 = 20，远小于预留 202
        assert_eq!(u.cost_milli, 20, "{scenario}");
        assert_eq!(e.ledger(), (20, 0), "{scenario}");
    }
}

#[tokio::test]
async fn non_streaming_cost_at_and_over_budget() {
    // 实际 31 > 预留 4：正好用满放行，超出 1 不把内容交给客户端
    let mut e = env().await;
    grant(&e.state, "lse_2", 2, 31, 600_000);
    let r = e.small("", false).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let u = e.usage().await;
    assert_eq!((u.outcome, u.cost_milli, u.usage_final), (Outcome::Ok, 31, true));
    assert_eq!(e.ledger(), (31, 0));

    let mut e = env().await;
    grant(&e.state, "lse_2", 2, 30, 600_000);
    let r = e.small("", false).send().await.unwrap();
    let v = expect_blocked(r, 402, "balance_exhausted").await;
    assert!(v.get("content").is_none());
    assert_eq!(e.calls(), 1);
    let u = e.usage().await;
    // 上游已经处理并报了用量：照实记 31，记在这个租约下
    assert_eq!((u.outcome, u.cost_milli, u.usage_final), (Outcome::Stopped(Block::Exhausted), 31, true));
    assert_eq!(u.lease_id.as_deref(), Some("lse_2"));
    assert_eq!(e.ledger(), (31, 0));
}

#[tokio::test]
async fn streaming_cost_at_and_over_budget() {
    let mut e = env().await;
    grant(&e.state, "lse_2", 2, STREAM_COST, 600_000);
    let text = e.small("stream", true).send().await.unwrap().text().await.unwrap();
    assert_eq!(parse_sse(&text).last().unwrap().0, "message_stop");
    assert_eq!(e.usage().await.cost_milli, STREAM_COST);
    assert_eq!(e.ledger(), (STREAM_COST, 0));

    let mut e = env().await;
    grant(&e.state, "lse_2", 2, STREAM_COST - 1, 600_000);
    let text = e.small("stream", true).send().await.unwrap().text().await.unwrap();
    let evs = parse_sse(&text);
    assert_eq!(evs.last().unwrap().1["error"]["code"], "balance_exhausted");
    assert!(!evs.iter().any(|(n, _)| n == "message_delta" || n == "message_stop"));
    let u = e.usage().await;
    assert_eq!(u.outcome, Outcome::Stopped(Block::Exhausted));
    assert_eq!(e.ledger(), (u.cost_milli, 0));
}

#[tokio::test]
async fn end_frame_usage_settles_reservation() {
    let mut e = env().await;
    e.req("late_usage", true).send().await.unwrap().text().await.unwrap();
    let u = e.usage().await;
    assert!(u.usage_final);
    assert_eq!(u.tokens, Tokens { input: 100, output: 10, ..Default::default() });
    assert_eq!(u.cost_milli, 120);
    assert_eq!(e.state.lease.snapshot().used_milli, 120);
}

#[tokio::test]
async fn missing_rate_rejects() {
    let e = env().await;
    e.state.config.write().unwrap().rates.clear();
    let r = e.req("", false).send().await.unwrap();
    assert_eq!(r.status(), 503);
    assert!(r.json::<Value>().await.unwrap()["error"]["message"].as_str().unwrap().contains("计价"));
    assert!(e.upstream.seen.lock().unwrap().headers.is_none());
}

#[tokio::test]
async fn route_proxy_is_ignored_for_loopback() {
    let e = env().await;
    // 回环地址不论 proxy 怎么写都直连
    e.state.config.write().unwrap().routes[0].proxy = Some("http://127.0.0.1:1".into());
    assert_eq!(e.req("", false).send().await.unwrap().status(), 200);
    e.state.config.write().unwrap().routes[0].proxy = Some("none".into());
    assert_eq!(e.req("", false).send().await.unwrap().status(), 200);
}
