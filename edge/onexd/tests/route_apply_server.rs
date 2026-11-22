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
use onexd::route_apply::{PoolLeaseState, Scope, Store};
use onexd::router::Router;
use onexd::secret::DeviceKey;
use onexd::state::{LaunchBinding, RouteApply, State};
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
    async fn start(checkout: &Path, data_dir: &Path, port: u16, lease_gate: bool) -> Self {
        let mut command = Command::new("bun");
        command
            .args([
                "--no-env-file",
                "tests/e2e/routing/projection-server.ts",
                "--port",
                &port.to_string(),
                "--data-dir",
            ])
            .arg(data_dir);
        if lease_gate {
            command.arg("--lease-gate");
        }
        Self::spawn(checkout, command).await
    }

    async fn start_one_chain(checkout: &Path, data_dir: &Path, primary_offline: bool) -> Self {
        let mut command = Command::new("bun");
        command.args(["--no-env-file", "tests/e2e/routing/one-chain-server.ts", "--data-dir"]).arg(data_dir);
        if primary_offline {
            command.arg("--primary-offline");
        }
        Self::spawn(checkout, command).await
    }

    async fn spawn(checkout: &Path, mut command: Command) -> Self {
        let mut child = command
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
        loopback_client()
            .get(url)
            .bearer_auth(session)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
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
    fn start(url: &str, token: &str, key_hex: &str, store_path: &Path, lease_gate: bool) -> Self {
        Self::start_with_execution(url, token, key_hex, store_path, lease_gate, false)
    }

    fn start_with_execution(
        url: &str,
        token: &str,
        key_hex: &str,
        store_path: &Path,
        lease_gate: bool,
        execution: bool,
    ) -> Self {
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
        if lease_gate {
            o = o.with_route_pool_leases_for_isolated_test();
        }
        if execution {
            o = o.with_route_pool_execution_for_isolated_test();
        }
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

fn loopback_client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().timeout(T).build().unwrap()
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
    let server = Server::start(&checkout, server_dir.path(), port, false).await;
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
    let edge = Edge::start(&ws_url, &lin_token, &key_hex, &store_path, false);
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
    let summary = loopback_client()
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
    let server = Server::start(&checkout, server_dir.path(), port, false).await;
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
    let edge = Edge::start(&ws_url, &lin_token, &key_hex, &store_path, false);
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
    let fix = Edge::start(&ws_url, &fix_token, &key_hex, &fix_store, false);
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

/// 租约门禁（`--lease-gate`）：applied ACK 之后首领，精确绑定 91/prj_91；Edge 重启后等同投影
/// 重封才恢复，已接受租约沿用，不再首领；固定 v6 设备的首领绑定 92/prj_92；隔离租约不进生产
/// Ledger，真实模型入口拒绝。
#[tokio::test]
async fn joint_lease_gate_first_lease_and_restart() {
    let Some(checkout) = checkout() else {
        eprintln!("skipped: set ONEX_PROJECTION_SERVER_CHECKOUT to run the joint check");
        return;
    };
    let server_dir = tempfile::tempdir().unwrap();
    let edge_dir = tempfile::tempdir().unwrap();
    let store_path = edge_dir.path().join("route_apply.sqlite");
    let server = Server::start(&checkout, server_dir.path(), free_port(), true).await;
    let info = server.info.clone();
    evidence("lease_gate_server_started", json!({"lease_gate": info["lease_gate"], "ws_url": info["ws_url"]}));
    assert_eq!(info["lease_gate"], true, "projection-server.ts must report lease_gate:true");
    let ws_url = info["ws_url"].as_str().unwrap().to_owned();
    let key_hex = info["device_private_key_hex"].as_str().unwrap().to_owned();
    let token = info["devices"]["dev_lin"]["token"].as_str().unwrap().to_owned();
    let scope = Scope::new(
        &ws_url,
        info["tenant_id"].as_str().unwrap(),
        info["devices"]["dev_lin"]["user_id"].as_str().unwrap(),
        "dev_lin",
    )
    .unwrap();

    let edge = Edge::start(&ws_url, &token, &key_hex, &store_path, true);
    wait_until("dev_lin accepts the first isolated lease", || {
        edge.store.accepted_pool_lease(&scope).unwrap().is_some()
    })
    .await;
    let held = edge.store.accepted_pool_lease(&scope).unwrap().unwrap();
    evidence(
        "first_lease_accepted",
        json!({"lease_id": held.lease_id, "config_revision": held.config_revision, "projection_id": held.projection_id,
            "signature_id": held.signature_id, "commerce_plan_id": held.commerce_plan_id,
            "budget_milli": held.budget_milli, "model_budgets": held.model_budgets,
            "view": edge.ready(), "production_ledger_lease": edge.state.lease.lease_id()}),
    );
    assert_eq!(Some((held.config_revision, held.projection_id.clone())), edge.ready());
    assert!(edge.state.lease.lease_id().is_none(), "isolated leases never enter the production Ledger");
    assert!(edge.state.route_pool_engaged(), "the real model entry stays closed");

    // Edge 重启：同一隔离存储；等同投影重封恢复，已接受租约沿用，不再首领。
    edge.stop().await;
    let edge = Edge::start(&ws_url, &token, &key_hex, &store_path, true);
    wait_until("view restored after reseal", || edge.ready().is_some()).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let after = edge.store.accepted_pool_lease(&scope).unwrap().unwrap();
    evidence(
        "restart_keeps_lease",
        json!({"lease_id": after.lease_id, "view": edge.ready(),
            "pending_ops": edge.store.pending_pool_ops(&scope).unwrap().len()}),
    );
    assert_eq!(after.lease_id, held.lease_id);
    assert!(edge.store.pending_pool_ops(&scope).unwrap().is_empty());
    edge.stop().await;

    // 固定 v6 设备：首领绑定 92/prj_92。
    let fix_token = info["devices"]["dev_fix"]["token"].as_str().unwrap().to_owned();
    let fix_scope = Scope::new(
        &ws_url,
        info["tenant_id"].as_str().unwrap(),
        info["devices"]["dev_fix"]["user_id"].as_str().unwrap(),
        "dev_fix",
    )
    .unwrap();
    let fix = Edge::start(&ws_url, &fix_token, &key_hex, &edge_dir.path().join("fix.sqlite"), true);
    wait_until("dev_fix accepts its lease", || fix.store.accepted_pool_lease(&fix_scope).unwrap().is_some()).await;
    let fixed = fix.store.accepted_pool_lease(&fix_scope).unwrap().unwrap();
    evidence(
        "pinned_v6_lease",
        json!({"lease_id": fixed.lease_id, "config_revision": fixed.config_revision, "projection_id": fixed.projection_id}),
    );
    assert_eq!((fixed.config_revision, fixed.projection_id.as_str()), (92, "prj_92"));
    assert_ne!(fixed.lease_id, held.lease_id);
    fix.stop().await;
    server.stop().await;
}

/// 平台经真实 HTTP 配渠道、签发、充值，Edge 经真实 WS 获取模型池和租约。
/// 本地原生 Responses 请求用上游终态用量结算，并核对供应商与租户两边台账。
#[tokio::test]
async fn signed_pool_native_responses_settles_both_ledgers() {
    run_signed_pool_responses(false).await;
}

#[tokio::test]
async fn signed_pool_falls_back_only_after_primary_refuses_connection() {
    run_signed_pool_responses(true).await;
}

async fn run_signed_pool_responses(primary_offline: bool) {
    let Some(checkout) = std::env::var_os("ONEX_ONE_CHAIN_SERVER_CHECKOUT").map(PathBuf::from) else {
        eprintln!("skipped: set ONEX_ONE_CHAIN_SERVER_CHECKOUT to run the signed pool chain");
        return;
    };
    let server_dir = tempfile::tempdir().unwrap();
    let server = Server::start_one_chain(&checkout, server_dir.path(), primary_offline).await;
    let info = &server.info;
    let value = |field: &str| info[field].as_str().unwrap();
    let scope = Scope::new(value("ws_url"), value("tenant_id"), value("user_id"), value("device_id")).unwrap();
    let edge_dir = tempfile::tempdir().unwrap();
    let edge = Edge::start_with_execution(
        value("ws_url"),
        value("device_token"),
        value("device_private_key_hex"),
        &edge_dir.path().join("route_apply.sqlite"),
        true,
        true,
    );
    wait_until("signed pool lease", || edge.store.accepted_pool_lease(&scope).unwrap().is_some()).await;
    let lease = edge.store.accepted_pool_lease(&scope).unwrap().unwrap();
    assert_eq!(lease.config_revision, info["config_revision"].as_u64().unwrap());
    assert_eq!(lease.projection_id, value("projection_id"));
    let model = value("model_id");
    let view = edge.state.route.read().unwrap().ready().unwrap().clone();
    let binding = view.config.route_pool.bindings.iter().find(|b| b.model_id == model).unwrap();
    assert_eq!(binding.deployment_ids.len(), 2);
    let rate = &info["signed_rate"]["rate_version_id"];
    let release_id = binding.agent_release_id.clone();
    let token = "one-chain-native-launch";
    edge.state.launch_tokens.write().unwrap().insert(
        token.into(),
        LaunchBinding {
            session_id: "ses_one_chain".into(),
            agent: "codex".into(),
            release_id: Some(release_id),
            approved_model: Some(model.into()),
            first_native_session: None,
        },
    );
    let http = loopback_client();
    let (usage, _legacy_usage) = tokio::sync::mpsc::unbounded_channel();
    let router = Router::new(edge.state.clone(), "separate-local-token".into(), http.clone(), usage)
        .with_isolated_pool_execution(edge.store.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = listener.local_addr().unwrap();
    let http_task = tokio::spawn(async move { axum::serve(listener, router.app()).await.unwrap() });
    let answer = http
        .post(format!("http://{local}/v1/responses"))
        .bearer_auth(token)
        .json(&json!({"model": model, "input": "loopback e2e", "max_output_tokens": 2048, "stream": false}))
        .send()
        .await
        .unwrap();
    let status = answer.status();
    let answer: Value = answer.json().await.unwrap();
    assert_eq!(status, reqwest::StatusCode::OK, "native response: {answer}");
    let selected_vendor = if primary_offline { "vendor-b" } else { "vendor-a" };
    assert!(answer["model"].as_str().unwrap().starts_with(selected_vendor));
    assert_eq!(answer["usage"]["input_tokens"], 10_000);
    assert_eq!(answer["usage"]["output_tokens"], 2_000);

    wait_until("metered lease settlement", || {
        edge.store.pool_lease(&scope, &lease.lease_id).unwrap().unwrap().state == PoolLeaseState::Settled
    })
    .await;
    let (seq, receipt, acked) = edge.store.isolated_usage_for_lease(&scope, &lease.lease_id).unwrap().unwrap();
    let receipt = receipt.unwrap();
    assert!(acked);
    assert_eq!(seq, Some(1));
    assert_eq!(receipt["lease_id"], lease.lease_id);
    assert_eq!(receipt["rate_version_id"], *rate);
    assert_eq!(receipt["projection_id"], lease.projection_id);
    assert_eq!(receipt["measurement_basis"], "upstream_usage");
    assert_eq!(receipt["cost_milli"], 64);
    let primary = value("primary_deployment_id");
    let backup = value("backup_deployment_id");
    let selected = if primary_offline { backup } else { primary };
    assert_eq!(receipt["deployment_id"], selected);
    let outcomes = if primary_offline {
        vec![(primary, "connect_refused"), (backup, "completed")]
    } else {
        vec![(primary, "completed")]
    };
    let attempts = receipt["attempts"].as_array().unwrap();
    assert_eq!(attempts.len(), outcomes.len());
    assert_eq!(attempts.last().unwrap()["attempt_id"], receipt["attempt_id"]);

    let db = rusqlite::Connection::open_with_flags(
        server_dir.path().join(format!("tenant-{}.sqlite", value("tenant_id"))),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let (charge_count, charges): (i64, i64) = db
        .query_row(
            "SELECT count(*),sum(amount_milli) FROM ledger WHERE kind='settle' AND lease_id=?1",
            [&lease.lease_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((charge_count, charges), (1, 64));
    let expected_fields = [
        receipt["request_id"].as_str().unwrap(),
        receipt["attempt_id"].as_str().unwrap(),
        &lease.projection_id,
        receipt["deployment_id"].as_str().unwrap(),
        rate.as_str().unwrap(),
    ];
    let runtime_rows: (i64, i64) = db.query_row(
        "SELECT count(*),coalesce(sum(u.cost_milli),0) FROM route_runtime_usage r JOIN usage u USING(device_id,seq)
          WHERE r.request_id=?1 AND r.attempt_id=?2 AND r.projection_id=?3 AND r.deployment_id=?4 AND r.rate_version_id=?5
            AND r.procurement_state='posted' AND u.settlement_status='reconciled'
            AND json_extract(r.procurement_json,'$.amount_cny_micro')='50000'
            AND u.input_tokens=10000 AND u.output_tokens=2000",
        expected_fields, |row| Ok((row.get(0)?,row.get(1)?)),
    ).unwrap();
    assert_eq!(runtime_rows, (1, 64));
    let mut statement = db
        .prepare(
            "SELECT attempt_id,deployment_id,outcome FROM route_runtime_attempts
      WHERE device_id=?1 AND seq=?2 ORDER BY ordinal",
        )
        .unwrap();
    let stored = statement
        .query_map((&scope.device_id, seq.unwrap()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(stored.len(), outcomes.len());
    for ((record, (deployment, outcome)), wire) in stored.iter().zip(outcomes).zip(attempts) {
        assert_eq!(record.0, wire["attempt_id"]);
        assert_eq!((record.1.as_str(), record.2.as_str()), (deployment, outcome));
    }

    let supplier_debit = if primary_offline { 6_667 } else { 50_000 };
    let selected_wallet_balance = 3_250_000 - supplier_debit;
    for (field, chosen, currency) in
        [("origin_channel", !primary_offline, "CNY"), ("backup_channel", primary_offline, "USD")]
    {
        let wallet: Value = http
            .get(format!("{}/v1{}", value("http_url"), value(field)))
            .bearer_auth(value("platform_session"))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        let expenses = wallet["items"].as_array().unwrap().iter().filter(|item| item["kind"] == "expense").count();
        assert_eq!(expenses, usize::from(chosen));
        assert_eq!(wallet["accounts"][0]["currency"], currency);
        assert_eq!(wallet["accounts"][0]["spent_micro"], if chosen { supplier_debit } else { 0 });
        assert_eq!(wallet["accounts"][0]["balance_micro"], if chosen { selected_wallet_balance } else { 3_250_000 });
    }
    evidence(
        "native_responses_channel_and_tenant_charged",
        json!({
            "lease_id": lease.lease_id, "projection_id": lease.projection_id, "request_id": receipt["request_id"],
            "attempt_id": receipt["attempt_id"], "rate_version_id": receipt["rate_version_id"],
            "provider_id": receipt["provider_id"], "deployment_id": receipt["deployment_id"],
            "deployment_revision": receipt["deployment_revision"], "signed_pool": info["signed_pool"],
            "input_tokens": 10_000, "output_tokens": 2_000, "tenant_debit_milli": charges,
            "primary_offline": primary_offline, "attempts": attempts,
            "supplier_debit_micro": supplier_debit, "supplier_amount_cny_micro": 50_000,
            "supplier_balance_micro": selected_wallet_balance,
        }),
    );
    http_task.abort();
    edge.stop().await;
    server.stop().await;
}
