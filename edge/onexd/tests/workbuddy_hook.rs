use std::path::Path;
use std::process::{Output, Stdio};

use axum::{Json, http::HeaderMap, routing::post};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;

async fn hook(policy: &Path, event: &Value) -> Output {
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_onexd"))
        .arg("workbuddy-hook")
        .arg(policy)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(event.to_string().as_bytes()).await.unwrap();
    child.wait_with_output().await.unwrap()
}

#[tokio::test]
async fn hook_command_only_sends_managed_turn_identity_to_its_local_daemon() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let config = root.join("config");
    let workspace = root.join("workspace");
    for dir in [&config, &workspace] {
        std::fs::create_dir(dir).unwrap();
    }
    let daemon = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = daemon.local_addr().unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::channel(2);
    let router = axum::Router::new().route(
        "/v1/onex/workbuddy/turn",
        post(move |headers: HeaderMap, Json(body): Json<Value>| {
            let tx = tx.clone();
            async move {
                assert_eq!(headers["authorization"], "Bearer fixture-control");
                tx.send(body).await.unwrap();
                axum::http::StatusCode::NO_CONTENT
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(daemon, router).await.unwrap() });
    let policy = root.join("workbuddy-policy.json");
    let credential = root.join("control");
    std::fs::write(&credential, "fixture-control").unwrap();
    std::fs::write(
        &policy,
        json!({"origin":format!("http://{addr}"),"workspace":workspace,
        "config":config,"privateHome":root,"credential":credential})
        .to_string(),
    )
    .unwrap();
    let generation = "0198a1b2c3d47e5f8a9b0c1d2e3f4a5b";
    let mut event = json!({"session_id":"native-sid","generation_id":generation,"hook_event_name":"UserPromptSubmit",
        "transcript_path":config.join("projects/workspace/native-sid.jsonl"),"cwd":workspace,"prompt":"private text"});
    for name in ["UserPromptSubmit", "Stop"] {
        event["hook_event_name"] = json!(name);
        assert!(hook(&policy, &event).await.status.success());
        let mut expected = json!({"event":name,"native_id":"native-sid","generation_id":generation});
        if name == "UserPromptSubmit" {
            expected["source"] = json!({"project":"workspace","cwd":workspace});
        }
        assert_eq!(rx.recv().await.unwrap(), expected);
    }
    event["transcript_path"] = json!(config.join("projects/workspace/other-sid.jsonl"));
    assert!(!hook(&policy, &event).await.status.success());
    assert!(rx.try_recv().is_err());
    server.abort();
}
