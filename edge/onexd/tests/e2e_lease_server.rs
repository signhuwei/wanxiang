//! 跨进程：真实 Server（`tests/e2e/lease-server.ts`，Bun）+ Edge 之间的 WS 中间人。
//! 场景（magpie S1-E2 阻塞 2）：续租 Server 已提交 → 回包丢失 → 断线期间继续消费 → Edge 重启 → 回连。
//! 期望：Edge 原样重放同一 op_id，Server 回缓存的新租约，不报 conflict；Server 流水只结算快照金额一次；
//! 快照之后的消费记在新租约下。
//! 运行需要 PATH 中的 Bun 和已安装的 server 依赖。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use onexd::lease::{LeaseOptions, Ledger};
use onexd::outbox::Outbox;
use onexd::state::State;
use onexd::ws::{self, WsOptions};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::time::{sleep, timeout};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderMap;
use tokio_util::sync::CancellationToken;

const T: Duration = Duration::from_secs(10);

struct Fixture {
    /// kill_on_drop：测试结束时结束 Bun 进程
    _child: Child,
    port: u16,
    tenant_id: String,
    device_id: String,
    device_token: String,
    data_dir: PathBuf,
}

async fn start_server(dir: &Path) -> Fixture {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut child = Command::new("bun")
        .arg("tests/e2e/lease-server.ts")
        .arg(dir)
        // 本用例不经过 router，假上游地址只用来满足夹具参数
        .arg("http://127.0.0.1:9")
        .current_dir(&root)
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("start the real lease test server (Bun must be installed and on PATH)");
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let line = timeout(T, lines.next_line()).await.expect("fixture start timeout").unwrap().expect("fixture exited");
    let v: Value = serde_json::from_str(&line).unwrap();
    let s = |k: &str| v[k].as_str().unwrap().to_string();
    Fixture {
        port: v["port"].as_u64().unwrap() as u16,
        tenant_id: s("tenant_id"),
        device_id: s("device_id"),
        device_token: s("device_token"),
        data_dir: PathBuf::from(s("data_dir")),
        _child: child,
    }
}

impl Fixture {
    fn db(&self) -> rusqlite::Connection {
        let p = self.data_dir.join(format!("tenant-{}.sqlite", self.tenant_id));
        rusqlite::Connection::open_with_flags(p, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
    }

    /// (amount_milli, request_ref) 的列表
    fn settles(&self, lease_id: &str) -> Vec<(i64, String)> {
        let db = self.db();
        let mut st = db
            .prepare(
                "SELECT kind, amount_milli, lease_id, request_ref FROM ledger WHERE kind = 'settle' AND lease_id = ?",
            )
            .unwrap();
        st.query_map([lease_id], |r| Ok((r.get::<_, i64>(1)?, r.get::<_, String>(3)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    /// 最新签发的租约 (id, budget_milli, seq)
    fn newest_lease(&self) -> (String, i64, i64) {
        self.db()
            .query_row(
                "SELECT id, budget_milli, expires_at, seq FROM leases WHERE device_id = ? ORDER BY seq DESC LIMIT 1",
                [&self.device_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(3)?)),
            )
            .unwrap()
    }
}

/// Edge ↔ Server 的 WS 中间人。`drop_renew_reply` 置位时，丢掉下一条回应续租的 lease（带 `re`），
/// 并断开两侧连接，把被丢掉的 lease_id 发到 `dropped`。
struct Proxy {
    url: String,
    drop_renew_reply: Arc<AtomicBool>,
    dropped: mpsc::UnboundedReceiver<String>,
    /// Edge 发出的 lease_renew
    renews: mpsc::UnboundedReceiver<Value>,
}

async fn start_proxy(server_port: u16) -> Proxy {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/v1/edge/ws", l.local_addr().unwrap());
    let flag = Arc::new(AtomicBool::new(false));
    let (dtx, dropped) = mpsc::unbounded_channel();
    let (rtx, renews) = mpsc::unbounded_channel();
    let f = flag.clone();
    tokio::spawn(async move {
        loop {
            let (s, _) = l.accept().await.unwrap();
            let hdrs: Arc<Mutex<HeaderMap>> = Arc::default();
            let h = hdrs.clone();
            let Ok(edge) = tokio_tungstenite::accept_hdr_async(
                s,
                move |req: &tokio_tungstenite::tungstenite::handshake::server::Request, resp| {
                    *h.lock().unwrap() = req.headers().clone();
                    Ok(resp)
                },
            )
            .await
            else {
                continue;
            };
            let mut req = format!("ws://127.0.0.1:{server_port}/v1/edge/ws").into_client_request().unwrap();
            for k in ["authorization", "onex-edge-version", "onex-protocol"] {
                if let Some(v) = hdrs.lock().unwrap().get(k) {
                    req.headers_mut().insert(k, v.clone());
                }
            }
            let Ok((server, _)) = tokio_tungstenite::connect_async(req).await else { continue };
            let (f, dtx, rtx) = (f.clone(), dtx.clone(), rtx.clone());
            tokio::spawn(async move {
                let (mut etx, mut erx) = edge.split();
                let (mut stx, mut srx) = server.split();
                loop {
                    tokio::select! {
                        m = erx.next() => {
                            let Some(Ok(m)) = m else { break };
                            if let Ok(v) = serde_json::from_str::<Value>(m.to_text().unwrap_or("")) {
                                if v["type"] == "lease_renew" {
                                    let _ = rtx.send(v);
                                }
                            }
                            if stx.send(m).await.is_err() { break }
                        }
                        m = srx.next() => {
                            let Some(Ok(m)) = m else { break };
                            if let Ok(v) = serde_json::from_str::<Value>(m.to_text().unwrap_or("")) {
                                if v["type"] == "lease" && !v["re"].is_null() && f.swap(false, Ordering::SeqCst) {
                                    let _ = dtx.send(v["lease_id"].as_str().unwrap().to_string());
                                    break;
                                }
                            }
                            if etx.send(m).await.is_err() { break }
                        }
                    }
                }
                // 两侧都直接断开，Edge 收不到回应
                drop((etx, erx, stx, srx));
            });
        }
    });
    Proxy { url, drop_renew_reply: flag, dropped, renews }
}

struct Edge {
    state: Arc<State>,
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

fn start_edge(home: &Path, url: &str, token: &str, backoff: Duration) -> Edge {
    let outbox = Arc::new(Outbox::open(&home.join("outbox.sqlite")).unwrap());
    let lease = Arc::new(Ledger::open(home.join("lease.json"), LeaseOptions::default(), &outbox).unwrap());
    tokio::spawn(lease.clone().run(CancellationToken::new()));
    let state = Arc::new(State { lease, ..Default::default() });
    state.token.send_replace(Some(token.into()));
    let mut o = WsOptions::new(url);
    o.backoff_min = backoff;
    o.backoff_max = backoff;
    let cancel = CancellationToken::new();
    let task = tokio::spawn(ws::run(o, state.clone(), outbox, cancel.clone()));
    Edge { state, cancel, task }
}

impl Edge {
    async fn stop(self) {
        self.cancel.cancel();
        timeout(T, self.task).await.unwrap().unwrap();
    }
}

async fn wait_for(mut f: impl FnMut() -> bool) {
    timeout(T, async {
        while !f() {
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("condition not reached");
}

#[tokio::test]
async fn committed_renew_with_lost_reply_settles_once_across_restart() {
    let srv_dir = tempfile::tempdir().unwrap();
    let srv = start_server(srv_dir.path()).await;
    let mut proxy = start_proxy(srv.port).await;
    let home = tempfile::tempdir().unwrap();

    // 第一次运行：拿初始租约（夹具上限 100）
    let edge = start_edge(home.path(), &proxy.url, &srv.device_token, Duration::from_secs(30));
    wait_for(|| edge.state.lease.lease_id().is_some()).await;
    let l1 = edge.state.lease.lease_id().unwrap();
    assert_eq!(edge.state.lease.snapshot().lease.unwrap().budget_milli, 100);

    // 已用 80 触发续租；Server 提交后回包被丢
    proxy.drop_renew_reply.store(true, Ordering::SeqCst);
    edge.state.lease.admit(0).unwrap().finish(80);
    let r1 = timeout(T, proxy.renews.recv()).await.unwrap().unwrap();
    assert_eq!((r1["used_milli"].as_i64(), r1["op_id"].as_str()), (Some(80), Some(format!("{l1}:80").as_str())));
    let l2 = timeout(T, proxy.dropped.recv()).await.unwrap().unwrap();
    assert_ne!(l2, l1);
    assert_eq!(srv.settles(&l1), vec![(80, format!("{l1}:80"))]);
    assert_eq!(srv.newest_lease().0, l2);

    // Edge 没收到新租约，仍在 l1 上；断线期间又花了 5，然后重启
    let ledger = edge.state.lease.clone();
    edge.stop().await;
    assert_eq!(ledger.lease_id().as_deref(), Some(l1.as_str()));
    ledger.admit(0).unwrap().finish(5);
    drop(ledger);

    let edge = start_edge(home.path(), &proxy.url, &srv.device_token, Duration::from_millis(50));
    let r2 = timeout(T, proxy.renews.recv()).await.unwrap().unwrap();
    // 原样重放：同一 op_id、同一金额（不是 85）
    assert_eq!((r2["used_milli"].as_i64(), r2["op_id"].as_str()), (Some(80), r1["op_id"].as_str()));
    wait_for(|| edge.state.lease.lease_id().as_deref() == Some(l2.as_str())).await;

    // Server 只结算一次；Edge 拿到的是 Server 已签发的那份；快照之后的 5 记到新租约
    assert_eq!(srv.settles(&l1), vec![(80, format!("{l1}:80"))]);
    let (newest, budget, _) = srv.newest_lease();
    assert_eq!(newest, l2);
    let s = edge.state.lease.snapshot();
    assert_eq!((s.used_milli, s.inflight_milli, s.lease.unwrap().budget_milli), (5, 0, budget));
    let st = edge.state.lease.status();
    assert_eq!((st["state"].as_str(), st["renew"]["pending"].as_bool()), (Some("active"), Some(false)));
    assert_eq!(st["renew"]["last_result"], "granted");
    edge.stop().await;
}
