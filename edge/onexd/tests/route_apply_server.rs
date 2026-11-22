//! 与 Server 隔离投影入口（`tests/e2e/routing/projection-server.ts`）的真实 WS 联验。
//!
//! 需要设置 `ONEX_PROJECTION_SERVER_CHECKOUT` 指向含该脚本的 Server 检出（已 `bun install`）；
//! 未设置时跳过。Server 进程只通过保存的子进程句柄结束。合成数据和 0x07 设备密钥，仅测试用。
//!
//!   ONEX_PROJECTION_SERVER_CHECKOUT=/path/to/server-checkout \
//!     cargo test -p onexd --test route_apply_server -- --nocapture
//!
//! 每一步打印一行 `EVIDENCE {...}`，作为联验记录。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use onexd::outbox::Outbox;
use onexd::route_apply::{Scope, Store};
use onexd::secret::DeviceKey;
use onexd::state::{RouteApply, State};
use onexd::ws::{self, WsOptions};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

const T: Duration = Duration::from_secs(15);

fn evidence(step: &str, detail: Value) {
    eprintln!("EVIDENCE {}", json!({"step": step, "detail": detail}));
}

struct Server {
    child: Child,
    info: Value,
}

impl Server {
    async fn start(checkout: &Path, data_dir: &Path, port: u16) -> Self {
        let mut child = Command::new("bun")
            .args([
                "--no-env-file",
                "tests/e2e/routing/projection-server.ts",
                "--port",
                &port.to_string(),
                "--data-dir",
            ])
            .arg(data_dir)
            .current_dir(checkout)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .expect("start bun");
        let stdout = child.stdout.take().unwrap();
        let mut line = String::new();
        timeout(T, BufReader::new(stdout).read_line(&mut line)).await.expect("server info line").unwrap();
        let info: Value = serde_json::from_str(&line).expect("server info is JSON");
        Self { child, info }
    }

    /// SIGTERM 到本句柄的 PID，等它按自身停止流程退出。
    async fn stop(mut self) {
        let pid = self.child.id().expect("server still running");
        let status = std::process::Command::new("kill").args(["-TERM", &pid.to_string()]).status().unwrap();
        assert!(status.success());
        let exit = timeout(T, self.child.wait()).await.expect("server exits").unwrap();
        assert!(exit.success(), "server exit {exit:?}");
    }

    async fn ledger(&self, index: usize) -> Value {
        let url = self.info["ledger"][index].as_str().unwrap();
        let session = self.info["platform_session"].as_str().unwrap();
        reqwest::Client::new().get(url).bearer_auth(session).send().await.unwrap().json().await.unwrap()
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
    fn start(url: &str, token: &str, key_hex: &str, store_path: &Path) -> Self {
        let bytes: [u8; 32] = (0..32)
            .map(|i| u8::from_str_radix(&key_hex[i * 2..i * 2 + 2], 16).unwrap())
            .collect::<Vec<_>>()
            .try_into()
            .unwrap();
        let store = Arc::new(Store::open(store_path).unwrap());
        let outbox_dir = tempfile::tempdir().unwrap();
        let outbox = Arc::new(Outbox::open(&outbox_dir.path().join("outbox.sqlite")).unwrap());
        let state = Arc::new(State { device_key: DeviceKey::from_bytes(bytes), ..Default::default() });
        state.replace_token(Some(token.into()));
        let mut o = WsOptions::new(url).with_route_pool_for_isolated_test(store.clone());
        o.backoff_min = Duration::from_millis(50);
        o.backoff_max = Duration::from_millis(300);
        o.connect_timeout = Duration::from_secs(3);
        let cancel = CancellationToken::new();
        let task = tokio::spawn(ws::run(o, state.clone(), outbox, cancel.clone()));
        Self { state, store, cancel, task, _outbox: outbox_dir }
    }

    async fn stop(self) {
        self.cancel.cancel();
        timeout(T, self.task).await.unwrap().unwrap();
    }

    fn ready(&self) -> Option<(u64, String)> {
        self.state.route.read().unwrap().ready().map(|v| (v.identity.revision, v.identity.projection_id.clone()))
    }
}

async fn wait_until(what: &str, f: impl Fn() -> bool) {
    timeout(T, async {
        while !f() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
}

async fn wait_ledger(server: &Server, index: usize, device: &str, state: &str) -> Value {
    let deadline = tokio::time::Instant::now() + T;
    loop {
        let ledger = server.ledger(index).await;
        let row = ledger["items"].as_array().unwrap().iter().find(|r| r["device_id"] == device).cloned();
        if let Some(row) = row.filter(|r| r["state"] == state) {
            return row;
        }
        assert!(tokio::time::Instant::now() < deadline, "ledger never showed {device} {state}: {ledger}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn checkout() -> Option<PathBuf> {
    let path = PathBuf::from(std::env::var_os("ONEX_PROJECTION_SERVER_CHECKOUT")?);
    assert!(
        path.join("tests/e2e/routing/projection-server.ts").exists(),
        "{} has no projection-server.ts",
        path.display()
    );
    Some(path)
}

/// 成功投影 → 回执 → Server ACK → 台账 applied；Server 重启重封重发；Edge 重启待同步后恢复；
/// 已确认的回执不再发送；固定 v6 设备只见 A。
#[tokio::test]
async fn joint_projection_receipt_ledger_and_reconnect() {
    let Some(checkout) = checkout() else {
        eprintln!("skipped: set ONEX_PROJECTION_SERVER_CHECKOUT to run the joint check");
        return;
    };
    let server_dir = tempfile::tempdir().unwrap();
    let edge_dir = tempfile::tempdir().unwrap();
    let store_path = edge_dir.path().join("route_apply.sqlite");
    let port = free_port();

    // 1. Server 首次启动，投影 rol_v7（dev_lin 91）和 rol_v6（dev_fix 92）。
    let server = Server::start(&checkout, server_dir.path(), port).await;
    let info = server.info.clone();
    let ws_url = info["ws_url"].as_str().unwrap().to_owned();
    let key_hex = info["device_private_key_hex"].as_str().unwrap().to_owned();
    let lin_token = info["devices"]["dev_lin"]["token"].as_str().unwrap().to_owned();
    let tenant = info["tenant_id"].as_str().unwrap().to_owned();
    let lin_user = info["devices"]["dev_lin"]["user_id"].as_str().unwrap().to_owned();
    evidence("server_started", json!({"ws_url": ws_url, "server_time": info["server_time"], "tenant_id": tenant}));
    let before = server.ledger(0).await;
    let row = before["items"].as_array().unwrap().iter().find(|r| r["device_id"] == "dev_lin").unwrap().clone();
    evidence("ledger_before_edge", row.clone());
    assert_eq!(row["target_config_revision"], 91);
    assert!(row["state"] != "applied", "{row}");

    // 2. 真实 onexd WS：应用 v91，发 config_applied，等 Server 的成功 ACK。
    let edge = Edge::start(&ws_url, &lin_token, &key_hex, &store_path);
    wait_until("edge applies v91", || edge.ready().is_some()).await;
    let scope = Scope::new(&ws_url, &tenant, &lin_user, "dev_lin").unwrap();
    let (revision, projection) = edge.ready().unwrap();
    let labels: Vec<String> = edge.state.route_labels().into_iter().map(|l| l.label).collect();
    let notices = edge.state.route.read().unwrap().ready().unwrap().new_notice_ids.clone();
    evidence(
        "edge_applied",
        json!({"config_revision": revision, "projection_id": projection, "labels": labels, "new_notices": notices}),
    );
    assert_eq!(revision, 91);
    assert_eq!(labels, ["DeepSeek V4.1 Flash · 4×"]);
    // Server 的 ACK 可能先于这里到达，所以从持久回执表读 ID，而不是抢在 ACK 之前采样。
    wait_until("server ack clears the pending receipt", || {
        edge.store.pending_receipt(&scope, 91, &projection).unwrap().is_none()
    })
    .await;
    let receipt_id =
        edge.store.applied_receipt_id(&scope, 91, &projection).unwrap().expect("success receipt persisted");
    assert!(receipt_id.starts_with("msg_"), "{receipt_id}");
    assert!(edge.store.receipt_acked(&scope, &receipt_id).unwrap());
    evidence("receipt_acked", json!({"receipt_id": receipt_id, "acked": true, "pending_after_ack": null}));
    let applied = wait_ledger(&server, 0, "dev_lin", "applied").await;
    evidence("ledger_after_ack", applied.clone());
    assert_eq!(
        (applied["target_config_revision"].as_u64(), applied["applied_config_revision"].as_u64()),
        (Some(91), Some(91))
    );
    let summary = reqwest::Client::new()
        .get(info["ledger"][0].as_str().unwrap().trim_end_matches("/targets"))
        .bearer_auth(info["platform_session"].as_str().unwrap())
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    evidence("rollout_summary", summary.clone());
    assert!(summary["counts"]["applied"].as_u64().unwrap() >= 1);

    // 3. Server 重启（同数据目录、同端口）：Edge 自动重连，收到重封；已确认的回执不再发送。
    server.stop().await;
    evidence("server_stopped", json!({}));
    let server = Server::start(&checkout, server_dir.path(), port).await;
    evidence("server_restarted", json!({"ws_url": server.info["ws_url"]}));
    let connects = edge.state.conn.lock().unwrap().connects;
    wait_until("edge reconnects", || edge.state.conn.lock().unwrap().connects > connects).await;
    wait_until("view ready after reseal", || edge.ready() == Some((91, projection.clone()))).await;
    assert!(edge.store.pending_receipt(&scope, 91, &projection).unwrap().is_none());
    let after_restart = wait_ledger(&server, 0, "dev_lin", "applied").await;
    evidence("ledger_after_server_restart", after_restart.clone());
    assert_eq!(after_restart["applied_config_revision"], 91);

    // 4. Edge 重启（新进程状态、同应用库）：先待同步，拿到本会话重封后恢复，无新回执。
    edge.stop().await;
    let edge = Edge::start(&ws_url, &lin_token, &key_hex, &store_path);
    wait_until("edge ready after its own restart", || edge.ready() == Some((91, projection.clone()))).await;
    let notices_after = edge.state.route.read().unwrap().ready().unwrap().new_notice_ids.clone();
    let pending_after = edge.store.pending_receipt(&scope, 91, &projection).unwrap().map(|p| p.id);
    evidence(
        "edge_restarted_and_restored",
        json!({"ready": edge.ready(), "new_notices": notices_after, "pending_receipt": pending_after}),
    );
    assert!(notices_after.is_empty(), "notice shown once only");
    assert!(edge.store.pending_receipt(&scope, 91, &projection).unwrap().is_none());
    assert_eq!(wait_ledger(&server, 0, "dev_lin", "applied").await["applied_config_revision"], 91);

    // 5. 测试连接不领租约。
    assert!(edge.state.lease.lease_id().is_none());
    evidence("lease_untouched", edge.state.lease.status());
    edge.stop().await;

    // 6. 固定 v6 设备（dev_fix，92）：只见 A，台账 applied。
    let fix_token = server.info["devices"]["dev_fix"]["token"].as_str().unwrap().to_owned();
    let fix_store = edge_dir.path().join("route_apply_fix.sqlite");
    let fix = Edge::start(&ws_url, &fix_token, &key_hex, &fix_store);
    wait_until("dev_fix applies v92", || fix.ready().is_some()).await;
    let deployments: Vec<String> = {
        let route = fix.state.route.read().unwrap();
        route.ready().unwrap().config.routes.iter().map(|r| r.deployment_id.clone()).collect()
    };
    evidence("pinned_v6_applied", json!({"ready": fix.ready(), "deployments": deployments}));
    assert_eq!(deployments, ["dep_a"]);
    let fixed = wait_ledger(&server, 1, "dev_fix", "applied").await;
    evidence("ledger_pinned_v6", fixed.clone());
    assert_eq!(fixed["applied_config_revision"], 92);
    assert!(matches!(*fix.state.route.read().unwrap(), RouteApply::Ready(_)));
    fix.stop().await;
    server.stop().await;
}
