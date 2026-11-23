//! `Bridge` 的状态机测试：真实临时 onexd daemon（同 edge/onexd/tests/ipc.rs 的手法）+
//! 假 Server（axum），不碰真实 Server、真实上游或真实钥匙串服务名。

use std::sync::{Arc, Mutex};

use axum::Json;
use axum::extract::State as HttpState;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use onex_core::ipc::Request;
use onex_desktop::bridge::{Bridge, Op};
use onexd::credentials::{CredentialStore, DeviceCredentials, HistoryIdentity, HistoryScope};
use onexd::ipc::{self, Ipc};
use onexd::outbox::Outbox;
use onexd::secret::DeviceKey;
use onexd::state::{Phase, State};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
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
    device_auth: Option<String>,
    lookup_auth: Option<String>,
    session_ended: Option<String>,
}

/// 假 Server：固定验证码 123456，支持单租户/多租户两种开关。
async fn fake_server(two_tenants: bool) -> (String, Arc<Mutex<Seen>>) {
    fake_server_with_device(two_tenants, None).await
}

async fn fake_server_with_device(two_tenants: bool, device: Option<Value>) -> (String, Arc<Mutex<Seen>>) {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let rec = |path: &'static str, s: Arc<Mutex<Seen>>| {
        move |headers: HeaderMap, Json(b): Json<Value>| {
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
                        Json(json!({"token":"global","user":{"id":"usr_a","name":"示例员工"},"tenants":tenants}))
                            .into_response()
                    }
                    "/v1/auth/password-login" => {
                        Json(json!({"token":"scoped_password","user":{"id":"usr_a","name":"示例员工"},
                        "tenants":[{"id":"ten_a","name":"甲公司"}]}))
                        .into_response()
                    }
                    "/v1/auth/select-tenant" => {
                        Json(json!({"token": format!("scoped_{}", b["tenant_id"].as_str().unwrap())})).into_response()
                    }
                    "/v1/devices" => {
                        s.lock().unwrap().device_auth =
                            headers.get("authorization").and_then(|value| value.to_str().ok()).map(str::to_owned);
                        (StatusCode::CREATED, Json(json!({"device_id":"dev_1","device_token":"dtok"}))).into_response()
                    }
                    _ => StatusCode::NO_CONTENT.into_response(),
                }
            }
        }
    };
    let mut app = axum::Router::new();
    for p in ["/v1/auth/code", "/v1/auth/login", "/v1/auth/password-login", "/v1/auth/select-tenant", "/v1/devices"] {
        app = app.route(p, post(rec(p, seen.clone())));
    }
    let lookup_seen = seen.clone();
    let logout_seen = seen.clone();
    app = app
        .route(
            "/v1/devices/dev_cli",
            get(move |headers: HeaderMap| async move {
                lookup_seen.lock().unwrap().lookup_auth = authorization(&headers);
                match device {
                    Some(device) => Json(device).into_response(),
                    None => StatusCode::NOT_FOUND.into_response(),
                }
            }),
        )
        .route(
            "/v1/auth/logout",
            post(move |headers: HeaderMap| async move {
                logout_seen.lock().unwrap().session_ended = authorization(&headers);
                StatusCode::NO_CONTENT
            }),
        );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (url, seen)
}

fn authorization(headers: &HeaderMap) -> Option<String> {
    headers.get("authorization").and_then(|value| value.to_str().ok()).map(str::to_owned)
}

async fn daemon_request(path: &std::path::Path, request: Request) -> Value {
    let socket = path.join("onexd.sock");
    let (read, mut write) = onex_core::transport::connect(&socket).await.unwrap().into_split();
    let line = serde_json::to_string(&request).unwrap() + "\n";
    write.write_all(line.as_bytes()).await.unwrap();
    let mut reply = String::new();
    BufReader::new(read).read_line(&mut reply).await.unwrap();
    serde_json::from_str(&reply).unwrap()
}

async fn login_cli(path: &std::path::Path, url: String) {
    let request =
        Request::Login { token: "cli-device-token".into(), server: Some(url), device_id: Some("dev_cli".into()) };
    assert_eq!(daemon_request(path, request).await["ok"], true);
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
async fn password_login_registers_directly_and_returns_only_display_fields() {
    let (url, seen) = fake_server(false).await;
    let (bridge, dir, _task) = test_daemon(Some(url)).await;
    let login =
        Op::PasswordLogin { tenant: "OneC".into(), username: "zhangwei".into(), password: "form-password".into() };
    let ready = bridge.call(login.clone()).await.unwrap();
    assert_eq!(ready.phase, "ready");
    assert_eq!(ready.tenant.as_ref().unwrap().id, "ten_a");
    assert_eq!(ready.user.as_ref().unwrap().name, "示例员工");
    assert!(ready.tenants.is_empty());
    let serialized = serde_json::to_string(&ready).unwrap();
    for private in ["form-password", "scoped_password", "dtok"] {
        assert!(!serialized.contains(private));
    }
    {
        let seen = seen.lock().unwrap();
        assert_eq!(seen.calls.len(), 2);
        assert_eq!(
            seen.calls[0],
            (
                "/v1/auth/password-login".into(),
                json!({"tenant":"OneC","username":"zhangwei","password":"form-password","kind":"desktop"})
            )
        );
        assert_eq!(seen.calls[1].0, "/v1/devices");
        assert_eq!(seen.device_auth.as_deref(), Some("Bearer scoped_password"));
    }
    let stored = std::fs::read_to_string(dir.path().join("desktop-profile.json")).unwrap();
    assert!(!stored.contains("form-password") && !stored.contains("scoped_password"));
    assert_eq!(bridge.call(login).await.unwrap_err().code, "forbidden");
}

#[tokio::test]
async fn desktop_attaches_to_the_current_cli_device_for_the_same_account() {
    let device = json!({"id":"dev_cli","user_id":"usr_a","status":"active"});
    let (url, seen) = fake_server_with_device(false, Some(device)).await;
    let (bridge, dir, _task) = test_daemon(Some(url.clone())).await;
    login_cli(dir.path(), url).await;
    assert_eq!(bridge.call(Op::State).await.unwrap().phase, "signed_out");

    let login =
        Op::PasswordLogin { tenant: "OneC".into(), username: "zhangwei".into(), password: "form-password".into() };
    let ready = bridge.call(login).await.unwrap();
    assert_eq!(ready.phase, "ready");
    assert_eq!(ready.tenant.as_ref().unwrap().id, "ten_a");
    assert_eq!(ready.user.as_ref().unwrap().name, "示例员工");
    let profile = std::fs::read_to_string(dir.path().join("desktop-profile.json")).unwrap();
    let status = daemon_request(dir.path(), Request::Status).await;
    assert_eq!(status["device_id"], "dev_cli");
    assert_eq!(serde_json::from_str::<Value>(&profile).unwrap()["device_id"], "dev_cli");
    let serialized = serde_json::to_string(&ready).unwrap();
    for private in ["form-password", "scoped_password", "cli-device-token"] {
        assert!(!profile.contains(private) && !serialized.contains(private));
    }
    let reopened = Bridge::new(dir.path().join("onexd.sock"));
    reopened.restore_session().await;
    assert_eq!(reopened.call(Op::State).await.unwrap().phase, "ready");

    let seen = seen.lock().unwrap();
    assert_eq!(seen.calls.len(), 1, "existing device never registers again");
    assert_eq!(seen.lookup_auth.as_deref(), Some("Bearer scoped_password"));
    assert_eq!(seen.session_ended.as_deref(), Some("Bearer scoped_password"));
}

#[tokio::test]
async fn desktop_rejects_a_cli_device_it_cannot_adopt_without_registering() {
    let other_account = json!({"id":"dev_cli","user_id":"usr_other","status":"active"});
    let revoked = json!({"id":"dev_cli","user_id":"usr_a","status":"revoked"});
    for device in [Some(other_account), Some(revoked), None] {
        let (url, seen) = fake_server_with_device(false, device).await;
        let (bridge, dir, _task) = test_daemon(Some(url.clone())).await;
        login_cli(dir.path(), url).await;
        let login =
            Op::PasswordLogin { tenant: "OneC".into(), username: "zhangwei".into(), password: "form-password".into() };
        assert_eq!(bridge.call(login).await.unwrap_err().code, "device_already_logged_in");
        assert_eq!(bridge.call(Op::State).await.unwrap().phase, "signed_out");
        let status = daemon_request(dir.path(), Request::Status).await;
        assert_eq!(status["device_id"], "dev_cli");
        assert_eq!(status["logged_in"], true);
        assert!(!dir.path().join("desktop-profile.json").exists());
        let seen = seen.lock().unwrap();
        assert_eq!(seen.calls.len(), 1);
        assert_eq!(seen.lookup_auth.as_deref(), Some("Bearer scoped_password"));
        assert_eq!(seen.session_ended.as_deref(), Some("Bearer scoped_password"));
    }
}

#[tokio::test]
async fn desktop_profile_failure_keeps_the_existing_cli_device_logged_in() {
    let device = json!({"id":"dev_cli","user_id":"usr_a","status":"active"});
    let (url, seen) = fake_server_with_device(false, Some(device)).await;
    let (bridge, dir, _task) = test_daemon(Some(url.clone())).await;
    login_cli(dir.path(), url).await;
    std::fs::create_dir(dir.path().join("desktop-profile.json")).unwrap();

    let login =
        Op::PasswordLogin { tenant: "OneC".into(), username: "zhangwei".into(), password: "form-password".into() };
    assert_eq!(bridge.call(login).await.unwrap_err().code, "internal");
    assert_eq!(bridge.call(Op::State).await.unwrap().phase, "signed_out");
    let status = daemon_request(dir.path(), Request::Status).await;
    assert_eq!(status["logged_in"], true);
    assert_eq!(status["device_id"], "dev_cli");
    assert_eq!(seen.lock().unwrap().session_ended.as_deref(), Some("Bearer scoped_password"));
}

const HISTORY_DEVICE: &str = "dev_retained";
const OTHER_DEVICE: &str = "dev_new";

#[derive(Default)]
struct HistoryVault(Mutex<Option<DeviceCredentials>>);

impl CredentialStore for HistoryVault {
    fn load(&self) -> anyhow::Result<Option<DeviceCredentials>> {
        Ok(self.0.lock().unwrap().clone())
    }

    fn save(&self, credentials: &DeviceCredentials) -> anyhow::Result<()> {
        *self.0.lock().unwrap() = Some(credentials.clone());
        Ok(())
    }

    fn clear(&self) -> anyhow::Result<()> {
        self.0.lock().unwrap().take();
        Ok(())
    }

    fn load_history(&self, scope: &HistoryScope<'_>) -> anyhow::Result<Option<HistoryIdentity>> {
        Ok((scope.tenant_id == "ten_a" && scope.user_id == "usr_a")
            .then(|| HistoryIdentity { device_id: HISTORY_DEVICE.into(), device_key: [7; 32] }))
    }
}

async fn history_daemon(url: String) -> (Bridge, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().to_owned();
    let socket = home.join("onexd.sock");
    let bridge = Bridge::new(socket.clone());
    let mut listener = ipc::bind(&socket).await.unwrap();
    let vault = Arc::new(HistoryVault::default());
    tokio::spawn(async move {
        loop {
            let mut state = State::default();
            if let Some(credentials) = vault.load().unwrap() {
                state.device_key = DeviceKey::from_bytes(credentials.device_key);
                *state.expected_device_id.write().unwrap() = Some(credentials.device_id);
                state.replace_token(Some(credentials.device_token));
                state.set_phase(Phase::Connected);
            }
            let home = home.join(onexd::credentials::fingerprint(&state.device_key.public_b64()));
            std::fs::create_dir_all(&home).unwrap();
            let service = Arc::new(Ipc {
                state: Arc::new(state),
                outbox: Arc::new(Outbox::open(&home.join("outbox.sqlite")).unwrap()),
                router_addr: None,
                server_url: Some(url.clone()),
                launch: None,
                credentials: Some(vault.clone()),
                identity_transition: Default::default(),
                shutdown: CancellationToken::new(),
            });
            ipc::serve(listener, socket.clone(), service).await;
            // Windows keeps the previously connected pipe alive until both handles close.
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
            listener = loop {
                match ipc::bind(&socket).await {
                    Ok(listener) => break listener,
                    Err(error)
                        if cfg!(windows)
                            && error.to_string().starts_with("another onexd is listening")
                            && tokio::time::Instant::now() < deadline =>
                    {
                        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    }
                    Err(error) => panic!("fixture daemon did not rebind: {error}"),
                }
            };
        }
    });
    (bridge, dir)
}

#[tokio::test]
async fn desktop_recovers_the_original_device_only_for_the_same_account() {
    let calls = Arc::new(Mutex::new(Vec::<(&str, String)>::new()));
    let app = axum::Router::new()
        .route("/v1/auth/password-login", post(|Json(body): Json<Value>| async move {
            let (token, user, name) = match body["username"].as_str() {
                Some("alice") => ("account_a", "usr_a", "Alice"),
                Some("bob") => ("account_b", "usr_b", "Bob"),
                _ => panic!("unexpected test account"),
            };
            Json(json!({"token":token,"user":{"id":user,"name":name},"tenants":[{"id":"ten_a","name":"甲公司"}]}))
        }))
        .route("/v1/me", get(|headers: HeaderMap| async move {
            let user = match authorization(&headers).as_deref() {
                Some("Bearer account_a") => "usr_a",
                Some("Bearer account_b") => "usr_b",
                _ => panic!("expected a scoped test session"),
            };
            Json(json!({"user":{"id":user},"tenant":{"id":"ten_a"}}))
        }))
        .route("/v1/devices/dev_retained", get(|| async move {
            Json(json!({"id":HISTORY_DEVICE,"user_id":"usr_a","status":"active"}))
        }))
        .route("/v1/devices/dev_retained/resume-challenge", post(|headers: HeaderMap, Json(body): Json<Value>| async move {
            assert_eq!(authorization(&headers).as_deref(), Some("Bearer account_a"));
            assert_eq!(body, json!({}));
            // Encrypted to the retained [7; 32] device key with onex-device-resume-v1 as the context.
            Json(json!({"key_id":"jDBs15k5gw/GjMyMiJHeTzCJma9Nq6ZCP/mlsdiN2nM=","nonce":"Dz+V5pwYwmw3qqEb0AXTwev6xH8SEO01",
                "ciphertext":"4AaLo6eCbzczFytzl135OjgStx1U+j0dS6UvkK4uTGhj04/jz6j/"}))
        }))
        .route("/v1/devices/dev_retained/resume", post(|HttpState(calls): HttpState<Arc<Mutex<Vec<_>>>>, headers: HeaderMap, Json(body): Json<Value>| async move {
            calls.lock().unwrap().push(("resume", authorization(&headers).unwrap()));
            assert!(headers.contains_key("idempotency-key"));
            assert_eq!(body, json!({"proof":"desktop-account-a-proof"}));
            Json(json!({"device_id":HISTORY_DEVICE,"device_token":"rotated_device_a"}))
        }))
        .route("/v1/devices", post(|HttpState(calls): HttpState<Arc<Mutex<Vec<_>>>>, headers: HeaderMap| async move {
            calls.lock().unwrap().push(("register", authorization(&headers).unwrap()));
            (StatusCode::CREATED, Json(json!({"device_id":OTHER_DEVICE,"device_token":"device_b"})))
        }))
        .route("/v1/auth/logout", post(|| async { StatusCode::NO_CONTENT }))
        .with_state(calls.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let (alice, dir) = history_daemon(url).await;
    let login = |username: &str| Op::PasswordLogin {
        tenant: "ten_a".into(),
        username: username.into(),
        password: "fixture".into(),
    };
    let profile_file = dir.path().join("desktop-profile.json");
    let snapshot = alice.call(login("alice")).await.unwrap();
    assert_eq!(snapshot.user.unwrap().name, "Alice");
    let retained_profile = std::fs::read_to_string(&profile_file).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&retained_profile).unwrap()["device_id"], HISTORY_DEVICE);
    assert!(!retained_profile.contains("rotated_device_a"));
    assert_eq!(*calls.lock().unwrap(), [("resume", "Bearer account_a".into())]);

    let bob = Bridge::new(dir.path().join("onexd.sock"));
    let wrong_device = bob.call(login("bob")).await.unwrap_err();
    assert_eq!(wrong_device.code, "device_already_logged_in");
    assert!(bob.call(Op::State).await.unwrap().user.is_none());
    assert_eq!(std::fs::read_to_string(&profile_file).unwrap(), retained_profile);

    let stale = Bridge::new(dir.path().join("onexd.sock"));
    stale.restore_session().await;
    assert_eq!(stale.call(Op::State).await.unwrap().phase, "ready");
    assert_eq!(daemon_request(dir.path(), Request::Logout).await["ok"], true);
    // Wait for the mock daemon's asynchronous logout and restart to finish.
    let socket = dir.path().join("onexd.sock");
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            if let Ok(Ok(status)) = tokio::time::timeout(
                std::time::Duration::from_millis(100),
                onex_core::daemon::exchange(&socket, &Request::Status),
            )
            .await
                && status["logged_in"] == false
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("fixture daemon should be ready for the next login");
    let snapshot = bob.call(login("bob")).await.unwrap();
    assert_eq!(snapshot.user.unwrap().name, "Bob");
    let profile = std::fs::read_to_string(&profile_file).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&profile).unwrap()["device_id"], OTHER_DEVICE);
    assert!(!profile.contains("Alice") && !profile.contains("rotated_device_a"));
    assert_eq!(
        *calls.lock().unwrap(),
        [("resume", "Bearer account_a".into()), ("register", "Bearer account_b".into())]
    );

    let stale_state = alice.call(Op::State).await.unwrap();
    assert_eq!(stale_state.phase, "signed_out");
    assert!(stale_state.user.is_none() && stale_state.tenant.is_none());
    assert_eq!(stale.call(Op::Logout).await.unwrap().phase, "signed_out");
    let status = daemon_request(dir.path(), Request::Status).await;
    assert_eq!(status["device_id"], OTHER_DEVICE);
    assert_eq!(status["logged_in"], true);
    assert_eq!(std::fs::read_to_string(&profile_file).unwrap(), profile);
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
