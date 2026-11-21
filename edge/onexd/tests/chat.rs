//! S1-E1b：Anthropic Messages → OpenAI Chat 上游，用例按 `docs/specs/magpie/anthropic-to-chat-test-cases.md` 编号。
//!
//! 假 Chat 上游按请求头 `x-test-scenario` 回放固定的 SSE 帧，记下收到的请求。
//! 带 `gate` 的帧会等测试放行才发，用来验证“先发的片段已经到达客户端”。

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use futures_util::StreamExt;
use onex_core::ws::{Lease, Rate, Route, UpstreamAuth};
use onexd::outbox::now_ms;
use onexd::pricing::format_ms;
use onexd::router::{Outcome, Router, Tokens, UsageRecord};
use onexd::state::{ConfigSnapshot, State};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::{Notify, mpsc, oneshot};
use tokio::time::{sleep, timeout};

const T: Duration = Duration::from_secs(5);
const LOCAL: &str = "local-token";
const KEY: &str = "sk-chat-secret";

// ---- 夹具记号，对应用例文档的「夹具约定」 ----

fn c(i: Value, d: Value, r: Value) -> String {
    let mut ch = json!({"delta": d, "finish_reason": r});
    if !i.is_null() {
        ch["index"] = i;
    }
    format!("data: {}\n\n", json!({"id":"chatcmpl-1","model":"wire-m","choices":[ch]}))
}
fn t(i: u64, s: &str) -> String {
    c(json!(i), json!({"content": s}), Value::Null)
}
fn r(reason: &str) -> String {
    c(json!(0), json!({}), json!(reason))
}
fn u(p: u64, cmp: u64, extra: Value) -> String {
    let mut usage = json!({"prompt_tokens": p, "completion_tokens": cmp});
    if let Value::Object(m) = extra {
        usage.as_object_mut().unwrap().extend(m);
    }
    format!("data: {}\n\n", json!({"id":"chatcmpl-1","choices":[],"usage":usage}))
}
fn f(i: u64, id: &str, name: &str, args: &str) -> String {
    calls(json!([{"index":i,"id":id,"type":"function","function":{"name":name,"arguments":args}}]))
}
fn p(i: u64, args: &str, id: Option<&str>) -> String {
    let mut x = json!({"index":i,"function":{"arguments":args}});
    if let Some(id) = id {
        x["id"] = id.into();
    }
    calls(json!([x]))
}
fn calls(v: Value) -> String {
    c(json!(0), json!({"tool_calls": v}), Value::Null)
}
const D: &str = "data: [DONE]\n\n";

enum Frame {
    Data(String),
    /// 等测试放行
    Gate,
    /// 发完之前的帧后断开连接
    Cut,
    /// 发完之后不关连接，直到被取消
    Hold,
}
use Frame::*;

fn d(s: impl Into<String>) -> Frame {
    Data(s.into())
}

fn script(scenario: &str) -> Result<Vec<Frame>, (u16, Value)> {
    Ok(match scenario {
        "ac01" => vec![
            d(c(json!(0), json!({"role":"assistant"}), Value::Null)),
            d(t(0, "Hi ")),
            d(t(0, "there")),
            d(r("stop")),
            Gate,
            d(u(10, 5, json!({}))),
            d(D),
        ],
        "ac02" => vec![
            d(format!(
                "data: {}\n\n",
                json!({"id":"chatcmpl-1","choices":[{"index":"1","delta":{"content":"Hel"}},
                    {"index":0,"delta":{"content":"wrong"},"finish_reason":"tool_calls"}]})
            )),
            d(c(json!(1), json!({"content":"lo"}), json!("stop"))),
            d(u(7, 2, json!({}))),
            d(D),
        ],
        "ac03" => vec![
            d(u(7, 0, json!({}))),
            d(c(Value::Null, json!({"role":"assistant"}), Value::Null)),
            d(t(1, "Hel")),
            d(t(0, "wrong")),
            d(c(Value::Null, json!({"content":"lo"}), Value::Null)),
            d(c(json!(1), json!({}), json!("stop"))),
            d(u(7, 2, json!({}))),
            d(D),
        ],
        "ac04" => vec![
            d(f(0, "call_1", "lookup", "")),
            d(p(0, "{\"city\":", Some("call_1"))),
            Gate,
            d(p(0, "\"SZ\"}", Some("call_1"))),
            d(r("tool_calls")),
            d(u(10, 5, json!({}))),
            d(D),
        ],
        "ac05" => vec![
            d(f(0, "call_a", "lookup", "{\"ci")),
            d(f(1, "call_b", "stock", "{\"sk")),
            d(p(0, "ty\":\"SZ\"}", None)),
            d(p(1, "u\":\"p1\"}", None)),
            d(r("tool_calls")),
            d(u(10, 8, json!({}))),
            d(D),
        ],
        "ac06" => vec![d(t(0, "Shenzhen: in stock")), d(r("stop")), d(u(20, 4, json!({}))), d(D)],
        "ac07a" => {
            vec![d(f(0, "tool:1#x", "lookup", "{\"city\":\"SZ\"}")), d(r("tool_calls")), d(u(5, 5, json!({}))), d(D)]
        }
        "ac07b" => vec![d(t(0, "OK")), d(r("stop")), d(u(12, 2, json!({}))), d(D)],
        "ac08" => {
            vec![d(t(0, "Half an answer")), d(c(json!(0), json!({}), json!("length"))), d(u(10, 8, json!({}))), d(D)]
        }
        "ac09" => vec![
            d(t(0, "partial")),
            Gate,
            d(c(json!(0), json!({}), json!("content_filter"))),
            d(u(10, 2, json!({}))),
            d(D),
        ],
        "ac10" => vec![
            d(t(0, "OK")),
            d(r("stop")),
            d(u(
                1000,
                120,
                json!({"prompt_tokens_details":{"cached_tokens":700,"cache_write_tokens":100},
                    "completion_tokens_details":{"reasoning_tokens":100}}),
            )),
            d(D),
        ],
        "ac11" => vec![d(t(0, "OK")), d(r("stop")), d(u(9, 4, json!({}))), d(D), Hold],
        "ac12" => vec![d(t(0, "OK")), d(r("stop")), d(D)],
        "ac12b" => vec![d(u(7, 0, json!({}))), d(t(0, "OK")), d(r("stop")), d(D)],
        "ac13" => vec![d(t(0, "hel")), Gate, d("data: {\"id\":\"chatcmpl-1\",\"cho"), Cut],
        "ac13b" => vec![d(t(0, "hel"))],
        "ac14" => vec![
            d(t(0, "partial")),
            Gate,
            d("data: {\"error\":{\"type\":\"upstream_error\",\"message\":\"fixture upstream failure\"}}\n\n"),
            d(D),
        ],
        "ac14b" => vec![d(t(0, "partial")), d("data: {\"error\":\"fixture upstream failure\"}\n\n"), d(D)],
        "ac15" => {
            return Err((
                400,
                json!({"error":{"code":"context_length_exceeded","message":"Input exceeds the context limit"}}),
            ));
        }
        "ac16" => vec![d(t(0, "你好")), d(": keepalive\n\n"), d(r("stop")), d(u(4, 2, json!({}))), d(D)],
        "ac18" => vec![d(t(0, "OK")), d(r("stop")), d(u(3, 1, json!({}))), d(D)],
        _ => vec![d(t(0, "?")), d(r("stop")), d(u(1, 1, json!({}))), d(D)],
    })
}

/// AC-16 变体：CRLF 行尾、合法 JSON 拆成两行 data:、在字节层切开 CRLF 和“好”。
/// String 装不下半个 UTF-8 字符，所以按字节直接发。
fn ac16b_bytes() -> (Vec<u8>, Vec<usize>) {
    let delta =
        json!({"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}).to_string();
    let cut = delta.find(",\"choices\"").unwrap() + 1;
    let ev = format!("data: {}\r\ndata: {}\r\n\r\n", &delta[..cut], &delta[cut..]);
    let all = ev + ": keepalive\r\n\r\n" + &r("stop").replace('\n', "\r\n") + &u(4, 2, json!({})) + D;
    let hao = all.find('好').unwrap() + 1;
    let crlf = all.find("\r\n").unwrap() + 1;
    let mut cuts = vec![0, crlf, hao, all.len()];
    cuts.sort();
    (all.into_bytes(), cuts)
}

#[derive(Default)]
struct Seen {
    requests: Vec<(String, HeaderMap, Value)>,
}

struct Upstream {
    addr: SocketAddr,
    seen: Arc<Mutex<Seen>>,
    gate: Arc<Notify>,
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

impl Upstream {
    async fn start() -> Self {
        let seen = Arc::new(Mutex::new(Seen::default()));
        let gate = Arc::new(Notify::new());
        let dropped: Arc<Mutex<Option<oneshot::Sender<()>>>> = Arc::default();
        let (s, g, dr) = (seen.clone(), gate.clone(), dropped.clone());
        let app = axum::Router::new().route(
            "/v1/chat/completions",
            post(move |uri: axum::http::Uri, headers: HeaderMap, body: Bytes| {
                let (s, g, dr) = (s.clone(), g.clone(), dr.clone());
                async move {
                    let body: Value = serde_json::from_slice(&body).unwrap();
                    // Chat 上游收不到客户端的请求头，场景名放在 stop 列表里带过来
                    let scenario = body["stop"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .find_map(|s| s.strip_prefix("scenario:"))
                        .unwrap_or("")
                        .to_string();
                    let stream = body["stream"].as_bool().unwrap_or(false);
                    s.lock().unwrap().requests.push((uri.to_string(), headers, body));
                    let guard = DropSignal(dr.lock().unwrap().take());
                    respond(&scenario, stream, g, guard)
                }
            }),
        );
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        Self { addr, seen, gate, dropped }
    }

    fn on_drop(&self) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        *self.dropped.lock().unwrap() = Some(tx);
        rx
    }

    fn last(&self) -> (String, HeaderMap, Value) {
        self.seen.lock().unwrap().requests.last().cloned().unwrap()
    }
}

fn respond(scenario: &str, stream: bool, gate: Arc<Notify>, guard: DropSignal) -> Response {
    if scenario == "ac16b" {
        let (b, cuts) = ac16b_bytes();
        let chunks: Vec<Result<Bytes, std::io::Error>> =
            cuts.windows(2).map(|w| Ok(Bytes::copy_from_slice(&b[w[0]..w[1]]))).collect();
        return sse(futures_util::stream::iter(chunks).boxed());
    }
    let frames = match script(scenario) {
        Ok(f) => f,
        Err((status, body)) => {
            return (StatusCode::from_u16(status).unwrap(), axum::Json(body)).into_response();
        }
    };
    if !stream {
        return non_stream(scenario).into_response();
    }
    let s = futures_util::stream::iter(frames)
        .then(move |fr| {
            let gate = gate.clone();
            async move {
                match fr {
                    Data(s) => Some(Ok(Bytes::from(s))),
                    Gate => {
                        gate.notified().await;
                        None
                    }
                    Cut => {
                        sleep(Duration::from_millis(30)).await;
                        Some(Err(std::io::Error::other("cut")))
                    }
                    Hold => {
                        futures_util::future::pending::<()>().await;
                        None
                    }
                }
            }
        })
        .filter_map(futures_util::future::ready)
        .map(move |x| {
            let _g = &guard;
            x
        });
    sse(s.boxed())
}

/// 非流式请求：ac18 回整包 JSON；ac13b 模拟中途断开。
fn non_stream(scenario: &str) -> Response {
    match scenario {
        "ac18" => axum::Json(json!({"id":"chatcmpl-1","object":"chat.completion","model":"wire-m",
            "choices":[{"index":0,"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}],
            "usage":{"prompt_tokens":3,"completion_tokens":1}}))
        .into_response(),
        _ => Response::builder()
            .header("content-type", "application/json")
            .body(Body::from_stream(futures_util::stream::iter([
                Ok(Bytes::from_static(b"{\"id\":\"chatcmpl-1\",\"cho")),
                Err(std::io::Error::other("cut")),
            ])))
            .unwrap(),
    }
}

fn sse(s: futures_util::stream::BoxStream<'static, Result<Bytes, std::io::Error>>) -> Response {
    Response::builder().header("content-type", "text/event-stream").body(Body::from_stream(s)).unwrap()
}

struct Env {
    url: String,
    up: Upstream,
    usage: mpsc::UnboundedReceiver<UsageRecord>,
    state: Arc<State>,
    http: reqwest::Client,
}

fn direct() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

async fn env_with_base(base: impl FnOnce(SocketAddr) -> String) -> Env {
    let up = Upstream::start().await;
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
            model: "local-m".into(),
            model_id: "mdl_q".into(),
            provider_id: "prv_q".into(),
            protocol: "openai_chat".into(),
            base_url: base(up.addr),
            upstream_model: Some("wire-m".into()),
            auth: UpstreamAuth::Bearer,
            proxy: None,
        }],
        rates: vec![Rate {
            model_id: "mdl_q".into(),
            input_milli_per_mtok: 1_000_000,
            output_milli_per_mtok: 2_000_000,
            cache_read_milli_per_mtok: 100_000,
            cache_write_milli_per_mtok: 1_000_000,
            effective_from: None,
        }],
    };
    state.secrets.write().unwrap().insert("prv_q".into(), KEY.into());
    state
        .lease
        .grant(&Lease {
            model_budgets: Default::default(),
            commerce_plan_id: None,
            id: "m".into(),
            re: None,
            lease_id: "lse_1".into(),
            expires_at: format_ms(now_ms() + 600_000),
            budget_milli: 10_000_000,
            seq: 1,
        })
        .unwrap();
    let (tx, usage) = mpsc::unbounded_channel();
    let app = Router::new(state.clone(), LOCAL.into(), direct(), tx).app();
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/messages", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    Env { url, up, usage, state, http: direct() }
}

async fn env() -> Env {
    env_with_base(|a| format!("http://{a}/v1")).await
}

/// 默认入口 `A`
fn a() -> Value {
    json!({"model":"local-m","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"hello"}]})
}

fn tool(name: &str, k: &str) -> Value {
    json!({"name":name,"input_schema":{"type":"object","properties":{k:{"type":"string"}}}})
}

impl Env {
    fn post(&self, scenario: &str, body: &Value) -> reqwest::RequestBuilder {
        let mut body = body.clone();
        let mut stop = body["stop_sequences"].as_array().cloned().unwrap_or_default();
        stop.push(format!("scenario:{scenario}").into());
        body["stop_sequences"] = stop.into();
        self.http
            .post(format!("{}?beta=true", self.url))
            .header("x-api-key", LOCAL)
            .header("anthropic-version", "2023-06-01")
            .header("anthropic-beta", "prompt-caching-2024-07-31")
            .json(&body)
    }

    async fn run(&self, scenario: &str, body: &Value) -> Vec<(String, Value)> {
        let r = self.post(scenario, body).send().await.unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers()["content-type"], "text/event-stream");
        parse_sse(&r.text().await.unwrap())
    }

    async fn usage(&mut self) -> UsageRecord {
        timeout(T, self.usage.recv()).await.expect("no usage record").unwrap()
    }
}

fn parse_sse(text: &str) -> Vec<(String, Value)> {
    text.split("\n\n")
        .filter(|b| !b.trim().is_empty() && !b.starts_with(':'))
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
            (ev, serde_json::from_str(&data).unwrap_or(Value::Null))
        })
        .collect()
}

/// 把事件序列压成用例文档的记号，便于整体比较。
fn shape(evs: &[(String, Value)]) -> Vec<String> {
    evs.iter()
        .map(|(n, v)| match n.as_str() {
            "message_start" => "S".into(),
            "content_block_start" => {
                let b = &v["content_block"];
                match b["type"].as_str().unwrap() {
                    "text" => format!("B{}(text)", v["index"]),
                    "tool_use" => {
                        format!("B{}(tool,{},{})", v["index"], b["id"].as_str().unwrap(), b["name"].as_str().unwrap())
                    }
                    o => format!("B{}({o})", v["index"]),
                }
            }
            "content_block_delta" => {
                let d = &v["delta"];
                match d["type"].as_str().unwrap() {
                    "text_delta" => format!("X{}({})", v["index"], d["text"].as_str().unwrap()),
                    "input_json_delta" => format!("J{}({})", v["index"], d["partial_json"].as_str().unwrap()),
                    o => format!("?{o}"),
                }
            }
            "content_block_stop" => format!("E{}", v["index"]),
            "message_delta" => format!(
                "M({};{},{})",
                v["delta"]["stop_reason"].as_str().unwrap(),
                v["usage"]["input_tokens"],
                v["usage"]["output_tokens"]
            ),
            "message_stop" => "Z".into(),
            "error" => format!("ERR({})", v["error"]["type"].as_str().unwrap()),
            o => o.into(),
        })
        .collect()
}

/// 同一块的参数片段拼起来
fn tool_args(evs: &[(String, Value)], index: u64) -> Value {
    let s: String = evs
        .iter()
        .filter(|(n, v)| n == "content_block_delta" && v["index"] == index)
        .map(|(_, v)| v["delta"]["partial_json"].as_str().unwrap().to_string())
        .collect();
    serde_json::from_str(&s).unwrap()
}

fn assert_success_invariants(evs: &[(String, Value)]) {
    let n = |k: &str| evs.iter().filter(|(e, _)| e == k).count();
    assert_eq!((n("message_start"), n("message_delta"), n("message_stop")), (1, 1, 1));
    assert_eq!(evs.last().unwrap().0, "message_stop");
    let s = &evs[0].1["message"];
    assert_eq!((s["type"].as_str(), s["role"].as_str()), (Some("message"), Some("assistant")));
    assert!(s["id"].as_str().unwrap().starts_with("msg_"));
    assert_eq!(s["model"], "local-m");
    // 块索引从 0 递增，关闭后不复用
    let starts: Vec<u64> =
        evs.iter().filter(|(e, _)| e == "content_block_start").map(|(_, v)| v["index"].as_u64().unwrap()).collect();
    assert_eq!(starts, (0..starts.len() as u64).collect::<Vec<_>>());
    assert!(!evs.iter().any(|(_, v)| v.to_string().contains("[DONE]")));
}

#[tokio::test]
async fn ac01_text_and_trailing_usage() {
    let mut e = env().await;
    let mut body = a();
    body["system"] = "be brief".into();
    body["stop_sequences"] = json!(["END"]);
    let r = e.post("ac01", &body).send().await.unwrap();
    let mut stream = r.bytes_stream();
    // 尾帧还没放行时就能先收到文本
    let mut got = String::new();
    while !got.contains("there") {
        let c = timeout(T, stream.next()).await.expect("text did not arrive before trailing usage").unwrap().unwrap();
        got.push_str(&String::from_utf8_lossy(&c));
    }
    assert!(!got.contains("message_stop"), "must wait for trailing usage");
    e.up.gate.notify_one();
    while let Some(c) = timeout(T, stream.next()).await.unwrap() {
        got.push_str(&String::from_utf8_lossy(&c.unwrap()));
    }
    let evs = parse_sse(&got);
    assert_eq!(shape(&evs), ["S", "B0(text)", "X0(Hi )", "X0(there)", "E0", "M(end_turn;10,5)", "Z"]);
    assert_success_invariants(&evs);

    let (uri, h, req) = e.up.last();
    assert_eq!(uri, "/v1/chat/completions");
    assert_eq!(h["authorization"], format!("Bearer {KEY}"));
    assert!(h.get("x-api-key").is_none() && h.get("anthropic-version").is_none() && h.get("anthropic-beta").is_none());
    assert!(!format!("{h:?}").contains(LOCAL));
    assert_eq!(
        req,
        json!({"model":"wire-m","messages":[{"role":"system","content":"be brief"},{"role":"user","content":"hello"}],
            "max_tokens":64,"stop":["END","scenario:ac01"],"stream":true,"stream_options":{"include_usage":true}})
    );

    let u = e.usage().await;
    assert_eq!(u.outcome, Outcome::Ok);
    assert!(u.usage_final);
    assert_eq!(u.tokens, Tokens { input: 10, output: 5, ..Default::default() });
    assert_eq!(u.cost_milli, 10 + 10);
    assert_eq!((u.upstream_model.as_str(), u.model.as_str()), ("wire-m", "local-m"));
    assert!(timeout(Duration::from_millis(50), e.usage.recv()).await.is_err(), "only one settlement");
}

#[tokio::test]
async fn ac02_multiple_choices_are_isolated() {
    let e = env().await;
    let evs = e.run("ac02", &a()).await;
    assert_eq!(shape(&evs), ["S", "B0(text)", "X0(Hel)", "X0(lo)", "E0", "M(end_turn;7,2)", "Z"]);
}

#[tokio::test]
async fn ac03_leading_usage_does_not_pick_choice() {
    let e = env().await;
    let evs = e.run("ac03", &a()).await;
    assert_eq!(evs[0].1["message"]["usage"]["input_tokens"], 7);
    assert_eq!(shape(&evs), ["S", "B0(text)", "X0(Hel)", "X0(lo)", "E0", "M(end_turn;7,2)", "Z"]);
}

#[tokio::test]
async fn ac04_single_tool_with_repeated_id() {
    let e = env().await;
    let mut body = a();
    body["tools"] = json!([tool("lookup", "city")]);
    body["tool_choice"] = json!({"type":"tool","name":"lookup","disable_parallel_tool_use":true});
    let r = e.post("ac04", &body).send().await.unwrap();
    let mut stream = r.bytes_stream();
    let mut got = String::new();
    while !got.contains("{\\\"city\\\":") {
        let c =
            timeout(T, stream.next()).await.expect("first fragment must stream before the second").unwrap().unwrap();
        got.push_str(&String::from_utf8_lossy(&c));
    }
    e.up.gate.notify_one();
    while let Some(c) = timeout(T, stream.next()).await.unwrap() {
        got.push_str(&String::from_utf8_lossy(&c.unwrap()));
    }
    let evs = parse_sse(&got);
    assert_eq!(
        shape(&evs),
        ["S", "B0(tool,call_1,lookup)", "J0({\"city\":)", "J0(\"SZ\"})", "E0", "M(tool_use;10,5)", "Z"]
    );
    assert_eq!(tool_args(&evs, 0), json!({"city":"SZ"}));

    let req = e.up.last().2;
    assert_eq!(
        req["tools"],
        json!([{"type":"function","function":{"name":"lookup","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}])
    );
    assert_eq!(req["tool_choice"], json!({"type":"function","function":{"name":"lookup"}}));
    assert_eq!(req["parallel_tool_calls"], false);
}

#[tokio::test]
async fn ac05_interleaved_parallel_tools() {
    let e = env().await;
    let mut body = a();
    body["tools"] = json!([tool("lookup", "city"), tool("stock", "sku")]);
    let evs = e.run("ac05", &body).await;
    let s = shape(&evs);
    assert_eq!(s[0..2], ["S", "B0(tool,call_a,lookup)"]);
    let b1 = s.iter().position(|x| x == "B1(tool,call_b,stock)").unwrap();
    assert_eq!(s[b1 - 1], "E0");
    assert_eq!(s[s.len() - 3..], ["E1", "M(tool_use;10,8)", "Z"]);
    assert_eq!(tool_args(&evs, 0), json!({"city":"SZ"}));
    assert_eq!(tool_args(&evs, 1), json!({"sku":"p1"}));
    assert_success_invariants(&evs);
}

#[tokio::test]
async fn ac06_tool_results_pair_by_id() {
    let e = env().await;
    let mut body = a();
    body["tools"] = json!([tool("lookup", "city"), tool("stock", "sku")]);
    body["messages"] = json!([
        {"role":"user","content":"hello"},
        {"role":"assistant","content":[
            {"type":"tool_use","id":"call_a","name":"lookup","input":{"city":"SZ"}},
            {"type":"tool_use","id":"call_b","name":"stock","input":{"sku":"p1"}}]},
        {"role":"user","content":[
            {"type":"tool_result","tool_use_id":"call_b","content":"in stock"},
            {"type":"text","text":"summarize"},
            {"type":"tool_result","tool_use_id":"call_a","content":[{"type":"text","text":"Shenzhen"}]}]}
    ]);
    let evs = e.run("ac06", &body).await;
    assert_eq!(shape(&evs), ["S", "B0(text)", "X0(Shenzhen: in stock)", "E0", "M(end_turn;20,4)", "Z"]);
    let m = &e.up.last().2["messages"];
    assert_eq!(m[0], json!({"role":"user","content":"hello"}));
    assert_eq!(m[1]["role"], "assistant");
    assert_eq!(m[1]["content"], Value::Null);
    let tc = m[1]["tool_calls"].as_array().unwrap();
    assert_eq!(tc[0]["id"], "call_a");
    assert_eq!(
        serde_json::from_str::<Value>(tc[0]["function"]["arguments"].as_str().unwrap()).unwrap(),
        json!({"city":"SZ"})
    );
    assert_eq!(tc[1]["id"], "call_b");
    assert_eq!(m[2], json!({"role":"tool","tool_call_id":"call_a","content":"Shenzhen"}));
    assert_eq!(m[3], json!({"role":"tool","tool_call_id":"call_b","content":"in stock"}));
    assert_eq!(m[4], json!({"role":"user","content":"summarize"}));
    assert_eq!(m.as_array().unwrap().len(), 5);
}

#[tokio::test]
async fn ac07_unsafe_tool_id_roundtrip() {
    let e = env().await;
    let mut body = a();
    body["tools"] = json!([tool("lookup", "city")]);
    let evs = e.run("ac07a", &body).await;
    let id = evs[1].1["content_block"]["id"].as_str().unwrap().to_string();
    assert!(id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'), "{id}");
    assert_eq!(shape(&evs)[shape(&evs).len() - 2], "M(tool_use;5,5)");
    assert_eq!(tool_args(&evs, 0), json!({"city":"SZ"}));

    body["messages"] = json!([
        {"role":"user","content":"hello"},
        {"role":"assistant","content":[{"type":"tool_use","id":id,"name":"lookup","input":{"city":"SZ"}}]},
        {"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":"ok"}]}
    ]);
    let evs = e.run("ac07b", &body).await;
    assert_eq!(shape(&evs), ["S", "B0(text)", "X0(OK)", "E0", "M(end_turn;12,2)", "Z"]);
    let m = &e.up.last().2["messages"];
    assert_eq!(m[1]["tool_calls"][0]["id"], "tool:1#x");
    assert_eq!(m[2]["tool_call_id"], "tool:1#x");
}

#[tokio::test]
async fn ac08_length_is_max_tokens() {
    let e = env().await;
    let mut body = a();
    body["max_tokens"] = 8.into();
    let evs = e.run("ac08", &body).await;
    assert_eq!(shape(&evs), ["S", "B0(text)", "X0(Half an answer)", "E0", "M(max_tokens;10,8)", "Z"]);
    assert_eq!(e.up.seen.lock().unwrap().requests.len(), 1);
}

#[tokio::test]
async fn ac09_content_filter_after_text_is_refusal() {
    let e = env().await;
    let r = e.post("ac09", &a()).send().await.unwrap();
    let mut stream = r.bytes_stream();
    let mut got = String::new();
    while !got.contains("partial") {
        got.push_str(&String::from_utf8_lossy(&timeout(T, stream.next()).await.unwrap().unwrap().unwrap()));
    }
    e.up.gate.notify_one();
    while let Some(c) = timeout(T, stream.next()).await.unwrap() {
        got.push_str(&String::from_utf8_lossy(&c.unwrap()));
    }
    assert_eq!(shape(&parse_sse(&got)), ["S", "B0(text)", "X0(partial)", "E0", "M(refusal;10,2)", "Z"]);
}

#[tokio::test]
async fn ac10_cache_and_reasoning_usage() {
    let mut e = env().await;
    let evs = e.run("ac10", &a()).await;
    assert_eq!(shape(&evs), ["S", "B0(text)", "X0(OK)", "E0", "M(end_turn;200,120)", "Z"]);
    let mu = &evs[4].1["usage"];
    assert_eq!(mu["cache_read_input_tokens"], 700);
    assert_eq!(mu["cache_creation_input_tokens"], 100);
    assert_eq!(mu["output_tokens_details"]["thinking_tokens"], 100);
    assert!(!evs.iter().any(|(_, v)| v["content_block"]["type"] == "thinking"));
    let u = e.usage().await;
    assert_eq!(u.tokens, Tokens { input: 200, output: 120, cache_read: 700, cache_write: 100 });
    // 200×1 + 120×2 + 700×0.1 + 100×1
    assert_eq!(u.cost_milli, 200 + 240 + 70 + 100);
}

#[tokio::test]
async fn ac11_done_without_upstream_close() {
    let mut e = env().await;
    let dropped = e.up.on_drop();
    let evs = timeout(T, e.run("ac11", &a())).await.expect("response must end at [DONE]");
    assert_eq!(shape(&evs), ["S", "B0(text)", "X0(OK)", "E0", "M(end_turn;9,4)", "Z"]);
    timeout(T, dropped).await.expect("upstream not closed after [DONE]").unwrap();
    assert_eq!(e.usage().await.outcome, Outcome::Ok);
}

#[tokio::test]
async fn ac12_missing_trailing_usage_is_pending() {
    let mut e = env().await;
    for sc in ["ac12", "ac12b"] {
        let evs = e.run(sc, &a()).await;
        let s = shape(&evs);
        assert_eq!(s[..4], ["S", "B0(text)", "X0(OK)", "E0"]);
        assert!(s[4].starts_with("M(end_turn;"), "{s:?}");
        assert_eq!(s[5], "Z");
        let u = e.usage().await;
        assert_eq!(u.outcome, Outcome::Ok);
        assert!(!u.usage_final, "{sc}: complete must be false");
        assert_eq!(u.to_item()["complete"], false);
    }
}

#[tokio::test]
async fn ac13_cut_mid_stream() {
    let mut e = env().await;
    let r = e.post("ac13", &a()).send().await.unwrap();
    let mut stream = r.bytes_stream();
    let mut got = String::new();
    while !got.contains("hel") {
        got.push_str(&String::from_utf8_lossy(&timeout(T, stream.next()).await.unwrap().unwrap().unwrap()));
    }
    e.up.gate.notify_one();
    while let Some(c) = timeout(T, stream.next()).await.unwrap() {
        got.push_str(&String::from_utf8_lossy(&c.unwrap()));
    }
    assert!(!got.contains("\"cho"), "half frame leaked");
    assert_eq!(shape(&parse_sse(&got)), ["S", "B0(text)", "X0(hel)", "E0", "ERR(api_error)"]);
    let u = e.usage().await;
    assert_eq!(u.outcome, Outcome::UpstreamError);
    assert!(!u.usage_final);

    // 完整 T 后 clean EOF，没有 finish_reason 和 [DONE]：按截断处理
    let evs = e.run("ac13b", &a()).await;
    assert_eq!(shape(&evs), ["S", "B0(text)", "X0(hel)", "E0", "ERR(api_error)"]);
}

#[tokio::test]
async fn ac14_error_inside_200_stream() {
    let mut e = env().await;
    let r = e.post("ac14", &a()).send().await.unwrap();
    let mut stream = r.bytes_stream();
    let mut got = String::new();
    while !got.contains("partial") {
        got.push_str(&String::from_utf8_lossy(&timeout(T, stream.next()).await.unwrap().unwrap().unwrap()));
    }
    e.up.gate.notify_one();
    while let Some(c) = timeout(T, stream.next()).await.unwrap() {
        got.push_str(&String::from_utf8_lossy(&c.unwrap()));
    }
    let evs = parse_sse(&got);
    assert_eq!(shape(&evs), ["S", "B0(text)", "X0(partial)", "E0", "ERR(api_error)"]);
    assert!(evs[4].1["error"]["message"].as_str().unwrap().contains("fixture upstream failure"));
    assert_eq!(e.usage().await.outcome, Outcome::UpstreamError);

    let evs = e.run("ac14b", &a()).await;
    assert_eq!(shape(&evs), ["S", "B0(text)", "X0(partial)", "E0", "ERR(api_error)"]);
    assert!(evs[4].1["error"]["message"].as_str().unwrap().contains("fixture upstream failure"));
    assert_eq!(e.up.seen.lock().unwrap().requests.len(), 2, "no retry");
}

#[tokio::test]
async fn ac15_http_error_before_stream() {
    let mut e = env().await;
    let r = e.post("ac15", &a()).send().await.unwrap();
    assert_eq!(r.status(), 400);
    assert!(r.headers()["content-type"].to_str().unwrap().starts_with("application/json"));
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["type"], "error");
    assert_eq!(v["error"]["type"], "invalid_request_error");
    assert!(v["error"]["message"].as_str().unwrap().starts_with("prompt is too long: "));
    assert_eq!(e.usage().await.outcome, Outcome::UpstreamStatus(400));
}

#[tokio::test]
async fn ac16_framing_and_keepalive() {
    let e = env().await;
    for sc in ["ac16", "ac16b"] {
        let evs = e.run(sc, &a()).await;
        assert_eq!(shape(&evs), ["S", "B0(text)", "X0(你好)", "E0", "M(end_turn;4,2)", "Z"], "{sc}");
    }
}

#[tokio::test]
async fn ac18_non_streaming_client() {
    let mut e = env().await;
    let mut body = a();
    body["stream"] = false.into();
    let r = e.post("ac18", &body).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["type"], "message");
    assert_eq!(v["content"], json!([{"type":"text","text":"OK"}]));
    assert_eq!(v["stop_reason"], "end_turn");
    assert_eq!((v["usage"]["input_tokens"].as_u64(), v["usage"]["output_tokens"].as_u64()), (Some(3), Some(1)));
    assert_eq!(e.up.last().2.get("stream"), None);
    let u = e.usage().await;
    assert!(u.usage_final && u.outcome == Outcome::Ok);

    // 非流式客户端遇到断流：不返回半份成功 JSON
    let r = e.post("ac13b", &body).send().await.unwrap();
    assert_eq!(r.status(), 502);
    assert_eq!(r.json::<Value>().await.unwrap()["type"], "error");
}

// ---- 计费与路由 ----

#[tokio::test]
async fn base_url_without_v1_and_bad_request_rejected_locally() {
    let e = env_with_base(|a| format!("http://{a}")).await;
    let evs = e.run("ac06", &a()).await;
    assert_eq!(shape(&evs).last().unwrap(), "Z");
    assert_eq!(e.up.last().0, "/v1/chat/completions");

    let mut body = a();
    body["tools"] = json!([{"type":"web_search_20250305","name":"web_search"}]);
    let r = e.post("ac06", &body).send().await.unwrap();
    assert_eq!(r.status(), 400);
    assert!(r.json::<Value>().await.unwrap()["error"]["message"].as_str().unwrap().contains("web_search"));
    assert_eq!(e.up.seen.lock().unwrap().requests.len(), 1);
}

#[tokio::test]
async fn cutoff_interrupts_translated_stream() {
    let mut e = env().await;
    let dropped = e.up.on_drop();
    let r = e.post("ac13", &a()).send().await.unwrap();
    let mut stream = r.bytes_stream();
    let mut got = String::new();
    while !got.contains("hel") {
        got.push_str(&String::from_utf8_lossy(&timeout(T, stream.next()).await.unwrap().unwrap().unwrap()));
    }
    e.state.lease.cutoff("balance", None).unwrap();
    while let Some(c) = timeout(T, stream.next()).await.unwrap() {
        got.push_str(&String::from_utf8_lossy(&c.unwrap()));
    }
    let evs = parse_sse(&got);
    assert_eq!(shape(&evs), ["S", "B0(text)", "X0(hel)", "E0", "ERR(billing_error)"]);
    assert_eq!(evs[4].1["error"]["code"], "balance_exhausted");
    timeout(T, dropped).await.expect("upstream not cancelled").unwrap();
    assert_eq!(e.usage().await.to_item()["status"], "cutoff");
}
