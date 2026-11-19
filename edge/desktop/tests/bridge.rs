//! `Bridge` 的状态机测试：真实临时 onexd daemon（同 edge/onexd/tests/ipc.rs 的手法）+
//! 假 Server（axum），不碰真实 Server、真实上游或真实钥匙串服务名。

use std::sync::{Arc, Mutex};

use axum::Json;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::post;
use onex_desktop::bridge::{Bridge, Op};
use onexd::ipc::{self, Ipc};
use onexd::outbox::Outbox;
use onexd::state::State;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

/// 启动一个临时 onexd IPC（不连真实 WS、不起 router），返回 Bridge 和清理守卫。
async fn test_daemon(server_url: Option<String>) -> (Bridge, tempfile::TempDir, tokio::task::JoinHandle<()>) {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("onexd.sock");
    let outbox = Arc::new(Outbox::open(&dir.path().join("o.sqlite")).unwrap());
    let state = Arc::new(State::default());
    let shutdown = CancellationToken::new();
    let listener = ipc::bind(&sock).await.unwrap();
    let srv = Arc::new(Ipc {
        state,
        outbox,
        router_addr: Some("127.0.0.1:1".into()),
        server_url,
        launch: None,
        credentials: None,
        identity_transition: Default::default(),
        shutdown: shutdown.clone(),
    });
    let task = tokio::spawn(ipc::serve(listener, sock.clone(), srv));
    (Bridge::new(sock), dir, task)
}

#[derive(Default)]
struct Seen {
    calls: Vec<(String, Value)>,
}

/// 假 Server：固定验证码 123456，支持单租户/多租户两种开关。
async fn fake_server(two_tenants: bool) -> (String, Arc<Mutex<Seen>>) {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let rec = |path: &'static str, s: Arc<Mutex<Seen>>| {
        move |Json(b): Json<Value>| {
            let s = s.clone();
            async move {
                s.lock().unwrap().calls.push((path.into(), b.clone()));
                match path {
                    "/v1/auth/code" => StatusCode::ACCEPTED.into_response(),
                    "/v1/auth/login" if b["code"] != "123456" => {
                        (StatusCode::UNAUTHORIZED, Json(json!({"error":{"code":"unauthenticated","message":"错误"}})))
                            .into_response()
                    }
                    "/v1/auth/login" => {
                        let mut tenants = vec![json!({"id":"ten_a","name":"甲公司"})];
                        if two_tenants {
                            tenants.push(json!({"id":"ten_b","name":"乙公司"}));
                        }
                        Json(json!({"token":"global","user":{"name":"示例员工"},"tenants":tenants})).into_response()
                    }
                    "/v1/auth/select-tenant" => {
                        Json(json!({"token": format!("scoped_{}", b["tenant_id"].as_str().unwrap())})).into_response()
                    }
                    "/v1/devices" => {
                        (StatusCode::CREATED, Json(json!({"device_id":"dev_1","device_token":"dtok"}))).into_response()
                    }
                    _ => StatusCode::NO_CONTENT.into_response(),
                }
            }
        }
    };
    let mut app = axum::Router::new();
    for p in ["/v1/auth/code", "/v1/auth/login", "/v1/auth/select-tenant", "/v1/devices", "/v1/auth/logout"] {
        app = app.route(p, post(rec(p, seen.clone())));
    }
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (url, seen)
}

#[tokio::test]
async fn signed_out_state_without_daemon_still_replies() {
    // 不存在的 socket：state 仍要返回一个安全快照（phase signed_out），不 panic、不透传异常。
    let bridge = Bridge::new(std::env::temp_dir().join("onex-desktop-test-missing.sock"));
    let s = bridge.call(Op::State).await.unwrap();
    assert_eq!(s.phase, "signed_out");
    assert_eq!(s.connection, "idle");
    assert!(s.user.is_none());
}

#[test]
fn rejects_unknown_op_fields() {
    // `deny_unknown_fields` 只对带字段的 variant 生效（`state`/`logout` 是空变体，天然没有字段可多）。
    let bad: Result<Op, _> = serde_json::from_value(json!({"op":"send_code","target":"a@example.test","extra":"x"}));
    assert!(bad.is_err());
    let bad: Result<Op, _> = serde_json::from_value(json!({"op":"launch","agent_id":"claude-code","path":"/etc"}));
    assert!(bad.is_err());
}

#[tokio::test]
async fn login_requires_send_code_first() {
    let (url, _seen) = fake_server(false).await;
    let (bridge, _dir, _task) = test_daemon(Some(url)).await;
    let r = bridge.call(Op::Login { target: "a@example.test".into(), code: "123456".into(), invite_code: None }).await;
    assert_eq!(r.unwrap_err().code, "invalid");
}

#[tokio::test]
async fn full_login_select_tenant_and_logout() {
    let (url, seen) = fake_server(true).await;
    let (bridge, _dir, _task) = test_daemon(Some(url)).await;

    bridge.call(Op::SendCode { target: "a@example.test".into() }).await.unwrap();
    let s = bridge
        .call(Op::Login { target: "a@example.test".into(), code: "123456".into(), invite_code: None })
        .await
        .unwrap();
    assert_eq!(s.phase, "choose_tenant");
    assert_eq!(s.tenants.len(), 2);

    let s = bridge.call(Op::SelectTenant { tenant_id: "ten_b".into() }).await.unwrap();
    assert_eq!(s.phase, "ready");
    assert_eq!(s.tenant.unwrap().id, "ten_b");
    assert_eq!(s.user.unwrap().name, "示例员工");
    assert!(s.agents.is_empty(), "without a Server catalogue there is no launch action");

    let paths: Vec<String> = seen.lock().unwrap().calls.iter().map(|c| c.0.clone()).collect();
    assert_eq!(paths, ["/v1/auth/code", "/v1/auth/login", "/v1/auth/select-tenant", "/v1/devices"]);

    let s = bridge.call(Op::Logout).await.unwrap();
    assert_eq!(s.phase, "signed_out");
    assert!(s.tenant.is_none());
    assert!(s.agents.is_empty());
}

#[tokio::test]
async fn select_tenant_rejects_unknown_id() {
    let (url, _seen) = fake_server(false).await;
    let (bridge, _dir, _task) = test_daemon(Some(url)).await;
    bridge.call(Op::SendCode { target: "a@example.test".into() }).await.unwrap();
    bridge.call(Op::Login { target: "a@example.test".into(), code: "123456".into(), invite_code: None }).await.unwrap();
    let r = bridge.call(Op::SelectTenant { tenant_id: "ten_x".into() }).await;
    assert_eq!(r.unwrap_err().code, "forbidden");
}

#[tokio::test]
async fn launch_rejected_before_tenant_selected() {
    let (bridge, _dir, _task) = test_daemon(None).await;
    let r = bridge.call(Op::Launch { agent_id: "claude-code".into() }).await;
    assert_eq!(r.unwrap_err().code, "forbidden");
}

#[tokio::test]
async fn settings_round_trip() {
    let (bridge, _dir, _task) = test_daemon(None).await;
    let s = bridge.call(Op::Settings { hide_on_close: false }).await.unwrap();
    assert!(!s.settings.hide_on_close);
    let s = bridge.call(Op::Settings { hide_on_close: true }).await.unwrap();
    assert!(s.settings.hide_on_close);
}

#[tokio::test]
async fn unknown_http_error_code_folds_to_internal() {
    // 错误码白名单：假 Server 的 401 没有 error.code 时，不能把陌生码直接透传给 UI。
    let seen = Arc::new(Mutex::new(Seen::default()));
    let app = axum::Router::new().route(
        "/v1/auth/code",
        post(|| async { (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":{"code":"made_up","message":"x"}}))) }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    let (bridge, _dir, _task) = test_daemon(Some(url)).await;
    let r = bridge.call(Op::SendCode { target: "a@example.test".into() }).await;
    assert_eq!(r.unwrap_err().code, "internal");
    let _ = seen;
}
