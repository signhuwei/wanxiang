use std::sync::Arc;
use std::time::Duration;

use onexd::ipc::{self, Ipc};
use onexd::outbox::{Kind, Outbox};
use onexd::state::State;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

const T: Duration = Duration::from_secs(5);

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
        launch: Some(ipc::LaunchCtx::new(dir.path().to_path_buf(), "localtok".into())),
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
    state.config.write().unwrap().routes = vec![route("*"), route("Qwen3.8-27B")];
    assert_eq!(c.call(&launch(Some("claude-opus-5-5"))).await["error"]["code"], "model_not_allowed");
    let l = c.call(&launch(None)).await;
    assert_eq!((l["ok"].as_bool(), l["model"].as_str()), (Some(true), Some("Qwen3.8-27B")));
    assert_eq!(l["env"]["ANTHROPIC_API_KEY"], "localtok");
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
