#![cfg(target_os = "macos")]

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::{HeaderMap, Response};
use axum::{Router as Axum, body::Body, routing::post};
use onex_core::transport;
use onex_core::ws::{AgentRelease, Lease, Rate, Route, UpstreamAuth};
use onexd::{
    ipc::{self, Ipc},
    outbox::{Outbox, now_ms},
    pricing::format_ms,
    router::Router,
    state::{ConfigSnapshot, State},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

async fn ipc_call(path: &Path, request: Value) -> Value {
    let (r, mut w) = transport::connect(path).await.unwrap().into_split();
    w.write_all(format!("{request}\n").as_bytes()).await.unwrap();
    let mut line = String::new();
    BufReader::new(r).read_line(&mut line).await.unwrap();
    serde_json::from_str(&line).unwrap()
}
fn anthropic_reply() -> Response<Body> {
    let events = [
        json!({"type":"message_start","message":{"id":"msg_smoke","type":"message","role":"assistant","model":"kimi-smoke",
            "content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Kimi fixture confirmed"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":4}}),
        json!({"type":"message_stop"}),
    ];
    let s: String = events
        .into_iter()
        .map(|event| format!("event: {}\ndata: {event}\n\n", event["type"].as_str().unwrap()))
        .collect();
    Response::builder().header("content-type", "text/event-stream").body(Body::from(s)).unwrap()
}
fn chat_reply(request: &Value) -> Response<Body> {
    let tool_reply = request["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|o| o["role"] == "tool" && o["content"].as_str().is_some_and(|text| text.contains("token-filtered")));
    let tool = request["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t["function"]["name"].as_str())
        .find(|name| name.ends_with("exec_command") || name.ends_with("shell_command"));
    let command = "if env | grep -q '^ONEX_CODEX_TOKEN_'; then printf token-present; else printf token-filtered; fi";
    let (delta, finish) = if !tool_reply && let Some(tool) = tool {
        let args = if tool.ends_with("exec_command") {
            json!({"cmd":command,"yield_time_ms":1000})
        } else {
            json!({"command":command})
        };
        (
            json!({"role":"assistant","tool_calls":[{"index":0,"id":"call_smoke_env","type":"function","function":{"name":tool,"arguments":args.to_string()}}]}),
            "tool_calls",
        )
    } else {
        (json!({"role":"assistant","content":"Codex fixture confirmed"}), "stop")
    };
    let frames = [
        json!({"id":"chat_smoke","choices":[{"index":0,"delta":delta,"finish_reason":null}]}),
        json!({"id":"chat_smoke","choices":[{"index":0,"delta":{},"finish_reason":finish}]}),
        json!({"id":"chat_smoke","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":30}}),
    ];
    let mut s: String = frames.into_iter().map(|frame| format!("data: {frame}\n\n")).collect();
    s.push_str("data: [DONE]\n\n");
    Response::builder().header("content-type", "text/event-stream").body(Body::from(s)).unwrap()
}

#[tokio::test]
#[ignore = "requires the approved macOS agent binary via ONEX_SMOKE_BINARY"]
async fn local_installed_agent_receipt() {
    let agent = std::env::var("ONEX_SMOKE_AGENT").unwrap();
    let path = std::env::var("ONEX_SMOKE_BINARY").unwrap();
    let is_codex = agent == "codex";
    let dir = tempfile::tempdir_in("/private/tmp").unwrap();
    let cwd = dir.path().join("project");
    std::fs::create_dir(&cwd).unwrap();
    let observed = Arc::new(Mutex::new(Vec::new()));
    let seen = observed.clone();
    let fake = post(move |h: HeaderMap, axum::Json(v): axum::Json<Value>| {
        let seen = seen.clone();
        async move {
            assert_eq!(
                h.get("authorization")
                    .or_else(|| h.get("x-api-key"))
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .split_whitespace()
                    .last(),
                Some("fake-upstream")
            );
            let response = if is_codex { chat_reply(&v) } else { anthropic_reply() };
            seen.lock().unwrap().push(v);
            tokio::time::sleep(Duration::from_millis(450)).await;
            response
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider_addr = listener.local_addr().unwrap();
    let upstream = tokio::spawn(
        axum::serve(listener, Axum::new().route("/v1/messages", fake.clone()).route("/v1/chat/completions", fake))
            .into_future(),
    );

    let artifact = std::fs::read(&path).unwrap();
    let digest = format!("{:x}", Sha256::digest(&artifact));
    let artifact_len = artifact.len() as u64;
    drop(artifact);
    let dest = dir.path().join("agents").join(&agent).join("releases").join(&digest).join(&agent);
    std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
    std::fs::hard_link(&path, &dest).unwrap();
    let state = Arc::new(State::default());
    let model = if is_codex { "gpt-5.4" } else { "kimi-smoke" };
    *state.config.write().unwrap() = ConfigSnapshot {
        tools: vec![],
        agent_cache: false,
        revision: 1,
        capability_contract: None,
        policy: None,
        policy_blocked: false,
        agents: vec![AgentRelease {
            id: "rel_smoke".into(),
            agent: agent.clone(),
            version: if is_codex { "0.164.0" } else { "2.3.0" }.into(),
            os: onex_core::ipc::os_name().into(),
            arch: onex_core::ipc::arch_name().into(),
            url: "http://127.0.0.1:1/unused".into(),
            sha256: digest,
            size: artifact_len,
        }],
        routes: vec![Route {
            model: model.into(),
            model_id: "mod_smoke".into(),
            provider_id: "prv_smoke".into(),
            protocol: if is_codex { "openai_chat" } else { "anthropic" }.into(),
            base_url: format!("http://{provider_addr}"),
            upstream_model: None,
            auth: UpstreamAuth::Bearer,
            proxy: None,
            input_capabilities: None,
        }],
        rates: vec![Rate {
            model_id: "mod_smoke".into(),
            input_milli_per_mtok: 1_000_000,
            output_milli_per_mtok: 1_000_000,
            cache_read_milli_per_mtok: 1_000_000,
            cache_write_milli_per_mtok: 1_000_000,
            effective_from: None,
        }],
    };
    state.secrets.write().unwrap().insert("prv_smoke".into(), "fake-upstream".into());
    let outbox = Arc::new(Outbox::open(&dir.path().join("outbox.sqlite")).unwrap());
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let router_addr = listener.local_addr().unwrap();
    let app = Router::new(state.clone(), "unused-global".into(), http.clone(), tx).app();
    let router = tokio::spawn(axum::serve(listener, app).into_future());
    let shutdown = CancellationToken::new();
    let socket = dir.path().join("onexd.sock");
    let local = ipc::bind(&socket).await.unwrap();
    let daemon = tokio::spawn(ipc::serve(
        local,
        socket.clone(),
        Arc::new(Ipc {
            state: state.clone(),
            outbox: outbox.clone(),
            launch: Some(ipc::LaunchCtx::new(dir.path().to_path_buf(), http)),
            router_addr: Some(router_addr.to_string()),
            server_url: None,
            credentials: None,
            identity_transition: Default::default(),
            shutdown: shutdown.clone(),
        }),
    ));
    assert_eq!(ipc_call(&socket, json!({"cmd":"login","token":"fake-device-token"})).await["ok"], true);
    state
        .lease
        .grant(&Lease {
            model_budgets: Default::default(),
            commerce_plan_id: None,
            id: "m".into(),
            re: None,
            lease_id: "lse_smoke".into(),
            expires_at: format_ms(now_ms() + 100_000),
            budget_milli: 500_000,
            seq: 1,
        })
        .unwrap();
    let launch = ipc_call(&socket,json!({"cmd":"launch","agent":agent,"cwd":cwd,"model":model,"env":{"PATH":"/usr/bin:/bin","TERM":"xterm-256color"}})).await;
    assert_eq!(launch["ok"], true, "{}", launch["error"]);
    for turn in 0..if is_codex { 1 } else { 2 } {
        let mut command = tokio::process::Command::new(launch["program"].as_str().unwrap());
        command.env_clear().current_dir(&cwd).kill_on_drop(true);
        for (key, value) in launch["env"].as_object().unwrap() {
            command.env(key, value.as_str().unwrap());
        }
        for arg in launch["args"].as_array().unwrap() {
            command.arg(arg.as_str().unwrap());
        }
        if is_codex {
            command.args([
                "exec",
                "--skip-git-repo-check",
                "--json",
                "Use the configured shell tool to check the test environment.",
            ]);
        } else {
            if turn == 1 {
                command.arg("--continue");
            }
            command.args(["--prompt", if turn == 0 { "First fixture question" } else { "Second fixture question" }]);
        }
        let result = tokio::time::timeout(Duration::from_secs(25), command.output()).await.unwrap().unwrap();
        let stdout = String::from_utf8_lossy(&result.stdout);
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            result.status.success(),
            "exit {} stderr {} output {}",
            result.status,
            stderr.chars().take(3500).collect::<String>(),
            stdout.chars().take(2000).collect::<String>()
        );
        assert!(
            stdout.contains(if is_codex { "Codex fixture confirmed" } else { "Kimi fixture confirmed" }),
            "stdout {}",
            stdout.chars().take(1200).collect::<String>()
        );
    }
    let close = ipc_call(&socket, json!({"cmd":"launch_done","launch_id":launch["launch_id"],"exit_code":0})).await;
    assert_eq!(close["ok"], true, "{}", close["error"]);
    assert!(state.launch_tokens.read().unwrap().is_empty());
    let rows = tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let items = outbox.pending(0, 200).unwrap();
            if items.iter().any(|row| row.item["kind"] == "session_end") {
                break items;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("native session did not end");
    let kinds: Vec<_> = rows.iter().filter_map(|row| row.item["kind"].as_str()).collect();
    let gaps: Vec<_> = rows
        .iter()
        .filter(|row| row.item["kind"] == "gap")
        .filter_map(|row| row.item["payload"]["reason"].as_str())
        .collect();
    eprintln!("{agent} transcript kinds={kinds:?}, gaps={gaps:?}");
    assert!(gaps.is_empty(), "unexpected native records: {gaps:?}");
    assert_eq!(kinds.iter().filter(|kind| **kind == "session_start").count(), 1);
    assert!(kinds.contains(&"user_message") && kinds.contains(&"assistant_message"));
    let sid = rows[0].item["session_id"].as_str().unwrap();
    assert_eq!(uuid::Uuid::parse_str(sid).unwrap().get_version_num(), 5);
    let calls = observed.lock().unwrap();
    eprintln!("{agent} native requests: {}", calls.len());
    assert_eq!(calls.len(), 2);
    if is_codex {
        assert!(kinds.contains(&"tool_call") && kinds.contains(&"tool_result"));
        assert!(
            calls[1]["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["content"].as_str().is_some_and(|t| t.contains("token-filtered")))
        );
    } else {
        assert_eq!(kinds.iter().filter(|kind| **kind == "user_message").count(), 2);
        assert_eq!(kinds.iter().filter(|kind| **kind == "assistant_message").count(), 2);
        assert!(gaps.is_empty());
        let home = Path::new(launch["env"]["KIMI_CODE_HOME"].as_str().unwrap());
        assert!(home.join("sessions").is_dir());
        assert!(!home.join("config.toml").exists());
    }
    let records: Vec<_> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
    assert_eq!(records.len(), 2);
    assert!(records.iter().all(|record| record.cost_milli > 0 && record.usage_final));
    assert!(records.iter().all(|record| record.session_id.as_deref() == Some(sid)));
    shutdown.cancel();
    daemon.await.unwrap();
    upstream.abort();
    router.abort();
}
