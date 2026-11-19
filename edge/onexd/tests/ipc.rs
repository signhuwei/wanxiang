use std::sync::{Arc, Mutex};
use std::time::Duration;

use onexd::credentials::{CredentialStore, DeviceCredentials};
use onexd::ipc::{self, Ipc};
use onexd::outbox::{Kind, Outbox};
use onexd::state::State;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

const T: Duration = Duration::from_secs(5);

/// 测试用凭据存储：和真实 Keychain 行为一致（保存/清除/找不到），但不碰系统钥匙串。
#[derive(Default)]
struct FakeCredentials(Mutex<Option<DeviceCredentials>>);

impl CredentialStore for FakeCredentials {
    fn load(&self) -> anyhow::Result<Option<DeviceCredentials>> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn save(&self, creds: &DeviceCredentials) -> anyhow::Result<()> {
        *self.0.lock().unwrap() = Some(creds.clone());
        Ok(())
    }
    fn clear(&self) -> anyhow::Result<()> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}

struct Client {
    r: BufReader<tokio::net::unix::OwnedReadHalf>,
    w: tokio::net::unix::OwnedWriteHalf,
}

impl Client {
    async fn connect(path: &std::path::Path) -> Self {
        let (r, w) = UnixStream::connect(path).await.unwrap().into_split();
        Self { r: BufReader::new(r), w }
    }

    async fn call(&mut self, line: &str) -> Value {
        self.w.write_all(format!("{line}\n").as_bytes()).await.unwrap();
        let mut s = String::new();
        timeout(T, self.r.read_line(&mut s)).await.unwrap().unwrap();
        serde_json::from_str(&s).unwrap()
    }
}

#[tokio::test]
async fn status_login_shutdown() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("onexd.sock");
    let state = Arc::new(State::default());
    let outbox = Arc::new(Outbox::open(&dir.path().join("o.sqlite")).unwrap());
    outbox.append(Kind::Events, json!({})).unwrap();
    let shutdown = CancellationToken::new();
    let listener = ipc::bind(&path).await.unwrap();

    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);

    // 第二个实例不能抢同一个 socket
    assert!(ipc::bind(&path).await.is_err());

    let srv = Arc::new(Ipc {
        state: state.clone(),
        outbox: outbox.clone(),
        router_addr: Some("127.0.0.1:1".into()),
        server_url: Some("http://127.0.0.1:2".into()),
        launch: Some(ipc::LaunchCtx::new(dir.path().to_path_buf(), reqwest::Client::new())),
        credentials: None,
        identity_transition: Default::default(),
        shutdown: shutdown.clone(),
    });
    let task = tokio::spawn(ipc::serve(listener, path.clone(), srv));

    let mut c = Client::connect(&path).await;
    let s = c.call(r#"{"cmd":"status"}"#).await;
    assert_eq!(s["ok"], true);
    assert_eq!(s["logged_in"], false);
    assert_eq!(s["ws"], "idle");
    assert_eq!(s["outbox_last_seq"], 1);
    assert_eq!(s["router_addr"], "127.0.0.1:1");

    let r = c.call(r#"{"cmd":"login","token":"  "}"#).await;
    assert_eq!(r["error"]["code"], "invalid");
    let r = c.call(r#"{"cmd":"login","token":"dev_tok"}"#).await;
    assert_eq!(r, json!({"ok": true}));
    assert_eq!(state.token.borrow().as_deref(), Some("dev_tok"));
    assert_eq!(c.call(r#"{"cmd":"status"}"#).await["logged_in"], true);

    // 只暴露公钥，与 daemon 内存里的私钥对应
    let d = c.call(r#"{"cmd":"device_info"}"#).await;
    assert_eq!(d["public_key"], state.device_key.public_b64());
    assert_eq!(d["server_url"], "http://127.0.0.1:2");
    assert_eq!(d.as_object().unwrap().len(), 3);

    // 受管启动：只用 Server 下发的精确模型名
    let cwd = dir.path().to_string_lossy().to_string();
    let launch = |model: Option<&str>| {
        json!({"cmd":"launch","agent":"claude-code","program":"/bin/echo","cwd":cwd,"env":{"PATH":"/usr/bin","SECRET":"x"},"model":model})
            .to_string()
    };
    assert_eq!(c.call(&launch(None)).await["error"]["code"], "model_not_allowed");
    state.config.write().unwrap().routes = vec![route("claude-*")];
    assert_eq!(c.call(&launch(Some("kimi-k3"))).await["error"]["code"], "model_not_allowed");
    // server MVP seed 的形状：通配路由固定上游模型，默认别名取它
    let mut wild = route("*");
    wild.upstream_model = Some("Qwen3.8-27B".into());
    state.config.write().unwrap().routes = vec![wild];
    let l = c.call(&launch(None)).await;
    assert_eq!((l["ok"].as_bool(), l["model"].as_str()), (Some(true), Some("Qwen3.8-27B")));
    assert_eq!(
        state.launch_tokens.read().unwrap().get(l["env"]["ANTHROPIC_API_KEY"].as_str().unwrap()).map(String::as_str),
        l["session_id"].as_str()
    );
    assert_eq!(l["env"]["ANTHROPIC_BASE_URL"], "http://127.0.0.1:1");
    assert!(l["env"].get("SECRET").is_none());
    let run_dir = dir.path().join("run").join(l["launch_id"].as_str().unwrap());
    assert!(run_dir.join("settings.json").exists());
    let sid = l["session_id"].as_str().unwrap().to_string();
    assert_eq!(state.active_session.read().unwrap().as_deref(), Some(sid.as_str()));
    // Claude Code 写主会话文件，采集到 outbox
    let proj = dir.path().join("agents/claude-code/claude/projects/-tmp-x");
    std::fs::create_dir_all(&proj).unwrap();
    let line = json!({"type":"user","uuid":"u1","sessionId":sid,"message":{"role":"user","content":"你好"}});
    std::fs::write(proj.join(format!("{sid}.jsonl")), format!("{line}\n")).unwrap();
    let done = json!({"cmd":"launch_done","launch_id":l["launch_id"],"exit_code":0}).to_string();
    assert_eq!(c.call(&done).await, json!({"ok": true}));
    assert!(!run_dir.exists());
    assert!(state.active_session.read().unwrap().is_none());
    let kinds = timeout(T, async {
        loop {
            let k: Vec<String> = outbox
                .pending(0, 100)
                .unwrap()
                .into_iter()
                .filter(|r| r.item["session_id"] == sid)
                .map(|r| r.item["kind"].as_str().unwrap().to_string())
                .collect();
            if k.last().map(String::as_str) == Some("session_end") {
                return k;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(kinds, ["session_start", "user_message", "session_end"]);
    let bad = json!({"cmd":"launch","agent":"codex","program":"/bin/echo","cwd":cwd,"env":{}}).to_string();
    assert_eq!(c.call(&bad).await["error"]["code"], "agent_not_allowed");

    let r = c.call("not json").await;
    assert_eq!((r["ok"].as_bool(), r["error"]["code"].as_str()), (Some(false), Some("invalid")));
    let r = c.call(r#"{"cmd":"rm -rf"}"#).await;
    assert_eq!(r["error"]["code"], "invalid");

    assert_eq!(c.call(r#"{"cmd":"shutdown"}"#).await, json!({"ok": true}));
    assert!(shutdown.is_cancelled());
    timeout(T, task).await.unwrap().unwrap();
    assert!(!path.exists());
}

fn route(model: &str) -> onex_core::ws::Route {
    onex_core::ws::Route {
        model: model.into(),
        model_id: "mod_1".into(),
        provider_id: "prv_1".into(),
        protocol: "openai_chat".into(),
        base_url: "http://up/v1".into(),
        upstream_model: None,
        auth: onex_core::ws::UpstreamAuth::Bearer,
        proxy: None,
    }
}

#[tokio::test]
async fn stale_socket_file_is_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("onexd.sock");
    drop(std::os::unix::net::UnixListener::bind(&path).unwrap());
    assert!(path.exists());
    ipc::bind(&path).await.unwrap();
}

async fn start(
    dir: &std::path::Path,
    store: Option<Arc<dyn CredentialStore>>,
) -> (Arc<State>, Client, CancellationToken) {
    let path = dir.join("onexd.sock");
    let state = Arc::new(State::default());
    let outbox = Arc::new(Outbox::open(&dir.join("o.sqlite")).unwrap());
    let shutdown = CancellationToken::new();
    let listener = ipc::bind(&path).await.unwrap();
    let srv = Arc::new(Ipc {
        state: state.clone(),
        outbox,
        router_addr: Some("127.0.0.1:1".into()),
        server_url: Some("http://srv.example".into()),
        launch: Some(ipc::LaunchCtx::new(dir.to_path_buf(), reqwest::Client::new())),
        credentials: store,
        identity_transition: Default::default(),
        shutdown: shutdown.clone(),
    });
    tokio::spawn(ipc::serve(listener, path.clone(), srv));
    (state, Client::connect(&path).await, shutdown)
}

#[tokio::test]
async fn login_persists_identity_and_rejects_conflicting_device_until_restart() {
    let dir = tempfile::tempdir().unwrap();
    let store: Arc<dyn CredentialStore> = Arc::new(FakeCredentials::default());
    let (state, mut c, _shutdown) = start(dir.path(), Some(store.clone())).await;

    // 正常登录：server + device_id 齐全，落 Keychain
    let body = json!({"cmd":"login","token":"dev_tok_1","server":"http://srv.example","device_id":"dev_1"}).to_string();
    let r = c.call(&body).await;
    assert_eq!(r, json!({"ok": true}));
    assert_eq!(state.token.borrow().as_deref(), Some("dev_tok_1"));
    assert_eq!(state.expected_device_id.read().unwrap().as_deref(), Some("dev_1"));
    let saved = store.load().unwrap().unwrap();
    assert_eq!(saved.device_id, "dev_1");
    assert_eq!(saved.device_token, "dev_tok_1");
    assert_eq!(saved.server, "http://srv.example");
    // 保存的是 daemon 内存里这把私钥，不是 IPC 输入的任何值（Login 请求根本不带私钥字段）
    assert_eq!(onexd::secret::DeviceKey::from_bytes(saved.device_key).public_b64(), state.device_key.public_b64());

    // 同一次运行里换一个不同的设备身份登录：拒绝，不覆盖已生效的身份
    let conflict =
        json!({"cmd":"login","token":"dev_tok_2","server":"http://srv.example","device_id":"dev_2"}).to_string();
    let r = c.call(&conflict).await;
    assert_eq!(r["error"]["code"], "conflict");
    assert_eq!(state.token.borrow().as_deref(), Some("dev_tok_1"));
    assert_eq!(store.load().unwrap().unwrap().device_id, "dev_1");

    assert_eq!(c.call(&body).await, json!({"ok": true}));
    let legacy = c.call(r#"{"cmd":"login","token":"legacy"}"#).await;
    assert_eq!(legacy["error"]["code"], "conflict");
    assert_eq!(state.token.borrow().as_deref(), Some("dev_tok_1"));
}

#[tokio::test]
async fn logout_clears_keychain_and_shuts_down() {
    let dir = tempfile::tempdir().unwrap();
    let store: Arc<dyn CredentialStore> = Arc::new(FakeCredentials::default());
    let (state, mut c, shutdown) = start(dir.path(), Some(store.clone())).await;

    let body = json!({"cmd":"login","token":"t","server":"http://srv.example","device_id":"dev_1"}).to_string();
    assert_eq!(c.call(&body).await, json!({"ok": true}));
    assert!(store.load().unwrap().is_some());
    state.config.write().unwrap().routes = vec![route("*")];
    state.secrets.write().unwrap().insert("prv_1".into(), "sk".into());

    let r = c.call(r#"{"cmd":"logout"}"#).await;
    assert_eq!(r, json!({"ok": true}));
    assert!(store.load().unwrap().is_none(), "keychain entry must be cleared");
    assert!(state.secrets.read().unwrap().is_empty());
    assert_eq!(state.config.read().unwrap().routes.len(), 0);
    assert!(shutdown.is_cancelled());
}

#[tokio::test]
async fn logout_fails_without_clearing_state_when_keychain_delete_fails() {
    struct Failing;
    impl CredentialStore for Failing {
        fn load(&self) -> anyhow::Result<Option<DeviceCredentials>> {
            Ok(None)
        }
        fn save(&self, _: &DeviceCredentials) -> anyhow::Result<()> {
            Ok(())
        }
        fn clear(&self) -> anyhow::Result<()> {
            anyhow::bail!("keychain is locked")
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let (state, mut c, shutdown) = start(dir.path(), Some(Arc::new(Failing))).await;
    state.config.write().unwrap().routes = vec![route("*")];

    let r = c.call(r#"{"cmd":"logout"}"#).await;
    assert_eq!(r["error"]["code"], "internal");
    assert!(!shutdown.is_cancelled(), "daemon must not shut down when it cannot report a clean logout");
    // 失败时不假装已经清了状态
    assert_eq!(state.config.read().unwrap().routes.len(), 1);
}

#[tokio::test]
async fn launch_without_program_downloads_the_managed_release() {
    let body = b"#!/bin/sh\necho hi\n".to_vec();
    let sha256 = {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(&body);
        h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>()
    };
    let app = axum::Router::new().route(
        "/claude",
        axum::routing::get({
            let body = body.clone();
            move || async move { body }
        }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/claude", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });

    let dir = tempfile::tempdir().unwrap();
    let (state, mut c, _shutdown) = start(dir.path(), None).await;
    assert_eq!(c.call(r#"{"cmd":"login","token":"t"}"#).await, json!({"ok": true}));
    let mut wild = route("*");
    wild.upstream_model = Some("Qwen3.8-27B".into());
    let release = onex_core::ws::AgentRelease {
        id: "rel_1".into(),
        agent: "claude-code".into(),
        version: "2.1.311".into(),
        os: onex_core::ipc::os_name().into(),
        arch: onex_core::ipc::arch_name().into(),
        url,
        sha256,
        size: body.len() as u64,
    };
    *state.config.write().unwrap() =
        onexd::state::ConfigSnapshot { revision: 1, routes: vec![wild], rates: vec![], agents: vec![release] };

    let cwd = dir.path().to_string_lossy().to_string();
    let req =
        json!({"cmd":"launch","agent":"claude-code","program":null,"cwd":cwd,"env":{"PATH":"/usr/bin"}}).to_string();
    let l = c.call(&req).await;
    assert_eq!(l["ok"], true, "{l}");
    let program = l["program"].as_str().unwrap();
    assert!(program.contains("/agents/claude-code/releases/"), "{program}");
    assert_eq!(std::fs::read(program).unwrap(), body);

    let second = c.call(&req).await;
    assert_eq!(second["ok"], true);
    assert_eq!(second["program"], l["program"]);
    let first_token = l["env"]["ANTHROPIC_API_KEY"].as_str().unwrap();
    let second_token = second["env"]["ANTHROPIC_API_KEY"].as_str().unwrap();
    assert_ne!(first_token, second_token);
    assert_ne!(l["session_id"], second["session_id"]);
    let finish = json!({"cmd":"launch_done","launch_id":l["launch_id"],"exit_code":0}).to_string();
    assert_eq!(c.call(&finish).await["ok"], true);
    {
        let tokens = state.launch_tokens.read().unwrap();
        assert!(!tokens.contains_key(first_token));
        assert_eq!(tokens.get(second_token).map(String::as_str), second["session_id"].as_str());
    }
    let s = c.call(r#"{"cmd":"status"}"#).await;
    assert_eq!(s["managed_agents"], json!([{"id":"claude-code","version":"2.1.311","status":"running"}]));
    let finish = json!({"cmd":"launch_done","launch_id":second["launch_id"],"exit_code":0}).to_string();
    assert_eq!(c.call(&finish).await["ok"], true);
    let s = c.call(r#"{"cmd":"status"}"#).await;
    assert_eq!(s["managed_agents"], json!([{"id":"claude-code","version":"2.1.311","status":"cached"}]));
}

#[tokio::test]
async fn launch_without_program_and_no_matching_release_fails() {
    let dir = tempfile::tempdir().unwrap();
    let (_state, mut c, _shutdown) = start(dir.path(), None).await;
    assert_eq!(c.call(r#"{"cmd":"login","token":"t"}"#).await, json!({"ok": true}));
    let cwd = dir.path().to_string_lossy().to_string();
    let req =
        json!({"cmd":"launch","agent":"claude-code","program":null,"cwd":cwd,"env":{"PATH":"/usr/bin"}}).to_string();
    let r = c.call(&req).await;
    // 没有匹配 agent/os/arch 的发行记录：在选型下载这一步就失败，不等到校验模型
    assert_eq!(r["error"]["code"], "agent_not_allowed", "{r}");
    assert!(r["error"]["message"].as_str().unwrap().contains("没有可用的受管发行版本"), "{r}");
}
