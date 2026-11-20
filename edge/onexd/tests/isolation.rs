//! 控制连接和上游流互不影响，且 IPC status 能分辨两者（sima-lessons.md「中继」一节）。
//!
//! 同一进程里起假 Server（WS）、假上游（SSE）、router 和 IPC，分别注入：
//! - 只断控制连接：进行中的流照常完成，租约有效期内新请求照常放行；status 显示 ws 断开、上游正常。
//! - 只断上游流：控制连接保持；status 显示 ws 已连接、上游最近一次出错。
//! - 两条链路同时断开：对话失败；恢复后同一设备和会话可继续对话，未确认事件和用量按序补传。

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::response::Response;
use axum::routing::post;
use futures_util::{SinkExt, StreamExt};
use onex_core::transport;
use onex_core::ws::{Rate, Route, UpstreamAuth};
use onexd::ipc::{self, Ipc};
use onexd::outbox::{Kind, Outbox, now_ms};
use onexd::pricing::format_ms;
use onexd::router::{Router, UsageRecord};
use onexd::state::{ConfigSnapshot, Phase, State};
use onexd::ws::{self, WsOptions};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, mpsc};
use tokio::time::{sleep, timeout};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

const T: Duration = Duration::from_secs(5);
const LOCAL: &str = "local-token";

fn sse(event: &str, data: Value) -> Bytes {
    Bytes::from(format!("event: {event}\ndata: {data}\n\n"))
}

struct UpstreamListener {
    tcp: TcpListener,
    online: Arc<AtomicBool>,
}

impl axum::serve::Listener for UpstreamListener {
    type Io = TcpStream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let connection = self.tcp.accept().await.unwrap();
            if self.online.load(Ordering::SeqCst) {
                return connection;
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.tcp.local_addr()
    }
}

/// `gate`：发完 message_start 后等它放行再发剩下的；`cut`：发完 message_start 后断开。
async fn start_upstream(gate: Arc<Notify>, online: Arc<AtomicBool>) -> SocketAddr {
    let app = axum::Router::new().route(
        "/v1/messages",
        post(move |headers: axum::http::HeaderMap| {
            let gate = gate.clone();
            async move {
                let scenario = headers.get("x-test-scenario").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                let start = sse(
                    "message_start",
                    json!({"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":1}}}),
                );
                let rest = vec![
                    sse("content_block_delta", json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}})),
                    sse("message_delta", json!({"type":"message_delta","usage":{"output_tokens":5}})),
                    sse("message_stop", json!({"type":"message_stop"})),
                ];
                let first = futures_util::stream::once(async move { Ok::<_, std::io::Error>(start) });
                let tail: futures_util::stream::BoxStream<'static, Result<Bytes, std::io::Error>> = if scenario == "cut" {
                    futures_util::stream::once(async {
                        sleep(Duration::from_millis(50)).await;
                        Err(std::io::Error::other("upstream reset"))
                    })
                    .boxed()
                } else if scenario == "gated" {
                    futures_util::stream::once(async move {
                        gate.notified().await;
                    })
                    .flat_map(move |_| futures_util::stream::iter(rest.clone().into_iter().map(Ok)))
                    .boxed()
                } else {
                    futures_util::stream::iter(rest.into_iter().map(Ok)).boxed()
                };
                Response::builder()
                    .header("content-type", "text/event-stream")
                    .header("connection", "close")
                    .body(Body::from_stream(first.chain(tail)))
                    .unwrap()
            }
        }),
    );
    let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = tcp.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(UpstreamListener { tcp, online }, app).await.unwrap() });
    addr
}

struct Peer(WebSocketStream<TcpStream>);

impl Peer {
    async fn recv(&mut self) -> Value {
        loop {
            match timeout(T, self.0.next()).await.expect("recv timeout").expect("closed").unwrap() {
                Message::Text(t) => return serde_json::from_str(&t).unwrap(),
                _ => continue,
            }
        }
    }

    async fn send(&mut self, v: Value) {
        self.0.send(Message::text(v.to_string())).await.unwrap();
    }

    /// 握手并下发 10 分钟、额度充足的租约。
    async fn handshake_with_lease(&mut self, seq: u64) {
        self.welcome().await;
        self.send(json!({"type":"lease","id":format!("s{seq}"),"lease_id":format!("lse_{seq}"),
            "expires_at":format_ms(now_ms() + 600_000),"budget_milli":1_000_000,"seq":seq}))
            .await;
    }

    async fn welcome(&mut self) -> Value {
        let hello = self.recv().await;
        assert_eq!(hello["type"], "hello");
        self.send(json!({"type":"welcome","re":hello["id"],"device_id":"dev_1","user_id":"usr_1","tenant_id":"ten_1",
            "server_time":format_ms(now_ms()),"ack_seq":0,"heartbeat_ms":15000}))
            .await;
        hello
    }
}

struct Env {
    state: Arc<State>,
    ws_listener: TcpListener,
    router_url: String,
    sock: std::path::PathBuf,
    gate: Arc<Notify>,
    upstream_online: Arc<AtomicBool>,
    outbox: Arc<Outbox>,
    http: reqwest::Client,
    _dir: tempfile::TempDir,
}

async fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let gate = Arc::new(Notify::new());
    let upstream_online = Arc::new(AtomicBool::new(true));
    let up = start_upstream(gate.clone(), upstream_online.clone()).await;

    let state = Arc::new(State::default());
    *state.config.write().unwrap() = ConfigSnapshot {
        agent_cache: false,
        revision: 1,
        agents: vec![],
        routes: vec![Route {
            model: "*".into(),
            model_id: "mdl_1".into(),
            provider_id: "prv_1".into(),
            protocol: "anthropic".into(),
            base_url: format!("http://{up}"),
            upstream_model: None,
            auth: UpstreamAuth::XApiKey,
            proxy: None,
        }],
        rates: vec![Rate {
            model_id: "mdl_1".into(),
            input_milli_per_mtok: 1_000_000,
            output_milli_per_mtok: 1_000_000,
            ..Default::default()
        }],
    };
    state.secrets.write().unwrap().insert("prv_1".into(), "sk".into());
    let outbox = Arc::new(Outbox::open(&dir.path().join("o.sqlite")).unwrap());
    let cancel = CancellationToken::new();
    tokio::spawn(state.lease.clone().run(cancel.clone()));

    let (usage_tx, mut usage_rx) = mpsc::unbounded_channel::<UsageRecord>();
    let outbox_writer = outbox.clone();
    tokio::spawn(async move {
        while let Some(record) = usage_rx.recv().await {
            outbox_writer.append(Kind::Usage, record.to_item()).unwrap();
        }
    });
    let app = Router::new(state.clone(), LOCAL.into(), direct(), usage_tx).app();
    let rl = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let router_url = format!("http://{}/v1/messages", rl.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(rl, app).await.unwrap() });

    let sock = dir.path().join("onexd.sock");
    let listener = ipc::bind(&sock).await.unwrap();
    let srv = Arc::new(Ipc {
        state: state.clone(),
        outbox: outbox.clone(),
        router_addr: None,
        server_url: None,
        launch: None,
        credentials: None,
        identity_transition: Default::default(),
        shutdown: cancel.clone(),
    });
    tokio::spawn(ipc::serve(listener, sock.clone(), srv));

    let ws_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut o = WsOptions::new(format!("ws://{}/v1/edge/ws", ws_listener.local_addr().unwrap()));
    // 重连间隔放长，让“断开”状态能被观察到
    o.backoff_min = Duration::from_millis(300);
    o.backoff_max = Duration::from_millis(300);
    state.token.send_replace(Some("t".into()));
    tokio::spawn(ws::run(o, state.clone(), outbox.clone(), cancel));

    Env { state, ws_listener, router_url, sock, gate, upstream_online, outbox, http: direct(), _dir: dir }
}

fn direct() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

impl Env {
    async fn accept(&self) -> Peer {
        let (tcp, _) = timeout(T, self.ws_listener.accept()).await.unwrap().unwrap();
        Peer(tokio_tungstenite::accept_async(tcp).await.unwrap())
    }

    async fn reject_control_for(&self, outage: Duration) {
        let reset_connections = async {
            loop {
                let (tcp, _) = self.ws_listener.accept().await.unwrap();
                drop(tcp);
            }
        };
        let _ = timeout(outage, reset_connections).await;
    }

    fn req(&self, scenario: &str) -> reqwest::RequestBuilder {
        self.http.post(&self.router_url).timeout(T).header("x-api-key", LOCAL).header("x-test-scenario", scenario).json(
            &json!({"model":"claude-x","max_tokens":10,"stream":true,"messages":[{"role":"user","content":"hi"}]}),
        )
    }

    async fn status(&self) -> Value {
        let (r, mut w) = transport::connect(&self.sock).await.unwrap().into_split();
        w.write_all(b"{\"cmd\":\"status\"}\n").await.unwrap();
        let mut line = String::new();
        BufReader::new(r).read_line(&mut line).await.unwrap();
        serde_json::from_str(&line).unwrap()
    }

    async fn wait_lease(&self) {
        timeout(T, async {
            while self.state.lease.lease_id().is_none() {
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }

    async fn wait_phase(&self, p: Phase) {
        timeout(T, async {
            while self.state.phase() != p {
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }
}

fn names(text: &str) -> Vec<String> {
    text.lines().filter_map(|l| l.strip_prefix("event: ")).map(String::from).collect()
}

#[tokio::test]
async fn control_connection_drop_does_not_affect_local_conversation() {
    let e = env().await;
    let mut p = e.accept().await;
    p.handshake_with_lease(1).await;
    e.wait_lease().await;
    e.wait_phase(Phase::Connected).await;

    // 开始一条流，收到首片
    let resp = e.req("gated").send().await.unwrap();
    let mut body = resp.bytes_stream();
    let first = timeout(T, body.next()).await.unwrap().unwrap().unwrap();
    assert!(String::from_utf8_lossy(&first).contains("message_start"));

    // 只断控制连接
    drop(p);
    e.wait_phase(Phase::Backoff).await;

    let s = e.status().await;
    assert_ne!(s["ws"], "connected");
    assert!(s["ws_last_error"].is_string(), "{s}");
    assert_eq!(s["lease"]["state"], "active");
    assert_eq!(s["upstream"]["inflight"], 1);
    assert_eq!(s["upstream"]["last_error"], Value::Null);

    // 进行中的流照常完成
    e.gate.notify_one();
    let mut rest = Vec::new();
    while let Some(c) = timeout(T, body.next()).await.unwrap() {
        rest.extend_from_slice(&c.unwrap());
    }
    let n = names(&String::from_utf8(rest).unwrap());
    assert_eq!(n.last().map(String::as_str), Some("message_stop"), "{n:?}");
    assert!(!n.iter().any(|x| x == "error"));

    // 断线期间租约有效，新请求照常放行
    let text = e.req("").send().await.unwrap().text().await.unwrap();
    assert_eq!(names(&text).last().map(String::as_str), Some("message_stop"));

    let s = e.status().await;
    assert_eq!(s["upstream"]["inflight"], 0);
    assert_eq!(s["upstream"]["last"]["outcome"], "ok");
    assert_eq!(s["upstream"]["last_error"], Value::Null);
    assert_eq!(s["lease"]["state"], "active");
}

#[tokio::test]
async fn upstream_stream_drop_does_not_affect_control_connection() {
    let e = env().await;
    let mut p = e.accept().await;
    p.handshake_with_lease(1).await;
    e.wait_lease().await;
    e.wait_phase(Phase::Connected).await;

    // 只断上游流
    let text = e.req("cut").send().await.unwrap().text().await.unwrap();
    assert_eq!(names(&text).last().map(String::as_str), Some("error"));

    let s = e.status().await;
    assert_eq!(s["ws"], "connected");
    assert_eq!(s["ws_last_error"], Value::Null);
    assert_eq!(s["lease"]["state"], "active");
    assert_eq!(s["upstream"]["last_error"]["outcome"], "upstream_error");
    assert_eq!(s["upstream"]["last"]["outcome"], "upstream_error");
    assert!(s["upstream"]["last_error"]["request_id"].as_str().unwrap().starts_with("req_"));
    // status 里不带凭据和正文
    let raw = s.to_string();
    assert!(!raw.contains("\"sk\""));
    assert!(!raw.contains(LOCAL));
    assert!(!raw.contains("\"hi\""));

    // 控制连接还在：Server 的 ping 仍有回应
    p.send(json!({"type":"ping","id":"x"})).await;
    loop {
        let m = p.recv().await;
        if m["type"] == "pong" {
            assert_eq!(m["re"], "x");
            break;
        }
    }
    assert_eq!(e.state.phase(), Phase::Connected);

    // 上游恢复后新请求照常
    let text = e.req("").send().await.unwrap().text().await.unwrap();
    assert_eq!(names(&text).last().map(String::as_str), Some("message_stop"));
    let s = e.status().await;
    assert_eq!(s["upstream"]["last"]["outcome"], "ok");
    // 最近一次出错的记录保留
    assert_eq!(s["upstream"]["last_error"]["outcome"], "upstream_error");
}

async fn reconnect_after_both_links_drop(outage: Duration) {
    let e = env().await;
    let mut peer = e.accept().await;
    peer.handshake_with_lease(1).await;
    e.wait_lease().await;
    let session = "fixture-session";
    *e.state.active_session.write().unwrap() = Some(session.into());
    e.outbox
        .append(
            Kind::Events,
            json!({"session_id":session,"kind":"user_message","at":format_ms(now_ms()),
                "source_offset":1,"payload":{"content":"before outage"}}),
        )
        .unwrap();
    let response = e.req("").send().await.unwrap().text().await.unwrap();
    assert_eq!(names(&response).last().map(String::as_str), Some("message_stop"));
    let before = e.status().await;
    assert_eq!(before["lease"]["used_milli"], 15);

    // The control peer sends no acknowledgment before both links drop.
    drop(peer);
    e.upstream_online.store(false, Ordering::SeqCst);
    e.wait_phase(Phase::Backoff).await;
    let response = e.req("").send().await.unwrap();
    assert_eq!(response.status(), 502);
    assert_eq!(response.json::<Value>().await.unwrap()["error"]["type"], "api_error");
    e.reject_control_for(outage).await;

    let offline = e.status().await;
    assert_ne!(offline["ws"], "connected");
    assert_eq!(offline["logged_in"], true);
    assert_eq!(offline["outbox_ack_seq"], 0);
    assert_eq!(offline["lease"]["used_milli"], 15);
    assert_eq!(offline["upstream"]["last"]["outcome"], "upstream_error");

    e.upstream_online.store(true, Ordering::SeqCst);
    let mut peer = e.accept().await;
    let hello = peer.welcome().await;
    e.wait_phase(Phase::Connected).await;
    assert_eq!(hello["outbox_last_seq"], offline["outbox_last_seq"]);
    let response = e.req("").send().await.unwrap().text().await.unwrap();
    assert_eq!(names(&response).last().map(String::as_str), Some("message_stop"));

    let count = timeout(T, async {
        loop {
            let total = e.outbox.last_seq();
            if total >= 5 {
                break total;
            }
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("missing event or usage");
    assert_eq!(count, 5); // one event, two successes and two failed attempts across the outage
    let mut replayed = Vec::new();
    timeout(T, async {
        while replayed.len() < count as usize {
            if let Some(batch) = peer.recv().await["batch"].as_array() {
                replayed.extend_from_slice(batch);
            }
        }
    })
    .await
    .expect("outbox was not replayed");
    let stored: Vec<_> = e.outbox.pending(0, 10).unwrap().into_iter().map(|row| row.item).collect();
    assert_eq!(replayed, stored);
    assert!(replayed.iter().all(|item| item["session_id"] == session));
    assert_eq!(replayed[0]["payload"]["content"], "before outage");
    assert_eq!(replayed[1]["cost_milli"], 15);
    assert_eq!(replayed[2]["cost_milli"], 0);
    assert_eq!(replayed[3]["cost_milli"], 0);
    assert_eq!(replayed[4]["cost_milli"], 15);

    peer.send(json!({"type":"events_ack","ack_seq":count})).await;
    timeout(T, async {
        while e.outbox.ack_seq().unwrap() != count {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("outbox acknowledgment did not advance");
    let after = e.status().await;
    assert_eq!(after["device_id"], before["device_id"]);
    assert_eq!(after["logged_in"], true);
    assert_eq!(after["lease"]["used_milli"], 30);
}

#[tokio::test]
async fn simultaneous_outage_reconnects_and_replays_outbox() {
    reconnect_after_both_links_drop(Duration::ZERO).await;
}

#[tokio::test]
#[ignore = "two-minute local outage; run explicitly for S1-T1"]
async fn two_minute_simultaneous_outage_reconnects_and_replays_outbox() {
    reconnect_after_both_links_drop(Duration::from_secs(120)).await;
}
