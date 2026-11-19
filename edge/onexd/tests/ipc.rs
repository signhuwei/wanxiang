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
        outbox,
        router_addr: Some("127.0.0.1:1".into()),
        server_url: Some("http://127.0.0.1:2".into()),
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

    let r = c.call("not json").await;
    assert_eq!((r["ok"].as_bool(), r["error"]["code"].as_str()), (Some(false), Some("invalid")));
    let r = c.call(r#"{"cmd":"rm -rf"}"#).await;
    assert_eq!(r["error"]["code"], "invalid");

    assert_eq!(c.call(r#"{"cmd":"shutdown"}"#).await, json!({"ok": true}));
    assert!(shutdown.is_cancelled());
    timeout(T, task).await.unwrap().unwrap();
    assert!(!path.exists());
}

#[tokio::test]
async fn stale_socket_file_is_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("onexd.sock");
    drop(std::os::unix::net::UnixListener::bind(&path).unwrap());
    assert!(path.exists());
    ipc::bind(&path).await.unwrap();
}
