//! `POST /v1/responses`（Codex）对假上游的测试：同协议转发、转 Chat 两条路径，流式和非流式，
//! 用量口径和错误两种形态（未发头 JSON 错误体、已发头 `response.failed`）。

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use onex_core::ws::{Lease, Rate, Route, UpstreamAuth};
use onexd::outbox::now_ms;
use onexd::pricing::format_ms;
use onexd::router::{Router, UsageRecord};
use onexd::state::{ConfigSnapshot, State};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::time::timeout;

const T: Duration = Duration::from_secs(5);
const LOCAL: &str = "local-token";
const KEY: &str = "sk-upstream-secret";

#[derive(Default)]
struct Seen {
    calls: usize,
    body: Option<Value>,
    headers: Option<HeaderMap>,
}

struct Upstream {
    addr: SocketAddr,
    seen: Arc<Mutex<Seen>>,
}

impl Upstream {
    async fn start() -> Self {
        let seen = Arc::new(Mutex::new(Seen::default()));
        let s = seen.clone();
        let handler = post(move |headers: HeaderMap, body: Bytes| {
            let s = s.clone();
            async move {
                let parsed: Option<Value> = serde_json::from_slice(&body).ok();
                let scenario = parsed
                    .as_ref()
                    .and_then(|value| {
                        value["instructions"].as_str().or_else(|| value["messages"][0]["content"].as_str())
                    })
                    .and_then(|content| content.strip_prefix("scenario:"))
                    .unwrap_or_default()
                    .to_owned();
                {
                    let mut s = s.lock().unwrap();
                    s.calls += 1;
                    s.body = parsed;
                    s.headers = Some(headers);
                }
                upstream_response(&scenario)
            }
        });
        let app = axum::Router::new().route("/v1/responses", handler.clone()).route("/v1/chat/completions", handler);
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        Self { addr, seen }
    }
}

fn sse(event: &str, data: Value) -> Bytes {
    Bytes::from(format!("event: {event}\ndata: {data}\n\n"))
}
fn chat_sse(data: Value) -> Bytes {
    Bytes::from(format!("data: {data}\n\n"))
}
const CHAT_DONE: &str = "data: [DONE]\n\n";

fn upstream_response(scenario: &str) -> Response {
    match scenario {
        // 同协议（openai_responses）非流式
        "native" => axum::Json(json!({"id": "resp_up_1", "object": "response", "status": "completed",
            "output": [{"type": "message", "id": "msg_1", "role": "assistant", "status": "completed",
                "content": [{"type": "output_text", "text": "hi", "annotations": []}]}],
            "usage": {"input_tokens": 20, "input_tokens_details": {"cached_tokens": 5}, "output_tokens": 8}}))
        .into_response(),
        // 同协议流式
        "native_stream" => {
            let evs = vec![
                sse(
                    "response.created",
                    json!({"type":"response.created","response":{"id":"resp_up_2","status":"in_progress"}}),
                ),
                sse(
                    "response.output_text.delta",
                    json!({"type":"response.output_text.delta","output_index":0,"delta":"hi"}),
                ),
                sse(
                    "response.completed",
                    json!({"type":"response.completed","response":{"id":"resp_up_2","status":"completed",
                    "output":[{"type":"message","content":[{"type":"output_text","text":"hi"}]}],
                    "usage":{"input_tokens":20,"input_tokens_details":{"cached_tokens":0},"output_tokens":8}}}),
                ),
            ];
            Response::builder()
                .header("content-type", "text/event-stream")
                .body(Body::from_stream(futures_util::stream::iter(evs.into_iter().map(Ok::<_, std::io::Error>))))
                .unwrap()
        }
        // 转 Chat：非流式
        "chat" => axum::Json(json!({"id": "chatcmpl-1", "choices": [{"index": 0,
            "message": {"role": "assistant", "content": "hi there"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5}}))
        .into_response(),
        // 转 Chat：流式，文本
        "chat_stream" => {
            let evs = vec![
                chat_sse(json!({"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi "}}]})),
                chat_sse(json!({"id":"c1","choices":[{"index":0,"delta":{"content":"there"},"finish_reason":"stop"}]})),
                chat_sse(json!({"id":"c1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}})),
                Bytes::from(CHAT_DONE),
            ];
            Response::builder()
                .header("content-type", "text/event-stream")
                .body(Body::from_stream(futures_util::stream::iter(evs.into_iter().map(Ok::<_, std::io::Error>))))
                .unwrap()
        }
        // 转 Chat：流式，工具调用
        "chat_stream_tool" => {
            let evs = vec![
                chat_sse(json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1",
                    "function":{"name":"lookup","arguments":""}}]}}]})),
                chat_sse(json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,
                    "function":{"arguments":"{\"city\":\"SZ\"}"}}]}}]})),
                chat_sse(json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]})),
                chat_sse(json!({"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":5}})),
                Bytes::from(CHAT_DONE),
            ];
            Response::builder()
                .header("content-type", "text/event-stream")
                .body(Body::from_stream(futures_util::stream::iter(evs.into_iter().map(Ok::<_, std::io::Error>))))
                .unwrap()
        }
        "chat_error" => (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error": {"message": "context_length_exceeded", "code": "context_length_exceeded"}})),
        )
            .into_response(),
        // 流已经开始后上游中途报错
        "chat_stream_error" => {
            let evs = vec![
                chat_sse(json!({"choices":[{"index":0,"delta":{"role":"assistant","content":"partial"}}]})),
                chat_sse(json!({"error": {"message": "overloaded"}})),
            ];
            Response::builder()
                .header("content-type", "text/event-stream")
                .body(Body::from_stream(futures_util::stream::iter(evs.into_iter().map(Ok::<_, std::io::Error>))))
                .unwrap()
        }
        "native_budget" | "chat_budget" => {
            let event = if scenario == "native_budget" {
                sse("response.output_text.delta", json!({"type":"response.output_text.delta","delta":"x".repeat(300)}))
            } else {
                chat_sse(json!({"choices":[{"index":0,"delta":{"content":"x".repeat(300)}}]}))
            };
            Response::builder()
                .header("content-type", "text/event-stream")
                .body(Body::from_stream(
                    futures_util::stream::once(async { Ok::<_, std::io::Error>(event) })
                        .chain(futures_util::stream::pending()),
                ))
                .unwrap()
        }
        other => panic!("unknown scenario {other}"),
    }
}

struct Env {
    url: String,
    upstream: Upstream,
    usage: mpsc::UnboundedReceiver<UsageRecord>,
    state: Arc<State>,
    http: reqwest::Client,
}

/// 每 token：输入 1、输出 2、缓存读 0.1 毫橡皮（和 `tests/router.rs` 同一套单价量级）。
fn rate() -> Rate {
    Rate {
        model_id: "mdl_codex".into(),
        input_milli_per_mtok: 1_000_000,
        output_milli_per_mtok: 2_000_000,
        cache_read_milli_per_mtok: 100_000,
        cache_write_milli_per_mtok: 1_250_000,
        effective_from: None,
    }
}

fn grant(state: &State, id: &str, seq: u64, budget: i64, ttl_ms: i64) {
    state
        .lease
        .grant(&Lease {
            id: format!("m_{id}"),
            re: None,
            lease_id: id.into(),
            expires_at: format_ms(now_ms() + ttl_ms),
            budget_milli: budget,
            seq,
        })
        .unwrap();
}

fn direct_client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

async fn env_with(protocol: &str) -> Env {
    let upstream = Upstream::start().await;
    let state = Arc::new(State::default());
    *state.config.write().unwrap() = ConfigSnapshot {
        revision: 1,
        agents: vec![],
        routes: vec![Route {
            model: "codex-model".into(),
            model_id: "mdl_codex".into(),
            provider_id: "prv_1".into(),
            protocol: protocol.into(),
            base_url: format!("http://{}/v1/", upstream.addr),
            upstream_model: None,
            auth: UpstreamAuth::Bearer,
            proxy: None,
        }],
        rates: vec![rate()],
    };
    state.secrets.write().unwrap().insert("prv_1".into(), KEY.into());
    grant(&state, "lse_1", 1, 1_000_000, 600_000);
    let (tx, usage) = mpsc::unbounded_channel();
    let app = Router::new(state.clone(), LOCAL.into(), direct_client(), tx).app();
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/responses", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    Env { url, upstream, usage, state, http: direct_client() }
}

impl Env {
    /// Pass the scenario via instructions and check that private headers stay on loopback.
    fn req(&self, scenario: &str, stream: bool, input: Value) -> reqwest::RequestBuilder {
        self.http
            .post(&self.url)
            .header("authorization", format!("Bearer {LOCAL}"))
            .header("x-test-scenario", scenario)
            .json(&json!({"model": "codex-model", "stream": stream, "input": input,
                "instructions": format!("scenario:{scenario}")}))
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

fn user_input(text: &str) -> Value {
    json!([{"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}])
}

/// 按行手动切分 SSE（整段响应体已经完整到手，不需要 `sse::Splitter` 的增量能力）。
async fn events(resp: reqwest::Response) -> Vec<(Option<String>, Value)> {
    let bytes = resp.bytes().await.unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    let mut out = Vec::new();
    for block in text.split("\n\n") {
        let (mut event, mut data) = (None, String::new());
        for line in block.lines() {
            if let Some(v) = line.strip_prefix("event: ") {
                event = Some(v.to_string());
            } else if let Some(v) = line.strip_prefix("data: ") {
                data = v.to_string();
            }
        }
        if !data.is_empty() {
            out.push((event, serde_json::from_str(&data).unwrap()));
        }
    }
    out
}

#[tokio::test]
async fn native_non_stream_passthrough_and_usage() {
    let mut env = env_with("openai_responses").await;
    let resp = env
        .http
        .post(&env.url)
        .header("authorization", format!("Bearer {LOCAL}"))
        .header("x-test-scenario", "must not reach upstream")
        .header("openai-beta", "responses=2025-01-01")
        .json(&json!({"model":"codex-model", "input":user_input("hi"), "instructions":"scenario:native",
            "previous_response_id":"resp_old", "store":true, "include":["reasoning.encrypted_content"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["output"][0]["content"][0]["text"], "hi");
    {
        let seen = env.upstream.seen.lock().unwrap();
        let headers = seen.headers.as_ref().unwrap();
        assert_eq!(headers["authorization"], format!("Bearer {KEY}"));
        assert_eq!(headers["openai-beta"], "responses=2025-01-01");
        assert!(!headers.contains_key("x-test-scenario"));
        let request = seen.body.as_ref().unwrap();
        assert_eq!(request["previous_response_id"], "resp_old");
        assert_eq!(request["store"], true);
        assert_eq!(request["include"], json!(["reasoning.encrypted_content"]));
    }
    let u = env.usage().await;
    // 计费输入 = input_tokens(20) - cached_tokens(5) = 15；输出 8；缓存读 5
    assert_eq!((u.tokens.input, u.tokens.output, u.tokens.cache_read), (15, 8, 5));
    assert!(u.usage_final);
    // 15×1 + 8×2 + 5×0.1 = 15 + 16 + 0.5 = 31.5，整体向上取整为 32
    assert_eq!(u.cost_milli, 32);
    assert_eq!(env.ledger().0, 32);
}

#[tokio::test]
async fn native_stream_passthrough_and_usage() {
    let mut env = env_with("openai_responses").await;
    let resp = env.req("native_stream", true, user_input("hi")).send().await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let evs = events(resp).await;
    let names: Vec<&str> = evs.iter().map(|(e, _)| e.as_deref().unwrap()).collect();
    assert_eq!(names, ["response.created", "response.output_text.delta", "response.completed"]);
    // 正文（包括字段形状）原样转发，不是 Edge 重新生成的
    assert_eq!(evs[0].1["response"]["id"], "resp_up_2");
    let u = env.usage().await;
    assert_eq!((u.tokens.input, u.tokens.output), (20, 8));
    assert!(u.usage_final);
}

#[tokio::test]
async fn anthropic_upstream_is_model_not_allowed() {
    let env = env_with("anthropic").await;
    let resp = env.req("native", false, user_input("hi")).send().await.unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["error"]["code"], "model_not_allowed");
    assert_eq!(env.calls(), 0);
}

#[tokio::test]
async fn unknown_protocol_is_rejected_before_headers() {
    let env = env_with("some_future_protocol").await;
    let resp = env.req("native", false, user_input("hi")).send().await.unwrap();
    assert!(!resp.status().is_success());
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["error"]["type"], "permission_error");
    assert!(body["error"]["code"].is_string());
}

#[tokio::test]
async fn bad_local_token_is_rejected_before_headers() {
    let env = env_with("openai_responses").await;
    let resp = env
        .http
        .post(&env.url)
        .header("authorization", "Bearer wrong-token")
        .json(&json!({"model": "codex-model", "input": "hi"}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["error"]["code"], "unauthenticated");
    assert_eq!(env.calls(), 0);
}

#[tokio::test]
async fn chat_backed_non_stream_translates_request_and_response() {
    let mut env = env_with("openai_chat").await;
    let resp = env.req("chat", false, user_input("hi")).send().await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["status"], "completed");
    assert_eq!(body["output"][0]["content"][0]["text"], "hi there");
    // Edge 把 Responses 的 input 转成了 Chat 的 messages
    let sent = env.upstream.seen.lock().unwrap().body.clone().unwrap();
    // messages[0] 是测试用来传场景名的 instructions；真正的对话从 input 转换而来，紧跟其后。
    assert_eq!(sent["messages"][1], json!({"role": "user", "content": "hi"}));
    let u = env.usage().await;
    assert_eq!((u.tokens.input, u.tokens.output), (10, 5));
    assert!(u.usage_final);
}

#[tokio::test]
async fn chat_backed_stream_text() {
    let mut env = env_with("openai_chat").await;
    let resp = env.req("chat_stream", true, user_input("hi")).send().await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let evs = events(resp).await;
    let names: Vec<&str> = evs.iter().map(|(e, _)| e.as_deref().unwrap()).collect();
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
    let text: String = evs
        .iter()
        .filter(|(e, _)| e.as_deref() == Some("response.output_text.delta"))
        .map(|(_, v)| v["delta"].as_str().unwrap())
        .collect();
    assert_eq!(text, "Hi there");
    let terminal = &evs.last().unwrap().1;
    assert_eq!(terminal["response"]["usage"]["input_tokens"], 10);
    let u = env.usage().await;
    assert_eq!((u.tokens.input, u.tokens.output), (10, 5));
    assert!(u.usage_final);
}

#[tokio::test]
async fn chat_backed_stream_tool_call() {
    let env = env_with("openai_chat").await;
    let resp = env.req("chat_stream_tool", true, user_input("look up SZ")).send().await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let evs = events(resp).await;
    let added = evs.iter().find(|(e, _)| e.as_deref() == Some("response.output_item.added")).unwrap();
    assert_eq!(added.1["item"]["call_id"], "call_1");
    assert_eq!(added.1["item"]["name"], "lookup");
    let done = evs.iter().find(|(e, _)| e.as_deref() == Some("response.function_call_arguments.done")).unwrap();
    assert_eq!(done.1["arguments"], "{\"city\":\"SZ\"}");
    let terminal = &evs.last().unwrap().1;
    assert_eq!(terminal["response"]["output"][0]["type"], "function_call");
}

#[tokio::test]
async fn chat_backed_error_before_headers_uses_responses_error_body() {
    let env = env_with("openai_chat").await;
    let resp = env.req("chat_error", false, user_input("hi")).send().await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    let body: Value = resp.json().await.unwrap();
    assert!(body["error"]["message"].as_str().unwrap().starts_with("prompt is too long"));
    assert_eq!(body["error"]["code"], "upstream_error");
}

/// 已经发了响应头之后（流已经开始）上游中途报错：写 `response.failed` 事件，不是裸 JSON 错误体。
#[tokio::test]
async fn chat_backed_stream_error_after_headers_is_response_failed_event() {
    let env = env_with("openai_chat").await;
    let resp = env.req("chat_stream_error", true, user_input("hi")).send().await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let evs = events(resp).await;
    let last = evs.last().unwrap();
    assert_eq!(last.0.as_deref(), Some("response.failed"));
    assert!(last.1["response"]["error"]["message"].as_str().unwrap().contains("overloaded"));
}

#[tokio::test]
async fn previous_response_id_is_rejected_for_chat_translation() {
    let env = env_with("openai_chat").await;
    let resp = env
        .http
        .post(&env.url)
        .header("authorization", format!("Bearer {LOCAL}"))
        .json(&json!({"model": "codex-model", "input": "hi", "previous_response_id": "resp_old"}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(env.calls(), 0);
}

#[tokio::test]
async fn budget_exhausted_rejects_before_upstream() {
    let env = env_with("openai_responses").await;
    // Zero remaining budget cannot cover even one output token.
    env.state
        .lease
        .grant(&Lease {
            id: "m_lse_2".into(),
            re: None,
            lease_id: "lse_2".into(),
            expires_at: format_ms(now_ms() + 600_000),
            budget_milli: 0,
            seq: 2,
        })
        .unwrap();
    let resp = env.req("native", false, user_input("hi")).send().await.unwrap();
    assert_eq!(resp.status(), StatusCode::PAYMENT_REQUIRED);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["error"]["code"], "balance_exhausted");
    assert_eq!(env.calls(), 0);
}

#[tokio::test]
async fn both_streaming_paths_stop_before_terminal_usage_and_charge_observed_output() {
    for (protocol, scenario) in [("openai_responses", "native_budget"), ("openai_chat", "chat_budget")] {
        let mut env = env_with(protocol).await;
        grant(&env.state, "lse_small", 2, 100, 600_000);
        let response = env.req(scenario, true, user_input("hi")).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{protocol}");
        let events = timeout(T, events(response)).await.expect("stream should stop without upstream EOF");
        assert_eq!(events.last().unwrap().1["response"]["error"]["code"], "balance_exhausted", "{protocol}");
        assert!(events.iter().all(|(name, _)| name.as_deref() != Some("response.completed")));
        let usage = env.usage().await;
        assert!(!usage.usage_final);
        assert!(usage.tokens.input > 0 && usage.tokens.output >= 100);
        assert!(usage.cost_milli > 100);
        assert_eq!(env.ledger(), (usage.cost_milli, 0));
    }
}

#[tokio::test]
async fn managed_codex_forces_stateless_native_requests() {
    let mut env = env_with("openai_responses").await;
    env.state.launch_tokens.write().unwrap().insert(
        "managed-token".into(),
        onexd::state::LaunchBinding { session_id: "managed-session".into(), agent: "codex".into() },
    );
    let response = env
        .http
        .post(&env.url)
        .bearer_auth("managed-token")
        .json(&json!({
            "model":"codex-model","instructions":"scenario:native","input":"hi","store":true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    response.bytes().await.unwrap();
    assert_eq!(env.upstream.seen.lock().unwrap().body.as_ref().unwrap()["store"], false);
    assert_eq!(env.usage().await.session_id.as_deref(), Some("managed-session"));
}
