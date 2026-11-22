//! `route_pool.v1` 设备应用的隔离 WS 联验（`contracts/routing-projection.md`）。
//!
//! 假 Server 走真实 WebSocket，Edge 用隔离测试入口声明能力；应用库是真实 SQLite 文件，
//! "重启"是丢掉整个 State 和连接后用同一文件重新起 Edge。合成密钥仅用于测试。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use futures_util::{SinkExt, StreamExt};
use hkdf::Hkdf;
use onexd::outbox::Outbox;
use onexd::route_apply::{Fault, Scope, Store};
use onexd::secret::{DeviceKey, route_secret_aad};
use onexd::state::{RouteApply, State};
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

// ---------------------------------------------------------------------------
// 合成封装：与 Server 封装规则相同，每次新的发送方密钥和 nonce。
// ---------------------------------------------------------------------------

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

/// 按帧内身份为每个精确凭据引用重新封装一个信封。
fn reseal(frame: &mut Value) {
    let (tenant, device) = {
        let p = &frame["policy"];
        (p["tenant_id"].as_str().unwrap().to_owned(), p["device_id"].as_str().unwrap().to_owned())
    };
    let projection = frame["route_pool"]["projection_id"].as_str().unwrap().to_owned();
    let revision = frame["revision"].as_u64().unwrap();
    let mut refs: Vec<(String, u64)> = frame["routes"]
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
            let aad = route_secret_aad(&tenant, &device, &projection, revision, id, *version);
            let (key_id, nonce, ciphertext) = seal(&aad, &format!("key-{id}-{version}"));
            json!({"credential_id":id,"credential_version":version,"key_id":key_id,"nonce":nonce,"ciphertext":ciphertext})
        })
        .collect();
    frame["route_pool"]["secrets"] = json!(secrets);
}

/// 共用样例 v91 的配置，改成指定修订和投影后新封装；每次调用信封都不同（重封）。
fn config(revision: u64, projection: &str) -> Value {
    let mut f = fixture()["wire"]["config"].clone();
    f["id"] = json!(format!("cfg{revision}_{}", rand::random::<u32>()));
    f["revision"] = json!(revision);
    f["route_pool"]["projection_id"] = json!(projection);
    reseal(&mut f);
    f
}

// ---------------------------------------------------------------------------
// 假 Server
// ---------------------------------------------------------------------------

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

    /// 收 hello（必须声明 route_pool.v1），回样例 welcome。`server_time` 覆盖样例时间。
    async fn welcome(&mut self, user_id: &str, server_time: &str) {
        let hello = self.recv().await;
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["capabilities"], json!(["route_pool.v1"]), "{hello}");
        let mut w = fixture()["wire"]["welcome"].clone();
        w["re"] = hello["id"].clone();
        w["user_id"] = json!(user_id);
        w["server_time"] = json!(server_time);
        w["heartbeat_ms"] = json!(15000);
        self.send(&w).await;
    }

    async fn sample_welcome(&mut self) {
        self.welcome("usr_lin", "2026-11-22T02:00:00Z").await;
    }

    /// 发一帧 config，取回执。
    async fn apply(&mut self, frame: &Value) -> Value {
        self.send(frame).await;
        let r = self.recv().await;
        assert_eq!(r["type"], "config_applied", "config must not get a plain ACK: {r}");
        r
    }

    async fn ack(&mut self, re: &Value, ok: bool) {
        let mut a = json!({"type":"ack","re":re,"ok":ok});
        if !ok {
            a["error"] = json!({"code":"conflict","message":"x","detail":{"reason":"receipt_conflict"}});
        }
        self.send(&a).await;
    }
}

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------

struct Edge {
    state: Arc<State>,
    store: Arc<Store>,
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<()>,
    _outbox_dir: tempfile::TempDir,
}

impl Edge {
    /// 新进程：新 State、新连接，同一个应用库文件。
    fn start(url: &str, store_path: &Path) -> Self {
        let store = Arc::new(Store::open(store_path).unwrap());
        Self::start_with(url, store, "t")
    }

    fn start_with(url: &str, store: Arc<Store>, token: &str) -> Self {
        let outbox_dir = tempfile::tempdir().unwrap();
        let outbox = Arc::new(Outbox::open(&outbox_dir.path().join("outbox.sqlite")).unwrap());
        let state = Arc::new(State { device_key: DeviceKey::from_bytes(DEVICE_SECRET), ..Default::default() });
        state.replace_token(Some(token.into()));
        let mut o = WsOptions::new(url).with_route_pool_for_isolated_test(store.clone());
        o.backoff_min = Duration::from_millis(20);
        o.backoff_max = Duration::from_millis(100);
        o.connect_timeout = Duration::from_secs(2);
        let cancel = CancellationToken::new();
        let task = tokio::spawn(ws::run(o, state.clone(), outbox, cancel.clone()));
        Self { state, store, cancel, task, _outbox_dir: outbox_dir }
    }

    async fn stop(self) {
        self.cancel.cancel();
        timeout(T, self.task).await.unwrap().unwrap();
    }

    fn route(&self) -> RouteApply {
        self.state.route.read().unwrap().clone()
    }

    fn ready_revision(&self) -> Option<(u64, String)> {
        self.route().ready().map(|v| (v.identity.revision, v.identity.projection_id.clone()))
    }

    fn labels(&self) -> Vec<String> {
        self.state.route_labels().into_iter().map(|l| l.label).collect()
    }
}

fn scope(url: &str) -> Scope {
    Scope::new(url, "ten_demo", "usr_lin", "dev_lin").unwrap()
}

fn store_path(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().join("route_apply.sqlite")
}

async fn wait_until(what: &str, f: impl Fn() -> bool) {
    timeout(T, async {
        while !f() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
}

fn assert_applied(r: &Value, revision: u64, projection: &str) {
    assert_eq!(
        (
            r["result"].as_str(),
            r["config_revision"].as_u64(),
            r["projection_id"].as_str(),
            r["policy_revision"].as_u64()
        ),
        (Some("applied"), Some(revision), Some(projection), Some(21)),
        "{r}"
    );
    assert!(r.get("error").is_none(), "{r}");
    assert!(r["id"].as_str().is_some_and(|id| id.starts_with("msg_")), "{r}");
}

fn assert_rejected(r: &Value, code: &str, reason: &str) {
    assert_eq!(r["result"], "rejected", "{r}");
    assert_eq!(
        (r["error"]["code"].as_str(), r["error"]["detail"]["reason"].as_str()),
        (Some(code), Some(reason)),
        "{r}"
    );
    assert!(r["id"].as_str().is_some_and(|id| id.starts_with("cfr_")), "{r}");
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

/// E1/E6/E7：一次应用、通知一次、同版重封沿用原回执 ID，收到成功 ACK 后不再发送。
#[tokio::test]
async fn applies_once_and_replays_original_receipt_until_acked() {
    let srv = FakeServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let edge = Edge::start(&srv.url, &store_path(&dir));
    let mut p = srv.accept().await;
    p.sample_welcome().await;
    // 测试连接不领、不续租约。
    p.quiet().await;
    wait_until("pending sync", || matches!(edge.route(), RouteApply::PendingSync { applied: None, .. })).await;

    let first = config(91, "prj_91");
    let r = p.apply(&first).await;
    assert_applied(&r, 91, "prj_91");
    let receipt = r["id"].clone();
    p.quiet().await;
    assert_eq!(edge.ready_revision(), Some((91, "prj_91".into())));
    assert_eq!(edge.labels(), ["DeepSeek V4.1 Flash · 4×"]);
    {
        let route = edge.route();
        let view = route.ready().unwrap();
        assert_eq!(view.new_notice_ids, ["ntc_91"]);
        assert_eq!(view.new_notices()[0].title, "可用模型已更新");
        let cred = onex_core::route_pool::CredentialRef { credential_id: "cred_a".into(), credential_version: 1 };
        assert_eq!(view.key(&cred), Some("key-cred_a-1"));
        assert!(!format!("{view:?}").contains("key-cred_a-1"));
    }
    // 旧的 config 状态和旧密钥表不受影响。
    assert_eq!(edge.state.config_revision(), 0);
    assert!(edge.state.secrets.read().unwrap().is_empty());

    // 成功回执丢失：同身份重封、整帧重复，都用原 ID 重发，通知不再出现。
    for frame in [config(91, "prj_91"), first.clone()] {
        let again = p.apply(&frame).await;
        assert_eq!(again["id"], receipt, "{again}");
        assert_applied(&again, 91, "prj_91");
        assert!(edge.route().ready().unwrap().new_notice_ids.is_empty());
    }
    // 重封换了内存密钥。
    let cred = onex_core::route_pool::CredentialRef { credential_id: "cred_b".into(), credential_version: 2 };
    assert_eq!(edge.route().ready().unwrap().key(&cred), Some("key-cred_b-2"));

    // 成功 ACK 后，同身份重封只恢复视图，不再发送成功回执。
    p.ack(&receipt, true).await;
    p.send(&config(91, "prj_91")).await;
    p.quiet().await;
    assert_eq!(edge.ready_revision(), Some((91, "prj_91".into())));

    // 测试连接拒绝租约，不改租约状态。
    let before = edge.state.lease.status();
    p.send(
        &json!({"type":"lease","id":"ls1","lease_id":"lse_1","budget_milli":1000,"expires_at":"2026-11-22T03:00:00Z"}),
    )
    .await;
    let a = p.recv().await;
    assert_eq!((a["re"].as_str(), a["ok"].as_bool()), (Some("ls1"), Some(false)), "{a}");
    assert_eq!(
        (a["error"]["code"].as_str(), a["error"]["detail"]["reason"].as_str()),
        (Some("forbidden"), Some("route_pool_lease_pending"))
    );
    assert_eq!(edge.state.lease.status(), before);
    edge.stop().await;
}

/// E5/E6：重启进入待同步，没有本会话的合法重封前不执行、不发回执；重封后用原 ID 重发，ACK 后再重启不再发。
#[tokio::test]
async fn restart_waits_for_reseal_then_replays_persisted_receipt() {
    let srv = FakeServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let edge = Edge::start(&srv.url, &store_path(&dir));
    let mut p = srv.accept().await;
    p.sample_welcome().await;
    let receipt = p.apply(&config(91, "prj_91")).await["id"].clone();
    edge.stop().await;
    drop(p);

    let edge = Edge::start(&srv.url, &store_path(&dir));
    assert!(edge.route().ready().is_none(), "no view before this session authenticates");
    let mut p = srv.accept().await;
    p.sample_welcome().await;
    wait_until(
        "pending sync with persisted head",
        || matches!(edge.route(), RouteApply::PendingSync { applied: Some(ref a), .. } if a.revision == 91),
    )
    .await;
    p.quiet().await;
    assert!(edge.labels().is_empty(), "execution gate stays closed while pending sync");

    let r = p.apply(&config(91, "prj_91")).await;
    assert_eq!(r["id"], receipt);
    assert_eq!(edge.labels(), ["DeepSeek V4.1 Flash · 4×"]);
    assert!(edge.route().ready().unwrap().new_notice_ids.is_empty(), "notice already shown before restart");
    p.ack(&receipt, true).await;
    p.quiet().await;
    edge.stop().await;
    drop(p);

    let edge = Edge::start(&srv.url, &store_path(&dir));
    let mut p = srv.accept().await;
    p.sample_welcome().await;
    p.send(&config(91, "prj_91")).await;
    p.quiet().await;
    wait_until("ready after reseal", || edge.ready_revision().is_some()).await;
    edge.stop().await;
}

/// E4/E5/E15：提交前失败什么都不留；提交后、切换前失败保持待同步，Server 重发后用已持久的回执 ID。
#[tokio::test]
async fn crash_points_before_and_after_commit() {
    let srv = FakeServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let path = store_path(&dir);
    let edge = Edge::start(&srv.url, &path);
    let mut p = srv.accept().await;
    p.sample_welcome().await;

    edge.store.inject_fault(Fault::BeforeCommit);
    p.send(&config(91, "prj_91")).await;
    p.quiet().await;
    assert!(matches!(edge.route(), RouteApply::PendingSync { .. }));
    assert_eq!(edge.store.load(&scope(&srv.url)).unwrap(), None);
    assert!(edge.state.conn.lock().unwrap().last_error.as_ref().is_some_and(|(e, _)| e == "route_apply_store:commit"));
    let r = p.apply(&config(91, "prj_91")).await;
    assert_applied(&r, 91, "prj_91");
    p.ack(&r["id"], true).await;

    edge.store.inject_fault(Fault::AfterCommit);
    p.send(&config(92, "prj_92")).await;
    p.quiet().await;
    assert!(matches!(edge.route(), RouteApply::PendingSync { .. }), "no switch and no fallback to the old view");
    let pending = edge.store.pending_receipt(&scope(&srv.url), 92, "prj_92").unwrap().unwrap();
    edge.stop().await;
    drop(p);

    // 真正重开进程和文件后，同投影重封用已持久的回执 ID。
    let edge = Edge::start(&srv.url, &path);
    let mut p = srv.accept().await;
    p.sample_welcome().await;
    let r = p.apply(&config(92, "prj_92")).await;
    assert_eq!(r["id"].as_str(), Some(pending.id.as_str()));
    assert_eq!(edge.ready_revision(), Some((92, "prj_92".into())));
    edge.stop().await;
}

/// E3/E8/E13：冲突、较低修订、撤销倒退、缺凭据都不推进应用头；拒绝 ID 稳定；失败 ACK 保留回执等重发。
#[tokio::test]
async fn rejections_keep_applied_head_and_have_stable_ids() {
    let srv = FakeServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let edge = Edge::start(&srv.url, &store_path(&dir));
    let mut p = srv.accept().await;
    p.sample_welcome().await;
    let ok = p.apply(&config(91, "prj_91")).await;
    p.ack(&ok["id"], true).await;

    let mut changed_rate = config(91, "prj_91");
    changed_rate["rates"][0]["output_milli_per_mtok"] = json!(13000);
    let mut missing = config(92, "prj_92");
    missing["route_pool"]["secrets"].as_array_mut().unwrap().pop();
    let mut regressed = config(93, "prj_93");
    regressed["route_pool"]["revocation_revision"] = json!(2);
    reseal(&mut regressed);
    let mut wrong_device = config(94, "prj_94");
    wrong_device["policy"]["device_id"] = json!("dev_other");
    reseal(&mut wrong_device);
    let cases = [
        (config(91, "prj_other"), "conflict", "projection_mismatch"),
        (config(90, "prj_90"), "conflict", "stale_revision"),
        (changed_rate, "conflict", "content_changed"),
        (missing.clone(), "missing_route_credential", "missing_envelope"),
        (regressed, "invalid_config", "revocation_regressed"),
        (wrong_device, "invalid_config", "identity_mismatch"),
    ];
    for (frame, code, reason) in cases {
        let r = p.apply(&frame).await;
        assert_rejected(&r, code, reason);
        assert_eq!(edge.ready_revision(), Some((91, "prj_91".into())), "{reason}");
        assert_eq!(edge.store.load(&scope(&srv.url)).unwrap().unwrap().identity.revision, 91);
    }
    // 同目标同原因重发得到同一拒绝 ID；Server 可确认匹配目标的迟到拒绝。
    let first = p.apply(&missing).await;
    let mut resent = missing.clone();
    resent["id"] = json!("cfg92_resend");
    let second = p.apply(&resent).await;
    assert_eq!(first["id"], second["id"]);
    p.ack(&first["id"], true).await;
    p.quiet().await;
    assert_eq!(edge.ready_revision(), Some((91, "prj_91".into())));

    // 修好后的同目标得到另一个（成功）回执 ID；旧通知不再算新。
    let applied = p.apply(&config(92, "prj_92")).await;
    assert_applied(&applied, 92, "prj_92");
    assert_ne!(applied["id"], first["id"]);
    assert!(edge.route().ready().unwrap().new_notice_ids.is_empty());

    // 成功回执收到失败 ACK：本地记录保留，等 Server 重发同目标时用原 ID 再发。
    p.ack(&applied["id"], false).await;
    p.quiet().await;
    let pending = edge.store.pending_receipt(&scope(&srv.url), 92, "prj_92").unwrap().unwrap();
    assert_eq!(pending.last_failure.as_deref(), Some("conflict"));
    let again = p.apply(&config(92, "prj_92")).await;
    assert_eq!(again["id"], applied["id"]);
    edge.stop().await;
}

/// E9/E2：重启后先合法应用更高投影，旧的未确认成功回执停止发送，旧投影之后按较低修订拒绝。
#[tokio::test]
async fn higher_projection_supersedes_unrecovered_receipt() {
    let srv = FakeServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let edge = Edge::start(&srv.url, &store_path(&dir));
    let mut p = srv.accept().await;
    p.sample_welcome().await;
    p.apply(&config(91, "prj_91")).await;
    edge.stop().await;
    drop(p);

    let edge = Edge::start(&srv.url, &store_path(&dir));
    let mut p = srv.accept().await;
    p.sample_welcome().await;
    let r = p.apply(&config(95, "prj_95")).await;
    assert_applied(&r, 95, "prj_95");
    p.quiet().await;
    assert_eq!(edge.store.pending_receipt(&scope(&srv.url), 91, "prj_91").unwrap(), None);
    assert_rejected(&p.apply(&config(91, "prj_91")).await, "conflict", "stale_revision");
    assert_eq!(edge.ready_revision(), Some((95, "prj_95".into())));
    edge.stop().await;
}

/// E12：拿不到新版投影身份时只对原 config 回普通失败 ACK，不降级为旧协议确认。
#[tokio::test]
async fn missing_identity_gets_a_plain_failed_ack() {
    let srv = FakeServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let edge = Edge::start(&srv.url, &store_path(&dir));
    let mut p = srv.accept().await;
    p.sample_welcome().await;

    let mut legacy = config(91, "prj_91");
    legacy.as_object_mut().unwrap().remove("route_pool");
    legacy["id"] = json!("cfg_legacy");
    let mut no_policy_revision = config(91, "prj_91");
    no_policy_revision["policy"].as_object_mut().unwrap().remove("policy_revision");
    no_policy_revision["id"] = json!("cfg_no_policy");
    for (frame, id) in [(legacy, "cfg_legacy"), (no_policy_revision, "cfg_no_policy")] {
        p.send(&frame).await;
        let a = p.recv().await;
        assert_eq!(
            (a["type"].as_str(), a["re"].as_str(), a["ok"].as_bool()),
            (Some("ack"), Some(id), Some(false)),
            "{a}"
        );
        assert_eq!(a["error"]["detail"]["reason"], "projection_identity_unavailable");
    }
    // 已有身份但内容不完整：用新版拒绝回执，不用普通 ACK。
    let mut incomplete = config(91, "prj_91");
    incomplete["route_pool"].as_object_mut().unwrap().remove("bindings");
    assert_rejected(&p.apply(&incomplete).await, "invalid_config", "malformed");
    assert_eq!(edge.state.config_revision(), 0);
    assert!(edge.ready_revision().is_none());
    edge.stop().await;
}

/// E10：退出后旧投影立即封闭；新账号读不到旧作用域。
#[tokio::test]
async fn logout_closes_the_view_and_scopes_do_not_leak() {
    let srv = FakeServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&store_path(&dir)).unwrap());
    let edge = Edge::start_with(&srv.url, store.clone(), "t1");
    let mut p = srv.accept().await;
    p.sample_welcome().await;
    let r = p.apply(&config(91, "prj_91")).await;
    let generation = edge.state.generation();

    edge.state.replace_token(None);
    assert!(matches!(edge.route(), RouteApply::Closed));
    assert!(edge.labels().is_empty());
    assert!(edge.state.generation() > generation);
    // 旧连接结束；之后到来的帧不会被处理。
    let closed = timeout(T, async {
        loop {
            match p.ws.next().await {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                _ => continue,
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "old connection should end after logout");
    assert!(matches!(edge.route(), RouteApply::Closed));

    // 换成另一成员登录：作用域不同，看不到旧应用头和旧回执。
    edge.state.replace_token(Some("t2".into()));
    let mut p = srv.accept().await;
    p.welcome("usr_other", "2026-11-22T02:00:00Z").await;
    wait_until("pending sync for the new member", || {
        matches!(edge.route(), RouteApply::PendingSync { applied: None, .. })
    })
    .await;
    // 帧内身份仍是旧成员：不能在新登录下应用。
    assert_rejected(&p.apply(&config(91, "prj_91")).await, "invalid_config", "identity_mismatch");
    assert!(
        store
            .pending_receipt(&scope(&srv.url), 91, "prj_91")
            .unwrap()
            .is_some_and(|x| Some(x.id.as_str()) == r["id"].as_str())
    );
    edge.stop().await;
}

async fn seal_with_server() -> Value {
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut command = tokio::process::Command::new("bun");
    command.args(["--no-env-file", "tests/e2e/routing/seal-sample.ts"]).current_dir(checkout).kill_on_drop(true);
    let output = timeout(Duration::from_secs(10), command.output()).await.unwrap().expect("start Bun");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice::<Value>(&output.stdout).unwrap()["config"].clone()
}

/// 真实 Server 封装函数生成的两次信封：首次应用、重封沿用原回执 ID，密钥来自 Server 明文。
#[tokio::test]
async fn applies_and_reseals_server_sealed_envelopes() {
    let (initial, resealed) = (seal_with_server().await, seal_with_server().await);
    assert_ne!(initial["route_pool"]["secrets"], resealed["route_pool"]["secrets"]);
    let srv = FakeServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let edge = Edge::start(&srv.url, &store_path(&dir));
    let mut p = srv.accept().await;
    p.sample_welcome().await;
    let r = p.apply(&initial).await;
    assert_applied(&r, 91, "prj_91");
    assert_eq!(p.apply(&resealed).await["id"], r["id"]);
    let cred = onex_core::route_pool::CredentialRef { credential_id: "cred_b".into(), credential_version: 2 };
    assert_eq!(edge.route().ready().unwrap().key(&cred), Some("fixture-inference-key-b"));
    assert_eq!(edge.labels(), ["DeepSeek V4.1 Flash · 4×"]);
    edge.stop().await;
}

/// E11：本会话可信时间已过投影期限时不恢复执行。
#[tokio::test]
async fn expired_projection_is_not_restored() {
    let srv = FakeServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let edge = Edge::start(&srv.url, &store_path(&dir));
    let mut p = srv.accept().await;
    p.sample_welcome().await;
    p.apply(&config(91, "prj_91")).await;
    edge.stop().await;
    drop(p);

    let edge = Edge::start(&srv.url, &store_path(&dir));
    let mut p = srv.accept().await;
    p.welcome("usr_lin", "2026-11-22T02:10:00Z").await;
    assert_rejected(&p.apply(&config(91, "prj_91")).await, "invalid_config", "expired");
    assert!(edge.ready_revision().is_none());
    assert!(edge.labels().is_empty());
    edge.stop().await;
}
