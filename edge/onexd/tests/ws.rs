//! WS 客户端对一个进程内假 Server 的测试。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use onexd::lease::LeaseOptions;
use onexd::outbox::{Kind, Outbox, now_ms};
use onexd::pricing::format_ms;
use onexd::state::{Phase, State};
use onexd::ws::{self, WsOptions};
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_util::sync::CancellationToken;

const T: Duration = Duration::from_secs(5);

struct FakeServer {
    listener: TcpListener,
    url: String,
}

struct Peer {
    ws: WebSocketStream<TcpStream>,
    headers: Vec<(String, String)>,
}

impl FakeServer {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/v1/edge/ws", listener.local_addr().unwrap());
        Self { listener, url }
    }

    async fn accept(&self) -> Peer {
        self.accept_with(None).await.unwrap()
    }

    /// `reject` 不为空时在升级阶段返回这个 HTTP 状态。
    async fn accept_with(&self, reject: Option<StatusCode>) -> Option<Peer> {
        let (tcp, _) = timeout(T, self.listener.accept()).await.expect("edge did not connect").unwrap();
        let headers = Arc::new(Mutex::new(Vec::new()));
        let h = headers.clone();
        let cb = move |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
            *h.lock().unwrap() =
                req.headers().iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap().to_string())).collect();
            match reject {
                Some(s) => {
                    let mut r = ErrorResponse::new(None);
                    *r.status_mut() = s;
                    Err(r)
                }
                None => Ok(resp),
            }
        };
        let ws = tokio_tungstenite::accept_hdr_async(tcp, cb).await.ok()?;
        let headers = headers.lock().unwrap().clone();
        Some(Peer { ws, headers })
    }
}

impl Peer {
    fn header(&self, k: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }

    async fn recv(&mut self) -> Value {
        loop {
            match timeout(T, self.ws.next()).await.expect("recv timeout").expect("closed").unwrap() {
                Message::Text(t) => return serde_json::from_str(&t).unwrap(),
                _ => continue,
            }
        }
    }

    /// 跳过 ping，取下一条别的消息。
    async fn recv_skip_ping(&mut self) -> Value {
        loop {
            let m = self.recv().await;
            if m["type"] != "ping" {
                return m;
            }
        }
    }

    async fn send(&mut self, v: Value) {
        self.ws.send(Message::text(v.to_string())).await.unwrap();
    }

    /// 收 hello，回 welcome。
    async fn handshake(&mut self, ack_seq: u64, heartbeat_ms: u64) -> Value {
        let hello = self.recv().await;
        assert_eq!(hello["type"], "hello");
        self.send(json!({"type":"welcome","re":hello["id"],"device_id":"dev_1","user_id":"usr_1","tenant_id":"ten_1",
            "server_time":format_ms(now_ms()),"ack_seq":ack_seq,"heartbeat_ms":heartbeat_ms}))
            .await;
        hello
    }

    /// 收 events/usage 消息直到拿到 `n` 条，返回 seq 列表。
    async fn recv_seqs(&mut self, n: usize) -> Vec<u64> {
        let mut seqs = Vec::new();
        while seqs.len() < n {
            let m = self.recv_skip_ping().await;
            assert!(m["type"] == "events" || m["type"] == "usage", "unexpected {m}");
            seqs.extend(m["batch"].as_array().unwrap().iter().map(|i| i["seq"].as_u64().unwrap()));
        }
        seqs
    }

    /// 确认在 `d` 内没有 events/usage 消息。
    async fn expect_no_data(&mut self, d: Duration) {
        let r = timeout(d, async {
            loop {
                let m = self.recv().await;
                if m["type"] != "ping" {
                    return m;
                }
            }
        })
        .await;
        assert!(r.is_err(), "unexpected message {:?}", r.unwrap());
    }
}

struct Edge {
    state: Arc<State>,
    outbox: Arc<Outbox>,
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<()>,
    _dir: tempfile::TempDir,
}

fn opts(url: &str) -> WsOptions {
    let mut o = WsOptions::new(url);
    o.backoff_min = Duration::from_millis(20);
    o.backoff_max = Duration::from_millis(100);
    o.connect_timeout = Duration::from_secs(2);
    o
}

fn start_edge(url: &str, token: Option<&str>) -> Edge {
    start_edge_with(opts(url), token)
}

fn start_edge_with(o: WsOptions, token: Option<&str>) -> Edge {
    start_edge_full(o, token, LeaseOptions::default())
}

fn start_edge_full(o: WsOptions, token: Option<&str>, lo: LeaseOptions) -> Edge {
    let dir = tempfile::tempdir().unwrap();
    let outbox = Arc::new(Outbox::open(&dir.path().join("outbox.sqlite")).unwrap());
    let lease = Arc::new(onexd::lease::Ledger::with_options(lo));
    let state = Arc::new(State { lease: lease.clone(), ..Default::default() });
    tokio::spawn(lease.run(CancellationToken::new()));
    state.token.send_replace(token.map(String::from));
    let cancel = CancellationToken::new();
    let task = tokio::spawn(ws::run(o, state.clone(), outbox.clone(), cancel.clone()));
    Edge { state, outbox, cancel, task, _dir: dir }
}

fn event(n: u64) -> Value {
    json!({"session_id":"ses_1","kind":"user_message","at":"2026-11-19T08:00:00Z","payload":{"content":format!("m{n}")}})
}

async fn wait_phase(state: &State, p: Phase) {
    timeout(T, async {
        while state.phase() != p {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("phase stayed {:?}, want {p:?}", state.phase()));
}

#[tokio::test]
async fn handshake_headers_and_hello() {
    let srv = FakeServer::start().await;
    let edge = start_edge(&srv.url, Some("devtok"));
    edge.outbox.append(Kind::Events, event(1)).unwrap();

    let mut p = srv.accept().await;
    assert_eq!(p.header("authorization"), Some("Bearer devtok"));
    assert_eq!(p.header("onex-protocol"), Some("0"));
    assert_eq!(p.header("onex-edge-version"), Some(env!("CARGO_PKG_VERSION")));
    let hello = p.handshake(0, 15000).await;
    assert_eq!(hello["outbox_last_seq"], 1);
    assert_eq!(hello["config_revision"], 0);
    assert!(hello["os"].is_string() && hello["arch"].is_string());

    wait_phase(&edge.state, Phase::Connected).await;
    assert_eq!(edge.state.conn.lock().unwrap().device_id.as_deref(), Some("dev_1"));
    assert_eq!(p.recv_seqs(1).await, [1]);

    edge.cancel.cancel();
    timeout(T, edge.task).await.unwrap().unwrap();
}

#[tokio::test]
async fn waits_for_login_before_connecting() {
    let srv = FakeServer::start().await;
    let edge = start_edge(&srv.url, None);
    assert!(timeout(Duration::from_millis(200), srv.listener.accept()).await.is_err());
    assert_eq!(edge.state.phase(), Phase::Idle);
    edge.state.token.send_replace(Some("t".into()));
    let mut p = srv.accept().await;
    p.handshake(0, 15000).await;
    wait_phase(&edge.state, Phase::Connected).await;
}

#[tokio::test]
async fn answers_server_ping_and_pings_on_heartbeat() {
    let srv = FakeServer::start().await;
    let _edge = start_edge(&srv.url, Some("t"));
    let mut p = srv.accept().await;
    p.handshake(0, 100).await;
    p.send(json!({"type":"ping","id":"s1"})).await;
    let mut got_pong = false;
    let mut got_ping = false;
    while !(got_pong && got_ping) {
        let m = p.recv().await;
        match m["type"].as_str().unwrap() {
            "pong" => {
                assert_eq!(m["re"], "s1");
                got_pong = true;
            }
            "ping" => {
                p.send(json!({"type":"pong","re":m["id"]})).await;
                got_ping = true;
            }
            other => panic!("unexpected {other}"),
        }
    }
}

#[tokio::test]
async fn reconnects_after_server_drop() {
    let srv = FakeServer::start().await;
    let edge = start_edge(&srv.url, Some("t"));
    let mut p = srv.accept().await;
    p.handshake(0, 15000).await;
    wait_phase(&edge.state, Phase::Connected).await;
    drop(p);

    let mut p = srv.accept().await;
    p.handshake(0, 15000).await;
    wait_phase(&edge.state, Phase::Connected).await;
    assert_eq!(edge.state.conn.lock().unwrap().connects, 2);
}

#[tokio::test]
async fn reconnects_after_connect_refused() {
    // 先占一个端口再释放，Edge 连接会被拒；之后在同一端口起 Server。
    let addr = {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        l.local_addr().unwrap()
    };
    let url = format!("ws://{addr}/v1/edge/ws");
    let edge = start_edge(&url, Some("t"));
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_ne!(edge.state.phase(), Phase::Connected);

    let srv = FakeServer { listener: TcpListener::bind(addr).await.unwrap(), url };
    let mut p = srv.accept().await;
    p.handshake(0, 15000).await;
    wait_phase(&edge.state, Phase::Connected).await;
}

#[tokio::test]
async fn heartbeat_timeout_triggers_reconnect() {
    let srv = FakeServer::start().await;
    let edge = start_edge(&srv.url, Some("t"));
    let mut p = srv.accept().await;
    p.handshake(0, 50).await;
    // 只收不回，Edge 发 3 次 ping 后应断开。
    for _ in 0..3 {
        assert_eq!(p.recv().await["type"], "ping");
    }
    let mut p2 = srv.accept().await;
    p2.handshake(0, 15000).await;
    wait_phase(&edge.state, Phase::Connected).await;
    drop(p);
}

#[tokio::test]
async fn resends_unacked_after_reconnect_from_welcome_ack_seq() {
    let srv = FakeServer::start().await;
    let edge = start_edge(&srv.url, Some("t"));
    for i in 1..=5 {
        edge.outbox.append(Kind::Events, event(i)).unwrap();
    }

    let mut p = srv.accept().await;
    p.handshake(0, 15000).await;
    assert_eq!(p.recv_seqs(5).await, [1, 2, 3, 4, 5]);
    p.send(json!({"type":"events_ack","ack_seq":2})).await;
    // 等 Edge 处理完确认
    timeout(T, async {
        while edge.outbox.ack_seq().unwrap() != 2 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    drop(p);

    // Server 其实已经持久化到 3，但确认没送到。重连后应从 4 开始补传。
    let mut p = srv.accept().await;
    let hello = p.handshake(3, 15000).await;
    assert_eq!(hello["outbox_last_seq"], 5);
    assert_eq!(p.recv_seqs(2).await, [4, 5]);
    assert_eq!(edge.outbox.ack_seq().unwrap(), 3);

    // 新事件实时发出
    edge.outbox.append(Kind::Usage, json!({"request_id":"req_1"})).unwrap();
    let m = p.recv_skip_ping().await;
    assert_eq!(m["type"], "usage");
    assert_eq!(m["batch"][0]["seq"], 6);

    // 重复和乱序的确认不影响状态
    p.send(json!({"type":"events_ack","ack_seq":6})).await;
    p.send(json!({"type":"events_ack","ack_seq":4})).await;
    p.send(json!({"type":"events_ack","ack_seq":6})).await;
    p.send(json!({"type":"ping","id":"sync"})).await;
    assert_eq!(p.recv_skip_ping().await["type"], "pong");
    assert_eq!(edge.outbox.ack_seq().unwrap(), 6);
    assert_eq!(edge.outbox.unacked_bytes().unwrap(), 0);
    p.expect_no_data(Duration::from_millis(100)).await;
}

#[tokio::test]
async fn batches_group_by_kind_in_seq_order() {
    let srv = FakeServer::start().await;
    let edge = start_edge(&srv.url, Some("t"));
    edge.outbox.append(Kind::Events, event(1)).unwrap();
    edge.outbox.append(Kind::Events, event(2)).unwrap();
    edge.outbox.append(Kind::Usage, json!({"request_id":"r"})).unwrap();
    edge.outbox.append(Kind::Events, event(4)).unwrap();
    let mut p = srv.accept().await;
    p.handshake(0, 15000).await;
    let a = p.recv_skip_ping().await;
    let b = p.recv_skip_ping().await;
    let c = p.recv_skip_ping().await;
    assert_eq!((a["type"].as_str(), a["batch"].as_array().unwrap().len()), (Some("events"), 2));
    assert_eq!((b["type"].as_str(), b["batch"][0]["seq"].as_u64()), (Some("usage"), Some(3)));
    assert_eq!((c["type"].as_str(), c["batch"][0]["seq"].as_u64()), (Some("events"), Some(4)));
    assert_eq!(a["batch"][1]["payload"]["content"], "m2");
}

#[tokio::test]
async fn send_window_waits_for_ack() {
    let srv = FakeServer::start().await;
    let mut o = opts(&srv.url);
    o.window = 3;
    o.batch_max = 2;
    let edge = start_edge_with(o, Some("t"));
    for i in 1..=5 {
        edge.outbox.append(Kind::Events, event(i)).unwrap();
    }
    let mut p = srv.accept().await;
    p.handshake(0, 15000).await;
    assert_eq!(p.recv_seqs(3).await, [1, 2, 3]);
    p.expect_no_data(Duration::from_millis(100)).await;
    p.send(json!({"type":"events_ack","ack_seq":3})).await;
    assert_eq!(p.recv_seqs(2).await, [4, 5]);
}

#[tokio::test]
async fn config_applied_and_acked_and_stale_ignored() {
    let srv = FakeServer::start().await;
    let edge = start_edge(&srv.url, Some("t"));
    let mut p = srv.accept().await;
    p.handshake(0, 15000).await;
    let route = json!({"model":"claude-*","model_id":"mdl_1","provider_id":"prv_1","protocol":"anthropic","base_url":"http://up"});
    let rate = json!({"model_id":"mdl_1","input_milli_per_mtok":1,"output_milli_per_mtok":2,"cache_read_milli_per_mtok":0,"cache_write_milli_per_mtok":0});
    p.send(json!({"type":"config","id":"c1","revision":5,"routes":[route],"agents":[],"rates":[rate]})).await;
    let a = p.recv_skip_ping().await;
    assert_eq!(a, json!({"type":"ack","re":"c1","ok":true}));
    assert_eq!(edge.state.config_revision(), 5);
    assert_eq!(edge.state.config.read().unwrap().rates[0].output_milli_per_mtok, 2);

    p.send(json!({"type":"config","id":"c2","revision":4,"routes":[]})).await;
    assert_eq!(p.recv_skip_ping().await["re"], "c2");
    let cfg = edge.state.config.read().unwrap().clone();
    assert_eq!((cfg.revision, cfg.routes.len()), (5, 1));
    drop(cfg);

    // 重连时 hello 带上当前 revision
    drop(p);
    let mut p = srv.accept().await;
    assert_eq!(p.handshake(0, 15000).await["config_revision"], 5);
}

#[tokio::test]
async fn unauthorized_upgrade_waits_for_new_token() {
    let srv = FakeServer::start().await;
    let edge = start_edge(&srv.url, Some("bad"));
    assert!(srv.accept_with(Some(StatusCode::UNAUTHORIZED)).await.is_none());
    wait_phase(&edge.state, Phase::Unauthenticated).await;
    // 不应自己重试
    assert!(timeout(Duration::from_millis(200), srv.listener.accept()).await.is_err());

    edge.state.token.send_replace(Some("good".into()));
    let mut p = srv.accept().await;
    assert_eq!(p.header("authorization"), Some("Bearer good"));
    p.handshake(0, 15000).await;
    wait_phase(&edge.state, Phase::Connected).await;
}

#[tokio::test]
async fn hello_rejected_unauthenticated() {
    let srv = FakeServer::start().await;
    let edge = start_edge(&srv.url, Some("revoked"));
    let mut p = srv.accept().await;
    let hello = p.recv().await;
    p.send(json!({"type":"ack","re":hello["id"],"ok":false,"error":{"code":"unauthenticated","message":"令牌已吊销"}}))
        .await;
    wait_phase(&edge.state, Phase::Unauthenticated).await;
}

#[tokio::test]
async fn replaced_close_still_reconnects() {
    let srv = FakeServer::start().await;
    let edge = start_edge(&srv.url, Some("t"));
    let mut p = srv.accept().await;
    p.handshake(0, 15000).await;
    wait_phase(&edge.state, Phase::Connected).await;
    p.ws.send(Message::Close(Some(CloseFrame { code: CloseCode::from(4001), reason: "replaced".into() })))
        .await
        .unwrap();
    // backoff_max 是 100 ms
    let mut p = srv.accept().await;
    p.handshake(0, 15000).await;
    wait_phase(&edge.state, Phase::Connected).await;
}

fn lease_msg(id: &str, lease_id: &str, seq: u64, budget: i64, ttl_ms: i64) -> Value {
    json!({"type":"lease","id":id,"lease_id":lease_id,"expires_at":format_ms(now_ms() + ttl_ms),"budget_milli":budget,"seq":seq})
}

/// 跳过 ping 和 ack，取下一条别的消息。
async fn recv_skip(p: &mut Peer, skip: &[&str]) -> Value {
    loop {
        let m = p.recv().await;
        if !skip.contains(&m["type"].as_str().unwrap()) {
            return m;
        }
    }
}

#[tokio::test]
async fn lease_is_applied_acked_and_sent_in_hello() {
    let srv = FakeServer::start().await;
    let edge = start_edge(&srv.url, Some("t"));
    let mut p = srv.accept().await;
    assert_eq!(p.handshake(0, 15000).await["lease_id"], Value::Null);
    p.send(lease_msg("s1", "lse_1", 1, 1000, 600_000)).await;
    assert_eq!(p.recv_skip_ping().await, json!({"type":"ack","re":"s1","ok":true}));
    assert_eq!(edge.state.lease.lease_id().as_deref(), Some("lse_1"));
    assert!(edge.state.lease.admit(0).is_ok());

    // 坏租约回错误
    p.send(json!({"type":"lease","id":"s2","lease_id":"lse_2","expires_at":"later","budget_milli":1,"seq":2})).await;
    let a = p.recv_skip_ping().await;
    assert_eq!((a["re"].as_str(), a["ok"].as_bool()), (Some("s2"), Some(false)));

    drop(p);
    let mut p = srv.accept().await;
    assert_eq!(p.handshake(0, 15000).await["lease_id"], "lse_1");
}

#[tokio::test]
async fn renew_sent_at_80_percent_and_new_lease_resets() {
    let srv = FakeServer::start().await;
    let edge = start_edge(&srv.url, Some("t"));
    let mut p = srv.accept().await;
    p.handshake(0, 15000).await;
    p.send(lease_msg("s1", "lse_1", 1, 100, 600_000)).await;
    p.recv_skip_ping().await;

    edge.state.lease.admit(0).unwrap().finish(80);
    let m = recv_skip(&mut p, &["ping"]).await;
    assert_eq!(m["type"], "lease_renew");
    assert_eq!((m["lease_id"].as_str(), m["used_milli"].as_i64()), (Some("lse_1"), Some(80)));
    assert_eq!(m["op_id"], "lse_1:80");

    // 续租成功：Server 用 re 指向续租消息
    let mut l = lease_msg("s2", "lse_2", 2, 100, 600_000);
    l["re"] = m["id"].clone();
    p.send(l).await;
    assert_eq!(p.recv_skip_ping().await["re"], "s2");
    let s = edge.state.lease.snapshot();
    assert_eq!((s.lease.unwrap().lease_id.as_str(), s.used_milli), ("lse_2", 0));
    assert_eq!(edge.state.lease.status()["renew"]["last_result"], "granted");
}

#[tokio::test]
async fn renew_failure_cutoff_blocks_and_renew_resent_after_reconnect() {
    let srv = FakeServer::start().await;
    let edge = start_edge(&srv.url, Some("t"));
    let mut p = srv.accept().await;
    p.handshake(0, 15000).await;
    p.send(lease_msg("s1", "lse_1", 1, 100, 600_000)).await;
    p.recv_skip_ping().await;
    edge.state.lease.admit(0).unwrap().finish(90);
    assert_eq!(recv_skip(&mut p, &["ping"]).await["type"], "lease_renew");

    // Server 没回就断了：记为不可达，重连后重发同一个续租（op_id 相同）
    drop(p);
    wait_phase(&edge.state, Phase::Backoff).await;
    assert_eq!(edge.state.lease.status()["renew"]["last_result"], "unreachable");
    let mut p = srv.accept().await;
    p.handshake(0, 15000).await;
    let m = recv_skip(&mut p, &["ping"]).await;
    assert_eq!((m["type"].as_str(), m["used_milli"].as_i64()), (Some("lease_renew"), Some(90)));
    assert_eq!(m["op_id"], "lse_1:90");

    // 续租失败：Server 回 cutoff
    p.send(json!({"type":"cutoff","id":"s3","re":m["id"],"reason":"balance"})).await;
    assert_eq!(p.recv_skip_ping().await, json!({"type":"ack","re":"s3","ok":true}));
    assert!(matches!(edge.state.lease.admit(0), Err(onexd::lease::Block::Cutoff(_))));
    let st = edge.state.lease.status();
    assert_eq!((st["state"].as_str(), st["renew"]["last_result"].as_str()), (Some("cutoff"), Some("rejected")));
}

#[tokio::test]
async fn committed_renew_with_lost_reply_is_replayed_unchanged_after_more_spend() {
    // magpie 阻塞 2：额度 100、已用 80 触发续租；Server 已提交但回包丢失；之后又花了 5；回连
    let srv = FakeServer::start().await;
    let edge = start_edge(&srv.url, Some("t"));
    let mut p = srv.accept().await;
    p.handshake(0, 15000).await;
    p.send(lease_msg("s1", "lse_1", 1, 100, 600_000)).await;
    p.recv_skip_ping().await;
    edge.state.lease.admit(0).unwrap().finish(80);
    let first = recv_skip(&mut p, &["ping"]).await;
    assert_eq!((first["used_milli"].as_i64(), first["op_id"].as_str()), (Some(80), Some("lse_1:80")));
    drop(p);
    wait_phase(&edge.state, Phase::Backoff).await;
    edge.state.lease.admit(0).unwrap().finish(5);

    let mut p = srv.accept().await;
    p.handshake(0, 15000).await;
    let again = recv_skip(&mut p, &["ping"]).await;
    // 原样重放：同一 op_id、同一金额，Server 按缓存的结果回
    assert_eq!((again["used_milli"].as_i64(), again["op_id"].as_str()), (Some(80), Some("lse_1:80")));
    p.send(json!({"type":"lease","id":"s2","re":again["id"],"lease_id":"lse_2","expires_at":format_ms(now_ms() + 600_000),"budget_milli":100,"seq":2})).await;
    assert_eq!(p.recv_skip_ping().await["re"], "s2");
    // 快照之后的 5 记到新租约
    let s = edge.state.lease.snapshot();
    assert_eq!((s.lease.unwrap().lease_id.as_str(), s.used_milli), ("lse_2", 5));
    assert_eq!(edge.state.lease.status()["renew"]["pending"], false);
}

#[tokio::test]
async fn renew_retried_while_connected_without_response() {
    let srv = FakeServer::start().await;
    let lo = LeaseOptions { renew_retry: Duration::from_millis(100), ..Default::default() };
    let edge = start_edge_full(opts(&srv.url), Some("t"), lo);
    let mut p = srv.accept().await;
    p.handshake(0, 15000).await;
    p.send(lease_msg("s1", "lse_1", 1, 100, 600_000)).await;
    p.recv_skip_ping().await;
    edge.state.lease.admit(0).unwrap().finish(85);
    let a = recv_skip(&mut p, &["ping"]).await;
    // 不回应，0.5 秒（最小重发间隔）后重发
    let b = recv_skip(&mut p, &["ping"]).await;
    assert_eq!((a["type"].as_str(), b["type"].as_str()), (Some("lease_renew"), Some("lease_renew")));
    assert_eq!(a["op_id"], b["op_id"]);
    assert_ne!(a["id"], b["id"]);
    assert_eq!(edge.state.lease.status()["renew"]["last_result"], "no_response");
}

#[tokio::test]
async fn offline_uses_current_lease_until_exhausted() {
    let srv = FakeServer::start().await;
    let edge = start_edge(&srv.url, Some("t"));
    let mut p = srv.accept().await;
    p.handshake(0, 15000).await;
    p.send(lease_msg("s1", "lse_1", 1, 100, 600_000)).await;
    p.recv_skip_ping().await;
    drop(p);
    wait_phase(&edge.state, Phase::Backoff).await;

    // 断线期间照常放行，直到额度用完
    for _ in 0..4 {
        edge.state.lease.admit(0).unwrap().finish(25);
    }
    assert_eq!(edge.state.lease.admit(0).err(), Some(onexd::lease::Block::Exhausted));

    // 重连后马上续租，带上离线期间的用量
    let mut p = srv.accept().await;
    p.handshake(0, 15000).await;
    let m = recv_skip(&mut p, &["ping"]).await;
    assert_eq!((m["type"].as_str(), m["used_milli"].as_i64()), (Some("lease_renew"), Some(100)));
}

#[tokio::test]
async fn ack_regression_resends_retained_and_reports() {
    let srv = FakeServer::start().await;
    let edge = start_edge(&srv.url, Some("t"));
    for i in 1..=5 {
        edge.outbox.append(Kind::Events, event(i)).unwrap();
    }
    let mut p = srv.accept().await;
    p.handshake(0, 15000).await;
    assert_eq!(p.recv_seqs(5).await, [1, 2, 3, 4, 5]);
    p.send(json!({"type":"events_ack","ack_seq":5})).await;
    p.send(json!({"type":"ping","id":"sync"})).await;
    assert_eq!(p.recv_skip_ping().await["type"], "pong");
    drop(p);

    // Server 丢了数据，只记到 2
    let mut p = srv.accept().await;
    p.handshake(2, 15000).await;
    let d = p.recv_skip_ping().await;
    assert_eq!((d["type"].as_str(), d["diag_id"].as_str()), (Some("diag_result"), Some("ack_regression")));
    assert_eq!(d["detail"]["local_ack_seq"], 5);
    assert_eq!(d["detail"]["resend_from"], 3);
    assert_eq!(d["detail"]["lost"], Value::Null);
    assert_eq!(p.recv_seqs(3).await, [3, 4, 5]);
    // 本地 ack_seq 不倒退
    assert_eq!(edge.outbox.ack_seq().unwrap(), 5);
    p.send(json!({"type":"events_ack","ack_seq":5})).await;
    p.expect_no_data(Duration::from_millis(100)).await;
}

#[tokio::test]
async fn cancel_closes_connection() {
    let srv = FakeServer::start().await;
    let edge = start_edge(&srv.url, Some("t"));
    let mut p = srv.accept().await;
    p.handshake(0, 15000).await;
    wait_phase(&edge.state, Phase::Connected).await;
    edge.cancel.cancel();
    timeout(T, edge.task).await.unwrap().unwrap();
    loop {
        match timeout(T, p.ws.next()).await.unwrap() {
            Some(Ok(Message::Close(f))) => {
                assert_eq!(f.unwrap().code, CloseCode::Normal);
                break;
            }
            Some(Ok(_)) => continue,
            other => panic!("expected close, got {other:?}"),
        }
    }
}
