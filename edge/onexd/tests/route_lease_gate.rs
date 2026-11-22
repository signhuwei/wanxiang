//! 隔离租约门禁（`contracts/routing-lease-gate.md`）的 Edge 侧用例。
//!
//! 假 Server 走真实 WebSocket，Edge 用隔离测试入口同时打开模型池和租约门禁；租约只记在
//! 隔离租约存储里。最后一例确认：残留旧配置、旧密钥和隔离租约都不能让真实模型入口访问上游。

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use futures_util::{SinkExt, StreamExt};
use hkdf::Hkdf;
use onex_core::ws::{Rate, Route, UpstreamAuth};
use onexd::outbox::Outbox;
use onexd::route_apply::{PoolLeaseState, Scope, Store};
use onexd::router::Router;
use onexd::secret::{DeviceKey, route_secret_aad};
use onexd::state::{ConfigSnapshot, State};
use onexd::ws::{self, WsOptions};
use serde_json::{Value, json};
use sha2::Sha256;
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;
use x25519_dalek::{PublicKey, StaticSecret};

const T: Duration = Duration::from_secs(5);
const QUIET: Duration = Duration::from_millis(250);
const FIXTURE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/routing/p0-ab.json"));
const DEVICE_SECRET: [u8; 32] = [7; 32];

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).unwrap()
}

fn seal(aad: &[u8], plaintext: &str) -> (String, String, String) {
    let device_public = PublicKey::from(&StaticSecret::from(DEVICE_SECRET));
    let sender = StaticSecret::from(rand::random::<[u8; 32]>());
    let shared = sender.diffie_hellman(&device_public);
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(None, shared.as_bytes()).expand(b"onex-edge-route-secret-v1", &mut key).unwrap();
    let nonce: [u8; 24] = rand::random();
    let ciphertext = XChaCha20Poly1305::new((&key).into())
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext.as_bytes(), aad })
        .unwrap();
    (B64.encode(PublicKey::from(&sender).as_bytes()), B64.encode(nonce), B64.encode(ciphertext))
}

fn config(revision: u64, projection: &str) -> Value {
    let mut f = fixture()["wire"]["config"].clone();
    f["id"] = json!(format!("cfg{revision}_{}", rand::random::<u32>()));
    f["revision"] = json!(revision);
    f["route_pool"]["projection_id"] = json!(projection);
    let mut refs: Vec<(String, u64)> = f["routes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            let c = &r["credential_ref"];
            (c["credential_id"].as_str().unwrap().to_owned(), c["credential_version"].as_u64().unwrap())
        })
        .collect();
    refs.sort();
    refs.dedup();
    let secrets: Vec<Value> = refs
        .iter()
        .map(|(id, version)| {
            let aad = route_secret_aad("ten_demo", "dev_lin", projection, revision, id, *version);
            let (key_id, nonce, ciphertext) = seal(&aad, &format!("key-{id}-{version}"));
            json!({"credential_id":id,"credential_version":version,"key_id":key_id,"nonce":nonce,"ciphertext":ciphertext})
        })
        .collect();
    f["route_pool"]["secrets"] = json!(secrets);
    f
}

/// 与 `config(revision, projection)` 精确绑定的租约帧。
fn lease(re: &Value, lease_id: &str, revision: u64, projection: &str) -> Value {
    let c = &fixture()["wire"]["config"];
    json!({"type":"lease","id":format!("ls_{lease_id}"),"re":re,"lease_id":lease_id,
        "expires_at":"2026-11-22T02:08:00Z","budget_milli":800,"model_budgets":{"mdl_m":800},
        "commerce_plan_id":c["policy"]["commerce_plan_id"],"seq":1,
        "signature_id":c["route_pool"]["signature_id"],"config_revision":revision,"projection_id":projection})
}

struct FakeServer {
    listener: TcpListener,
    url: String,
}

impl FakeServer {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/v1/edge/ws", listener.local_addr().unwrap());
        Self { listener, url }
    }

    async fn accept(&self) -> Peer {
        let (tcp, _) = timeout(T, self.listener.accept()).await.expect("edge did not connect").unwrap();
        Peer { ws: tokio_tungstenite::accept_async(tcp).await.unwrap() }
    }
}

struct Peer {
    ws: WebSocketStream<TcpStream>,
}

impl Peer {
    async fn recv(&mut self) -> Value {
        loop {
            match timeout(T, self.ws.next()).await.expect("recv timeout").expect("closed").unwrap() {
                Message::Text(t) => {
                    let v: Value = serde_json::from_str(&t).unwrap();
                    if v["type"] != "ping" {
                        return v;
                    }
                }
                _ => continue,
            }
        }
    }

    async fn send(&mut self, v: &Value) {
        self.ws.send(Message::text(v.to_string())).await.unwrap();
    }

    async fn quiet(&mut self) {
        let r = timeout(QUIET, async {
            loop {
                match self.ws.next().await {
                    Some(Ok(Message::Text(t))) => {
                        let v: Value = serde_json::from_str(&t).unwrap();
                        if v["type"] != "ping" {
                            return Some(v);
                        }
                    }
                    Some(Ok(_)) => continue,
                    _ => return None,
                }
            }
        })
        .await;
        if let Ok(Some(v)) = r {
            panic!("unexpected message {v}");
        }
    }

    async fn welcome(&mut self) {
        let hello = self.recv().await;
        assert_eq!(hello["capabilities"], json!(["route_pool.v1"]), "{hello}");
        assert!(hello["lease_id"].is_null(), "hello never carries an isolated lease: {hello}");
        let mut w = fixture()["wire"]["welcome"].clone();
        w["re"] = hello["id"].clone();
        w["heartbeat_ms"] = json!(15000);
        self.send(&w).await;
    }

    /// 发 config，收 config_applied 并回成功 ACK，返回回执。
    async fn apply_and_ack(&mut self, frame: &Value) -> Value {
        self.send(frame).await;
        let r = self.recv().await;
        assert_eq!((r["type"].as_str(), r["result"].as_str()), (Some("config_applied"), Some("applied")), "{r}");
        self.send(&json!({"type":"ack","re":r["id"],"ok":true})).await;
        r
    }

    async fn expect_lease_request(&mut self) -> Value {
        let m = self.recv().await;
        assert_eq!(m["type"], "lease_request", "{m}");
        assert!(m["op_id"].as_str().is_some_and(|s| !s.is_empty()), "{m}");
        m
    }
}

struct Edge {
    state: Arc<State>,
    store: Arc<Store>,
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<()>,
    _outbox: tempfile::TempDir,
}

impl Edge {
    fn start(url: &str, store_path: &Path) -> Self {
        Self::start_with_state(
            url,
            store_path,
            State { device_key: DeviceKey::from_bytes(DEVICE_SECRET), ..Default::default() },
        )
    }

    fn start_with_state(url: &str, store_path: &Path, state: State) -> Self {
        let store = Arc::new(Store::open(store_path).unwrap());
        let outbox_dir = tempfile::tempdir().unwrap();
        let outbox = Arc::new(Outbox::open(&outbox_dir.path().join("outbox.sqlite")).unwrap());
        let state = Arc::new(state);
        state.replace_token(Some("t".into()));
        let mut o = WsOptions::new(url)
            .with_route_pool_for_isolated_test(store.clone())
            .with_route_pool_leases_for_isolated_test();
        o.backoff_min = Duration::from_millis(20);
        o.backoff_max = Duration::from_millis(100);
        o.connect_timeout = Duration::from_secs(2);
        let cancel = CancellationToken::new();
        let task = tokio::spawn(ws::run(o, state.clone(), outbox, cancel.clone()));
        Self { state, store, cancel, task, _outbox: outbox_dir }
    }

    async fn stop(self) {
        self.cancel.cancel();
        timeout(T, self.task).await.unwrap().unwrap();
    }
}

fn scope(url: &str) -> Scope {
    Scope::new(url, "ten_demo", "usr_lin", "dev_lin").unwrap()
}

fn store_path(dir: &tempfile::TempDir) -> std::path::PathBuf {
    dir.path().join("route_apply.sqlite")
}

/// 回执的成功 ACK 之后才首领；拒绝回执的 ACK 和未确认的成功回执都不首领。精确绑定的首领被接受，
/// 只记隔离租约，不进生产 Ledger。
#[tokio::test]
async fn first_lease_waits_for_the_applied_ack_and_binds_exactly() {
    let srv = FakeServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let edge = Edge::start(&srv.url, &store_path(&dir));
    let mut p = srv.accept().await;
    p.welcome().await;
    p.quiet().await;

    // 被拒的回执得到成功 ACK：只确认收到拒绝，不首领。
    let mut missing = config(91, "prj_91");
    missing["route_pool"]["secrets"].as_array_mut().unwrap().pop();
    p.send(&missing).await;
    let rejected = p.recv().await;
    assert_eq!(rejected["result"], "rejected");
    p.send(&json!({"type":"ack","re":rejected["id"],"ok":true})).await;
    p.quiet().await;

    // 成功回执未 ACK 时不首领。
    p.send(&config(91, "prj_91")).await;
    let receipt = p.recv().await;
    assert_eq!(receipt["result"], "applied");
    p.quiet().await;
    // 不匹配的 ACK 也不首领。
    p.send(&json!({"type":"ack","re":"msg_other","ok":true})).await;
    p.quiet().await;

    p.send(&json!({"type":"ack","re":receipt["id"],"ok":true})).await;
    let request = p.expect_lease_request().await;
    p.send(&lease(&request["id"], "lse_91", 91, "prj_91")).await;
    let ack = p.recv().await;
    assert_eq!(ack, json!({"type":"ack","re":"ls_lse_91","ok":true}));
    let held = edge.store.accepted_pool_lease(&scope(&srv.url)).unwrap().unwrap();
    assert_eq!((held.lease_id.as_str(), held.config_revision, held.projection_id.as_str()), ("lse_91", 91, "prj_91"));
    assert_eq!(held.model_budgets["mdl_m"], 800);
    // 生产 Ledger 未受影响。
    assert!(edge.state.lease.lease_id().is_none());
    p.quiet().await;
    edge.stop().await;
}

/// 门禁拒绝：保持门禁，不重复请求；应用新目标、回执确认后再请求。
#[tokio::test]
async fn gate_refusal_waits_for_a_new_applied_target() {
    let srv = FakeServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let edge = Edge::start(&srv.url, &store_path(&dir));
    let mut p = srv.accept().await;
    p.welcome().await;
    p.apply_and_ack(&config(91, "prj_91")).await;
    let request = p.expect_lease_request().await;
    p.send(&json!({"type":"ack","re":request["id"],"ok":false,
        "error":{"code":"forbidden","message":"x","detail":{"reason":"projection_signature_stale"}}}))
        .await;
    p.quiet().await;
    // 同投影重封恢复视图不解除门禁。
    p.send(&config(91, "prj_91")).await;
    p.quiet().await;
    // 新目标应用并确认后再请求。
    p.apply_and_ack(&config(92, "prj_92")).await;
    let again = p.expect_lease_request().await;
    assert_ne!(again["op_id"], request["op_id"]);
    assert!(edge.store.accepted_pool_lease(&scope(&srv.url)).unwrap().is_none());
    edge.stop().await;
}

/// 不匹配当前已确认视图的租约：拒用标记和逐型号零用量的 release_only 先落盘再发；cutoff
/// lease_released 结清。重连重发同一操作，直到结清。
#[tokio::test]
async fn mismatched_lease_is_refused_and_released_once() {
    let srv = FakeServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let path = store_path(&dir);
    let edge = Edge::start(&srv.url, &path);
    let mut p = srv.accept().await;
    p.welcome().await;
    p.apply_and_ack(&config(91, "prj_91")).await;
    let request = p.expect_lease_request().await;

    p.send(&lease(&request["id"], "lse_bad", 90, "prj_90")).await;
    let ack = p.recv().await;
    assert_eq!((ack["re"].as_str(), ack["ok"].as_bool()), (Some("ls_lse_bad"), Some(false)), "{ack}");
    assert_eq!(ack["error"]["detail"]["reason"], "lease_projection_mismatch");
    let renew = p.recv().await;
    assert_eq!(renew["type"], "lease_renew");
    assert_eq!(
        (renew["lease_id"].as_str(), renew["used_milli"].as_i64(), renew["release_only"].as_bool()),
        (Some("lse_bad"), Some(0), Some(true))
    );
    assert_eq!(renew["model_used_milli"], json!({"mdl_m":0}), "every allocated model reports zero");
    assert_eq!(edge.store.pool_lease(&scope(&srv.url), "lse_bad").unwrap().unwrap().state, PoolLeaseState::Refused);

    // 续租回复丢失：断线重连后重发同一 msg id、op_id 和数值。
    edge.stop().await;
    drop(p);
    let edge = Edge::start(&srv.url, &path);
    let mut p = srv.accept().await;
    p.welcome().await;
    let replay = p.recv().await;
    assert_eq!(replay, renew, "the persisted release is resent byte for byte");

    // 失败 ACK 本身不结清，记录保留。
    p.send(&json!({"type":"ack","re":renew["id"],"ok":false,"error":{"code":"conflict","message":"x"}})).await;
    p.quiet().await;
    let op = edge.store.pending_pool_op(&scope(&srv.url), "lse_bad").unwrap().unwrap();
    assert_eq!(op.last_failure.as_deref(), Some("conflict"));

    p.send(&json!({"type":"cutoff","id":"co_rel","re":renew["id"],"reason":"contract","settled_lease_id":"lse_bad",
        "detail":{"reason":"lease_released"}}))
        .await;
    assert_eq!(p.recv().await, json!({"type":"ack","re":"co_rel","ok":true}));
    assert_eq!(edge.store.pool_lease(&scope(&srv.url), "lse_bad").unwrap().unwrap().state, PoolLeaseState::Settled);
    assert!(edge.store.pending_pool_op(&scope(&srv.url), "lse_bad").unwrap().is_none());
    // 视图仍待同步：同投影重封、已持久的确认之后才再首领。
    p.send(&config(91, "prj_91")).await;
    p.expect_lease_request().await;
    edge.stop().await;
}

/// 重启：只用已持久的成功确认，等同投影合法重封后才首领；已接受租约在纯换池后继续可用，
/// 签发变化时按原租约结清再领后继。
#[tokio::test]
async fn reseal_restores_then_pool_moves_keep_and_signature_change_settles() {
    let srv = FakeServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let path = store_path(&dir);
    let edge = Edge::start(&srv.url, &path);
    let mut p = srv.accept().await;
    p.welcome().await;
    p.apply_and_ack(&config(91, "prj_91")).await;
    let request = p.expect_lease_request().await;
    p.send(&lease(&request["id"], "lse_91", 91, "prj_91")).await;
    p.recv().await;
    edge.stop().await;
    drop(p);

    // 重启后：视图待同步，已有接受的租约，不首领也不续租。
    let edge = Edge::start(&srv.url, &path);
    let mut p = srv.accept().await;
    p.welcome().await;
    p.quiet().await;
    p.send(&config(91, "prj_91")).await;
    // 重封沿用已确认的回执，不再发送；租约仍可用，不领新租约。
    p.quiet().await;

    // 纯换池（同签发同方案的更高修订）：已接受的租约继续使用。
    p.apply_and_ack(&config(92, "prj_92")).await;
    p.quiet().await;
    assert_eq!(edge.store.accepted_pool_lease(&scope(&srv.url)).unwrap().unwrap().lease_id, "lse_91");

    // 签发变化：旧租约按原条款结清（逐型号报当前用量 0），收到后继。
    let mut resigned = config(93, "prj_93");
    resigned["route_pool"]["signature_id"] = json!("sig_13");
    p.apply_and_ack(&resigned).await;
    let renew = p.recv().await;
    assert_eq!(renew["type"], "lease_renew", "{renew}");
    assert_eq!((renew["lease_id"].as_str(), renew.get("release_only")), (Some("lse_91"), None));
    assert_eq!(renew["model_used_milli"], json!({"mdl_m":0}));
    let mut successor = lease(&renew["id"], "lse_93", 93, "prj_93");
    successor["signature_id"] = json!("sig_13");
    successor["settled_lease_id"] = json!("lse_91");
    p.send(&successor).await;
    assert_eq!(p.recv().await["ok"], true);
    assert_eq!(edge.store.pool_lease(&scope(&srv.url), "lse_91").unwrap().unwrap().state, PoolLeaseState::Settled);
    assert_eq!(edge.store.accepted_pool_lease(&scope(&srv.url)).unwrap().unwrap().lease_id, "lse_93");
    p.quiet().await;
    edge.stop().await;
}

/// 模型池流程中，残留的旧配置、旧密钥，以及隔离租约，都不能让真实模型入口访问上游。
#[tokio::test]
async fn test_lease_never_opens_the_real_model_entry() {
    // 假上游：只计数，任何请求都算违规。
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let app = axum::Router::new().fallback(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        async { "upstream must not be called" }
    });
    let up = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let up_addr = up.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(up, app).await.unwrap() });

    // 残留旧配置：直连路由、费率和旧密钥都在。
    let state = State { device_key: DeviceKey::from_bytes(DEVICE_SECRET), ..Default::default() };
    *state.config.write().unwrap() = ConfigSnapshot {
        revision: 1,
        routes: vec![Route {
            model: "*".into(),
            model_id: "mdl_1".into(),
            provider_id: "prv_1".into(),
            protocol: "anthropic".into(),
            base_url: format!("http://{up_addr}"),
            upstream_model: None,
            auth: UpstreamAuth::XApiKey,
            proxy: None,
        }],
        rates: vec![Rate {
            model_id: "mdl_1".into(),
            input_milli_per_mtok: 1,
            output_milli_per_mtok: 1,
            ..Default::default()
        }],
        ..Default::default()
    };
    state.secrets.write().unwrap().insert("prv_1".into(), "sk-legacy".into());

    let srv = FakeServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let edge = Edge::start_with_state(&srv.url, &store_path(&dir), state);
    let (usage_tx, _usage_rx) = tokio::sync::mpsc::unbounded_channel();
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    let router = Router::new(edge.state.clone(), "local".into(), http.clone(), usage_tx).app();
    let rl = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let router_addr = rl.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(rl, router).await.unwrap() });
    let call = |path: &str, body: Value| {
        http.post(format!("http://{router_addr}{path}"))
            .header("x-api-key", "local")
            .bearer_auth("local")
            .json(&body)
            .send()
    };
    let messages = json!({"model":"claude-x","max_tokens":10,"messages":[{"role":"user","content":"hi"}]});
    let responses = json!({"model":"model-m","input":"hi"});

    // 模型池连接建立前，残留旧配置照旧可用的情况不在本例；这里从连接后开始。
    let mut p = srv.accept().await;
    p.welcome().await;
    p.apply_and_ack(&config(91, "prj_91")).await;
    let request = p.expect_lease_request().await;
    p.send(&lease(&request["id"], "lse_91", 91, "prj_91")).await;
    p.recv().await;
    assert!(edge.store.accepted_pool_lease(&scope(&srv.url)).unwrap().is_some());

    for (path, body) in [("/v1/messages", &messages), ("/v1/responses", &responses)] {
        let r = call(path, body.clone()).await.unwrap();
        let status = r.status();
        let text = r.text().await.unwrap();
        assert_eq!(status, 403, "{path}: {text}");
        assert!(text.contains("模型池正在联验"), "{path}: {text}");
    }
    // 断线后（视图待同步）同样拒绝。
    drop(p);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(call("/v1/messages", messages.clone()).await.unwrap().status(), 403);
    assert_eq!(hits.load(Ordering::SeqCst), 0, "the upstream was reached");
    edge.stop().await;
}
