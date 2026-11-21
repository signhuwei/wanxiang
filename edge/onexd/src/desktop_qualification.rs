//! Explicit native macOS qualification. The GUI opens against a temporary profile
//! and both model calls terminate at the loopback fixture.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use std::path::Path;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use axum::{Json, http::HeaderMap, routing::post};
use onex_core::ws::{AgentRelease, Lease, Rate, Route, UpstreamAuth};
use serde_json::{Value, json};
use tokio::net::TcpListener;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use crate::desktop_launch;
use crate::{
    outbox::{Outbox, now_ms},
    pricing::format_ms,
    router::Router,
    state::State,
};

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const INPUT_PLUGIN: &str = r#"
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
export const name = 'onex-qualification-input'
export const inject = ['sessionController','workspaceRegistry']
export function apply(ctx, config) {
  const timer = setTimeout(async () => {
    try {
      const signal = AbortSignal.timeout(60000)
      let sessionId
      if (existsSync(config.marker)) sessionId = readFileSync(config.marker, 'utf8')
      else {
        const workspace = await ctx.workspaceRegistry.create(config.workspace)
        const result = await ctx.sessionController.create({workspaceId:workspace.id}, signal)
        sessionId = result.sessionId
        writeFileSync(config.marker, sessionId, {flag:'wx', mode:0o600})
      }
      await ctx.sessionController.prompt({ sessionId, requestId:crypto.randomUUID(), mode:'followup',
        content:[{type:'text', text:config.input}] }, signal)
    } catch (error) { writeFileSync(config.failure, error.message, {mode:0o600}) }
  }, 4000)
  ctx.on('dispose', () => clearTimeout(timer))
}
"#;

async fn reply(headers: HeaderMap, Json(body): Json<Value>) -> ([(&'static str, &'static str); 1], String) {
    assert_eq!(headers["authorization"], "Bearer fixture-upstream");
    assert_eq!(body["model"], "wire-model");
    assert!(!headers.contains_key("x-conversation-request-id"));
    assert!(!headers.contains_key("x-api-key"));
    let chunks = [
        json!({"id":"fixture","model":"wire-model","choices":[{"index":0,"delta":{"role":"assistant","content":"verified reply"},"finish_reason":null}]}),
        json!({"id":"fixture","model":"wire-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}),
        json!({"id":"fixture","model":"wire-model","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}),
    ];
    let mut frames = chunks.iter().map(|chunk| format!("data: {chunk}\n\n")).collect::<String>();
    frames.push_str("data: [DONE]\n\n");
    ([("content-type", "text/event-stream")], frames)
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn manifest_release(agent: &str, sha256: Option<&str>) -> anyhow::Result<AgentRelease> {
    let list: Vec<Value> = serde_json::from_str(include_str!("../../../server/src/desktop-qualifications.json"))?;
    let mut builds = list.into_iter().filter(|row| {
        row["agent"] == agent
            && row["os"] == "darwin"
            && row["arch"] == "arm64"
            && sha256.is_none_or(|digest| row["sha256"] == digest)
    });
    let mut chosen = builds.next().ok_or_else(|| anyhow::anyhow!("no matching native candidate"))?;
    anyhow::ensure!(builds.next().is_none(), "select the exact QA build with its SHA-256");
    chosen["id"] = "qa-native".into();
    chosen["url"] = "/v1/edge/agent-artifacts/qa-native".into();
    Ok(serde_json::from_value(chosen)?)
}

fn fixture_release(agent: &str) -> AgentRelease {
    AgentRelease {
        id: "fixture-release".into(),
        agent: agent.into(),
        version: "fixture".into(),
        os: "darwin".into(),
        arch: "arm64".into(),
        url: "/v1/edge/agent-artifacts/fixture-release".into(),
        sha256: "a".repeat(64),
        size: 1,
    }
}

async fn router_fixture(
    release: &AgentRelease,
) -> anyhow::Result<(Arc<State>, String, tokio::sync::mpsc::UnboundedReceiver<crate::router::UsageRecord>)> {
    let upstream = TcpListener::bind("127.0.0.1:0").await?;
    let base_url = format!("http://{}/v1", upstream.local_addr()?);
    tokio::spawn(async move {
        axum::serve(upstream, axum::Router::new().route("/v1/chat/completions", post(reply))).await.unwrap();
    });

    let state = Arc::new(State::default());
    {
        let mut config = state.config.write().unwrap();
        config.agents.push(release.clone());
        config.routes.push(Route {
            model: "onex-qa".into(),
            model_id: "model".into(),
            provider_id: "loopback".into(),
            protocol: "openai_chat".into(),
            base_url,
            upstream_model: Some("wire-model".into()),
            auth: UpstreamAuth::Bearer,
            proxy: None,
        });
        config.rates.push(Rate {
            model_id: "model".into(),
            input_milli_per_mtok: 1_000_000,
            output_milli_per_mtok: 2_000_000,
            cache_read_milli_per_mtok: 0,
            cache_write_milli_per_mtok: 0,
            effective_from: None,
        });
    }
    state.secrets.write().unwrap().insert("loopback".into(), "fixture-upstream".into());
    state.lease.grant(&Lease {
        id: "message".into(),
        re: None,
        lease_id: "qa-lease".into(),
        seq: 1,
        expires_at: format_ms(now_ms() + 600_000),
        budget_milli: 5_000_000,
        model_budgets: Default::default(),
        commerce_plan_id: None,
    })?;
    let (tx, usage) = tokio::sync::mpsc::unbounded_channel();
    let server = Router::new(state.clone(), crate::id::token(), reqwest::Client::new(), tx).app();
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?.to_string();
    tokio::spawn(async move {
        axum::serve(listener, server).await.unwrap();
    });

    Ok((state, addr, usage))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[test]
#[ignore = "requires the original local WorkBuddy DMG and the app mounted from it"]
fn original_workbuddy_container_and_apple_signature_match_manifest() -> anyhow::Result<()> {
    use sha2::{Digest, Sha256};
    let mut image = std::fs::File::open(std::env::var("ONEX_WORKBUDDY_QA_DMG")?)?;
    let mut hash = Sha256::new();
    let bytes = std::io::copy(&mut image, &mut hash)?;
    let digest = crate::capture::hex(&hash.finalize());
    let release = manifest_release("workbuddy", Some(&digest))?;
    anyhow::ensure!(bytes == release.size, "WorkBuddy container size differs from its manifest");
    let bundle = super::Bundle::candidate(&release).unwrap();
    bundle.verify(Path::new(&std::env::var("ONEX_WORKBUDDY_QA_BUNDLE")?))?;
    Ok(())
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "opens a signed DeepSeek GUI twice; set ONEX_DEEPSEEK_QA_BUNDLE to its mounted app"]
async fn original_gui_restores_native_session_and_settles_each_turn() -> anyhow::Result<()> {
    let bundle_path = std::env::var("ONEX_DEEPSEEK_QA_BUNDLE")?;
    let release = manifest_release("deepseek-desktop", std::env::var("ONEX_DEEPSEEK_QA_SHA256").ok().as_deref())?;
    let entry = super::Bundle::candidate(&release).unwrap().verify(Path::new(&bundle_path))?;
    let root = tempfile::tempdir()?;
    let cwd = root.path().join("workspace");
    std::fs::create_dir(&cwd)?;
    let (state, addr, mut usage) = router_fixture(&release).await?;
    let outbox = Arc::new(Outbox::open(&root.path().join("outbox.sqlite"))?);
    let marker = root.path().join("native-id");
    let failure = root.path().join("input-error");
    let mut original = None;
    for turn in 1..=2 {
        let launch_token = crate::id::token();
        let input = format!("native qualification turn {turn}");
        let desktop_launch::Prepared { launch, workspace, runtime: _runtime, .. } = desktop_launch::prepare(
            &desktop_launch::Request {
                owner: "qa-device",
                home: root.path(),
                agent: &release.agent,
                entry: &entry,
                cwd: &cwd,
                token: &launch_token,
                model_bearer: None,
                router: &addr,
                model: "onex-qa",
            },
            None,
        )?;
        let plugin = launch.run_dir.join("qualification.mjs");
        std::fs::write(&plugin, INPUT_PLUGIN)?;
        let patch_file = launch.config_dir.join("profiles/desktop/cordis.patch.yml");
        let mut patch: Vec<Value> = serde_json::from_slice(&std::fs::read(&patch_file)?)?;
        patch.push(json!({"insert":[{"id":"onex-qualification-input","name":reqwest::Url::from_file_path(plugin).unwrap().as_str(),
            "config":{"workspace":cwd,"marker":marker,"failure":failure,"input":input}}]}));
        std::fs::write(patch_file, serde_json::to_vec(&patch)?)?;
        state.desktop_sessions.start(
            launch_token.clone(),
            "qa-device".into(),
            release.agent.clone(),
            release.version.clone(),
            release.id.clone(),
            "onex-qa".into(),
            workspace,
            outbox.clone(),
        );
        let mut child = tokio::process::Command::new(&entry)
            .args(&launch.args)
            .env_clear()
            .envs(&launch.env)
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let accepted = tokio::time::timeout(Duration::from_secs(120), async {
            loop {
                if let Ok(message) = std::fs::read_to_string(&failure) {
                    anyhow::bail!("native prompt failed: {message}")
                }
                let rows = outbox.pending(0, 128)?;
                let replies = rows
                    .iter()
                    .filter(|row| {
                        row.item["kind"] == "assistant_message" && row.item["payload"]["content"] == "verified reply"
                    })
                    .count();
                if replies == turn {
                    let request = usage.recv().await.unwrap();
                    let session = request.session_id.as_deref().unwrap();
                    let native_id = std::fs::read_to_string(&marker)?;
                    assert_eq!(session, crate::native_capture::session_id("qa-device", &release.agent, &native_id));
                    assert!(state.desktop_sessions.is_ready(&launch_token));
                    assert!(rows.iter().all(|row| row.item["session_id"] == session));
                    assert_eq!(rows.iter().filter(|row| row.item["kind"] == "session_start").count(), 1);
                    assert_eq!(rows.iter().filter(|row| row.item["kind"] == "user_message").count(), turn);
                    assert!(rows.iter().any(|row| row.item["payload"]["content"] == input));
                    assert!(request.usage_final);
                    assert_eq!(request.cost_milli, 7);
                    assert_eq!((request.tokens.input, request.tokens.output), (3, 2));
                    let ledger = state.lease.snapshot();
                    assert_eq!(ledger.used_milli, turn as i64 * 7);
                    assert_eq!(ledger.inflight_milli, 0);
                    assert_eq!(request.lease_id.as_deref(), Some("qa-lease"));
                    if let Some(id) = &original {
                        assert_eq!(id, session)
                    }
                    original = Some(session.to_owned());
                    return Ok::<_, anyhow::Error>(());
                }
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
        })
        .await;
        // A normal termination gives the vendor's native writer time to close and unlock its journal.
        let stopped =
            std::process::Command::new("/bin/kill").args(["-TERM", &child.id().unwrap().to_string()]).status()?;
        assert!(stopped.success());
        tokio::time::timeout(Duration::from_secs(15), child.wait()).await??;
        state.desktop_sessions.stop(&launch_token);
        crate::launch::finish(root.path(), &launch.launch_id)?;
        accepted??;
    }
    Ok(())
}

#[tokio::test]
async fn staged_workbuddy_interleaved_requests_bill_only_the_registered_native_turn() -> anyhow::Result<()> {
    let release = fixture_release("workbuddy");
    let (state, addr, mut usage) = router_fixture(&release).await?;
    state.config.write().unwrap().routes[0].model = "wire-model".into();
    assert!(state.workbuddy_turns.start("control", "model", "device", &release.id, "wire-model"));
    let root = tempfile::tempdir()?;
    let config = root.path().join("config");
    let project = config.join("projects/fixture");
    let workspace = root.path().join("work");
    std::fs::create_dir_all(&project)?;
    std::fs::create_dir(&workspace)?;
    let workspace = workspace.canonicalize()?;
    let outbox = Arc::new(Outbox::open(&root.path().join("outbox.sqlite"))?);
    let capture = Arc::new(crate::workbuddy_capture::Capture::new(
        &config,
        &workspace,
        "device",
        &release.version,
        "wire-model",
        outbox.clone(),
    )?);
    state.desktop_sessions.start(
        "control".into(),
        "device".into(),
        release.agent.clone(),
        release.version.clone(),
        release.id.clone(),
        "wire-model".into(),
        "workspace".into(),
        outbox.clone(),
    );
    state.desktop_sessions.attach_workbuddy_capture("control", capture.clone());
    let a = "0198a1b2c3d47e5f8a9b0c1d2e3f4a5b";
    let b = "0198a1b2c3d47e5f8a9b0c1d2e3f4a5c";
    let client = reqwest::Client::builder().no_proxy().build()?;
    let callback = |key: &str, sid: &str, generation: &str, event: &str| {
        client
            .post(format!("http://{addr}/v1/onex/workbuddy/turn"))
            .bearer_auth(key)
            .json(&json!({"native_id":sid,"generation_id":generation,"event":event,"source":{"project":"fixture","cwd":workspace}}))
    };
    assert!(!callback("model", "task-a", a, "UserPromptSubmit").send().await?.status().is_success());
    let missing_source = client
        .post(format!("http://{addr}/v1/onex/workbuddy/turn"))
        .bearer_auth("control")
        .json(&json!({"native_id":"task-a","generation_id":a,"event":"UserPromptSubmit"}))
        .send()
        .await?;
    assert_eq!(missing_source.status(), 422);
    for (sid, generation) in [("task-a", a), ("task-b", b)] {
        callback("control", sid, generation, "UserPromptSubmit").send().await?.error_for_status()?;
        let row = json!({"type":"message","sessionId":sid,"cwd":workspace,"role":"user","content":[{"type":"input_text","text":sid}]});
        std::fs::write(project.join(format!("{sid}.jsonl")), format!("{row}\n"))?;
    }
    assert!(state.desktop_sessions.is_ready("control"));
    let call = |id: &str| {
        client
            .post(format!("http://{addr}/v1/chat/completions"))
            .bearer_auth("model")
            .header("X-Conversation-Request-ID", id)
            .json(&json!({"model":"wire-model","stream":true,"messages":[{"role":"user","content":"fixture"}]}))
    };
    for (id, native) in [(b, "task-b"), (a, "task-a"), (b, "task-b")] {
        let response = call(id).send().await?.error_for_status()?;
        assert!(response.text().await?.contains("verified reply"));
        let record = tokio::time::timeout(Duration::from_secs(5), usage.recv()).await?.unwrap();
        assert_eq!(record.session_id, Some(crate::native_capture::session_id("device", "workbuddy", native)));
        assert_eq!(record.cost_milli, 7);
    }
    assert_eq!(state.lease.snapshot().used_milli, 21);
    #[cfg(unix)]
    {
        let stop = tokio_util::sync::CancellationToken::new();
        stop.cancel();
        capture.run(stop).await;
        let rows = outbox.pending(0, 20)?;
        assert_eq!(rows.len(), 4);
        for sid in ["task-a", "task-b"] {
            let session = crate::native_capture::session_id("device", "workbuddy", sid);
            assert!(rows.iter().any(|r| r.item["session_id"] == session
                && r.item["kind"] == "user_message"
                && r.item["payload"]["content"] == sid));
        }
    }
    let forbidden = client
        .post(format!("http://{addr}/v1/chat/completions"))
        .bearer_auth("model")
        .header("X-Conversation-Request-ID", a)
        .json(&json!({"model":"non-contract-model","messages":[{"role":"user","content":"fixture"}]}))
        .send()
        .await?;
    assert_eq!(forbidden.status(), 403);
    assert_eq!(forbidden.json::<serde_json::Value>().await?["error"]["code"], "model_not_allowed");
    assert_eq!(call(a).header("X-Conversation-Request-ID", b).send().await?.status(), 401);
    assert_eq!(call("unregistered").send().await?.status(), 401);
    callback("control", "task-b", b, "Stop").send().await?.error_for_status()?;
    assert_eq!(call(b).send().await?.status(), 401);
    assert_eq!(state.lease.snapshot().used_milli, 21);

    // S3 regression: replacing an active grant with a wildcard must immediately revoke its old model name.
    {
        let mut config = state.config.write().unwrap();
        config.routes[0].model = "*".into();
        config.routes[0].upstream_model = Some("other-upstream".into());
    }
    let denied = call(a).send().await?;
    assert_eq!(denied.status(), 403);
    assert_eq!(denied.json::<Value>().await?["error"]["code"], "model_not_allowed");
    assert_eq!(state.lease.snapshot().used_milli, 21);
    state.config.write().unwrap().routes[0].upstream_model = Some("wire-model".into());
    let vendor_call = |model: &str| {
        client
            .post(format!("http://{addr}/v1/chat/completions"))
            .header("x-api-key", "model")
            .header("X-Conversation-Request-ID", a)
            .json(&json!({"model":model,"stream":true,"messages":[{"role":"user","content":"fixture"}]}))
    };
    assert_eq!(vendor_call("custom-local:other").send().await?.status(), 403);
    assert_eq!(vendor_call("custom-local:wire-model").bearer_auth("other").send().await?.status(), 403);
    assert_eq!(state.lease.snapshot().used_milli, 21);
    let allowed = vendor_call("custom-local:wire-model").send().await?;
    assert_eq!(allowed.status(), 200);
    assert!(allowed.text().await?.contains("verified reply"));
    assert_eq!(usage.recv().await.unwrap().cost_milli, 7);
    assert_eq!(state.lease.snapshot().used_milli, 28);
    Ok(())
}

#[tokio::test]
async fn codex_desktop_responses_bill_the_declared_native_turn_and_recheck_the_grant() -> anyhow::Result<()> {
    let release = fixture_release("codex-desktop");
    let (state, addr, mut usage) = router_fixture(&release).await?;
    let dir = tempfile::tempdir()?;
    let outbox = Arc::new(Outbox::open(&dir.path().join("events.sqlite"))?);
    let control = "codex-control";
    state.desktop_sessions.start(
        control.into(),
        "device".into(),
        release.agent.clone(),
        release.version.clone(),
        release.id.clone(),
        "onex-qa".into(),
        "workspace".into(),
        outbox,
    );
    let thread = "019b7c8c-5786-7f4a-a8ba-80525131b6a2";
    let turn = "019b7c8c-5786-7f4a-a8ba-80525131b6a3";
    let session = json!({"thread_id":thread, "turn_id":turn});
    let key = crate::desktop_sessions::codex_model_token(control);
    let client = reqwest::Client::builder().no_proxy().build()?;
    client
        .post(format!("http://{addr}/v1/onex/desktop/codex-turn"))
        .bearer_auth(control)
        .json(&json!({"session":session,"started":true}))
        .send()
        .await?
        .error_for_status()?;
    let call = |model: &str| {
        client
            .post(format!("http://{addr}/v1/responses"))
            .bearer_auth(&key)
            .header("x-codex-turn-metadata", session.to_string())
            .json(&json!({"model":model,"stream":true,"input":"fixture"}))
    };
    assert_eq!(call("unapproved").send().await?.status(), 403);
    assert_eq!(call("onex-qa").header("thread-id", turn).send().await?.status(), 403);
    let reply = call("onex-qa").send().await?.error_for_status()?.text().await?;
    assert!(reply.contains("response.completed"));
    let event = tokio::time::timeout(Duration::from_secs(5), usage.recv()).await?.unwrap();
    assert_eq!(event.session_id, Some(crate::native_capture::session_id("device", "codex-desktop", thread)));
    assert_eq!(event.cost_milli, 7);
    assert_eq!(state.lease.snapshot().used_milli, 7);
    state.config.write().unwrap().agents.clear();
    assert_eq!(call("onex-qa").send().await?.status(), 403);
    assert_eq!(state.lease.snapshot().used_milli, 7);
    Ok(())
}
