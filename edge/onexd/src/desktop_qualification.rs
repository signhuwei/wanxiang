//! Explicit native qualification. The GUI opens against a temporary profile
//! and both model calls terminate at the loopback fixture.
#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), all(windows, target_arch = "x86_64")))]
use std::path::Path;
#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), all(windows, target_arch = "x86_64")))]
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use axum::{Json, http::HeaderMap, routing::post};
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use base64::{Engine, engine::general_purpose::STANDARD};
use onex_core::ws::{AgentRelease, Lease, Rate, Route, UpstreamAuth};
use serde_json::{Value, json};
use tokio::net::TcpListener;

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), all(windows, target_arch = "x86_64")))]
use crate::desktop_launch;
use crate::{
    outbox::{Outbox, now_ms},
    pricing::format_ms,
    router::Router,
    state::State,
};

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), all(windows, target_arch = "x86_64")))]
const INPUT_PLUGIN: &str = r#"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
export const name = 'onex-qualification-input'
export const inject = ['sessionController','workspaceRegistry','fileUploads']
export function apply(ctx, config) {
  const timer = setTimeout(async () => {
    try {
      for (const prompt of config.prompts) {
        const signal = AbortSignal.timeout(60000)
        let sessionId
        if (existsSync(prompt.marker)) sessionId = readFileSync(prompt.marker, 'utf8')
        else {
          if (prompt.createDirectory) mkdirSync(prompt.workspace)
          const workspace = await ctx.workspaceRegistry.create(prompt.workspace)
          const result = await ctx.sessionController.create({workspaceId:workspace.id}, signal)
          sessionId = result.sessionId
          writeFileSync(prompt.marker, sessionId, {flag:'wx', mode:0o600})
        }
        if (prompt.selected) {
          const result = await ctx.sessionController.selectModel({sessionId, ...prompt.selected})
          if (result.selected?.provider !== prompt.selected.provider || result.selected?.model !== prompt.selected.model) {
            throw new Error('Native session could not select the authorized model')
          }
        }
        const content = [{type:'text', text:prompt.input}]
        if (prompt.image) content.push({type:'image', name:'one.png', mediaType:'image/png', data:prompt.image})
        for (const [name, data] of Object.entries(prompt.files ?? {})) {
          const staged = await ctx.fileUploads.uploadStream({sessionId,name,signal,data:(async function* () { yield Buffer.from(data,'base64') })()})
          content.push({type:'file', receiptId:staged.receiptId})
        }
        await ctx.sessionController.prompt({ sessionId, requestId:crypto.randomUUID(), mode:'followup', content }, signal)
        // The native prompt API can return before the assistant response. Wait for the fixture to observe capture and billing.
        while (!existsSync(prompt.accepted)) await sleep(100, undefined, { signal })
      }
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

async fn anthropic_reply(headers: HeaderMap, Json(body): Json<Value>) -> ([(&'static str, &'static str); 1], String) {
    assert_eq!(headers["x-api-key"], "fixture-upstream");
    assert!(!headers.contains_key("authorization"));
    assert_eq!(body["model"], "wire-claude");
    let chunks = [
        json!({"type":"message_start","message":{"id":"msg_fixture","type":"message","role":"assistant","model":"wire-claude",
            "content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"verified reply"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}),
        json!({"type":"message_stop"}),
    ];
    let frames =
        chunks.iter().map(|event| format!("event: {}\ndata: {event}\n\n", event["type"].as_str().unwrap())).collect();
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
    observe: Option<tokio::sync::mpsc::UnboundedSender<Value>>,
) -> anyhow::Result<(Arc<State>, String, tokio::sync::mpsc::UnboundedReceiver<crate::router::UsageRecord>)> {
    let upstream = TcpListener::bind("127.0.0.1:0").await?;
    let base_url = format!("http://{}/v1", upstream.local_addr()?);
    let images = observe.is_some();
    let observe_messages = observe.clone();
    let route = post(move |headers: HeaderMap, body: Json<Value>| async move {
        if let Some(observe) = observe {
            let _ = observe.send(body.0.clone());
        }
        reply(headers, body).await
    });
    let messages = post(move |headers: HeaderMap, body: Json<Value>| async move {
        if let Some(observe) = observe_messages {
            let _ = observe.send(body.0.clone());
        }
        anthropic_reply(headers, body).await
    });
    tokio::spawn(async move {
        let fixture = axum::Router::new().route("/v1/chat/completions", route).route("/v1/messages", messages);
        axum::serve(upstream, fixture).await.unwrap();
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
            input_capabilities: images.then(|| onex_core::ws::InputCapabilities {
                modalities: vec![onex_core::ws::InputModality::Text, onex_core::ws::InputModality::Image],
                valid_until: None,
            }),
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

#[tokio::test]
async fn deepseek_rejects_unverified_image_routes_and_unmatched_documents() -> anyhow::Result<()> {
    let release = fixture_release("deepseek-desktop");
    let (observed, mut incoming) = tokio::sync::mpsc::unbounded_channel();
    let (state, addr, _) = router_fixture(&release, Some(observed)).await?;
    state.config.write().unwrap().routes[0].input_capabilities.as_mut().unwrap().valid_until =
        Some(format_ms(now_ms() - 1));
    let root = tempfile::tempdir()?;
    let outbox = Arc::new(Outbox::open(&root.path().join("events.sqlite"))?);
    state.desktop_sessions.start(
        "attachment-test".into(),
        "device".into(),
        release.agent,
        release.version,
        release.id,
        "onex-qa".into(),
        "workspace".into(),
        outbox,
    );
    let client = reqwest::Client::builder().no_proxy().build()?;
    for (documents, messages, expected) in [
        (
            json!([]),
            json!([{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,AAE="}}]}]),
            403,
        ),
        (
            json!([{"name":"fixture.txt","marker":"[native file]","text":"must stay local"}]),
            json!([{"role":"user","content":"without the file reference"}]),
            422,
        ),
    ] {
        let grant: Value = client
            .post(format!("http://{addr}/v1/onex/desktop/session"))
            .bearer_auth("attachment-test")
            .json(&json!({"native_id":"native","records":[],"bind_model":true,"documents":documents}))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let response = client
            .post(format!("http://{addr}/v1/chat/completions"))
            .bearer_auth(grant["model_token"].as_str().unwrap())
            .json(&json!({"model":"onex-qa","messages":messages}))
            .send()
            .await?;
        assert_eq!(response.status().as_u16(), expected);
        assert!(incoming.try_recv().is_err());
    }
    Ok(())
}

#[tokio::test]
async fn deepseek_accepts_images_on_verified_native_anthropic_routes() -> anyhow::Result<()> {
    let release = fixture_release("deepseek-desktop");
    let (observed, mut incoming) = tokio::sync::mpsc::unbounded_channel();
    let (state, addr, mut usage) = router_fixture(&release, Some(observed)).await?;
    let choices = {
        let mut config = state.config.write().unwrap();
        let route = &mut config.routes[0];
        route.protocol = "anthropic".into();
        route.auth = UpstreamAuth::XApiKey;
        route.upstream_model = Some("wire-claude".into());
        let choices = crate::ipc::deepseek_model_choices(&config);
        assert_eq!(choices.len(), 1);
        assert!(choices[0].image_input);
        choices
    };
    let root = tempfile::tempdir()?;
    let outbox = Arc::new(Outbox::open(&root.path().join("events.sqlite"))?);
    state.desktop_sessions.start(
        "anthropic-image-test".into(),
        "device".into(),
        release.agent,
        release.version,
        release.id,
        "onex-qa".into(),
        "workspace".into(),
        outbox,
    );
    state.desktop_sessions.set_deepseek_models("anthropic-image-test", &choices);
    let client = reqwest::Client::builder().no_proxy().build()?;
    let grant: Value = client
        .post(format!("http://{addr}/v1/onex/desktop/session"))
        .bearer_auth("anthropic-image-test")
        .json(&json!({"native_id":"native","records":[],"model":"onex-qa","bind_model":true}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let result = client
        .post(format!("http://{addr}/v1/messages"))
        .header("x-api-key", grant["model_token"].as_str().unwrap())
        .json(&json!({
            "model":"onex-qa", "stream":true, "max_tokens":16,
            "messages":[{"role":"user","content":[
                {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAE="}}
            ]}]
        }))
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    assert!(result.contains("verified reply"));
    let sent = tokio::time::timeout(Duration::from_secs(2), incoming.recv()).await?.unwrap();
    assert_eq!(sent["messages"][0]["content"][0]["source"]["data"], "AAE=");
    assert!(tokio::time::timeout(Duration::from_secs(2), usage.recv()).await?.is_some());
    Ok(())
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
    run_original_deepseek(Scenario::Resume, false).await
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "opens a signed DeepSeek GUI; set ONEX_DEEPSEEK_QA_BUNDLE and ONEX_DEEPSEEK_QA_DAEMON"]
async fn original_gui_preserves_image_and_document_prompts() -> anyhow::Result<()> {
    run_original_deepseek(Scenario::Attachments, false).await
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "opens a signed DeepSeek GUI; set ONEX_DEEPSEEK_QA_BUNDLE to its mounted app"]
async fn original_gui_switches_between_three_contract_models() -> anyhow::Result<()> {
    run_original_deepseek(Scenario::Models, false).await
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "opens a signed DeepSeek GUI; set ONEX_DEEPSEEK_QA_BUNDLE to its mounted app"]
async fn original_gui_switches_native_workspaces() -> anyhow::Result<()> {
    run_original_deepseek(Scenario::Workspaces, false).await
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "opens the signed DeepSeek GUI in a disposable native profile; set ONEX_DEEPSEEK_QA_BUNDLE"]
async fn original_gui_lists_managed_skill_before_first_prompt() -> anyhow::Result<()> {
    use sha2::{Digest, Sha256};

    let root = tempfile::tempdir()?;
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace)?;
    let workspace = workspace.canonicalize()?;
    let (release, entry) = original_deepseek_entry()?;
    let (state, addr, _usage) = router_fixture(&release, None).await?;
    let models = crate::ipc::deepseek_model_choices(&state.config.read().unwrap());
    let body = serde_json::to_vec(&json!({"files":[{
        "path":"SKILL.md", "data":STANDARD.encode("---\nname: onex-qa-skill\ndescription: Synthetic managed catalogue proof.\n---\nSynthetic managed body.\n")
    }]}))?;
    let tool: onex_core::ws::ToolRelease = serde_json::from_value(json!({
        "id":crate::id::new("tool"), "name":"onex-qa-skill", "version":"1.0.0", "kind":"skill",
        "agents":["deepseek-desktop"], "args":[], "sha256":format!("{:x}",Sha256::digest(&body)), "size":body.len()
    }))?;
    let skills = [crate::tools::decode(&tool, &body)?];
    let outbox = Arc::new(Outbox::open(&root.path().join("outbox.sqlite"))?);
    let token = crate::id::token();
    let desktop_launch::Prepared { launch, workspace: workspace_hash, .. } = desktop_launch::prepare(
        &desktop_launch::Request {
            owner: "qa-device",
            home: root.path(),
            agent: &release.agent,
            entry: &entry,
            cwd: &workspace,
            token: &token,
            model_bearer: None,
            router: &addr,
            model: "onex-qa",
            deepseek_models: &models,
            tools: &skills,
        },
        None,
    )?;
    let plugin = launch.run_dir.join("catalogue-probe.mjs");
    let receipt = root.path().join("catalogue-result.json");
    std::fs::write(
        &plugin,
        r#"
import { writeFileSync } from 'node:fs'
export const name = 'onex-catalogue-qualification'
export const inject = ['sessionController','sessionSkillCatalog','workspaceRegistry']
export function apply(ctx, config) {
  const timer = setTimeout(async () => {
    try {
      const workspace = await ctx.workspaceRegistry.create(config.workspace)
      const signal = AbortSignal.timeout(10000)
      const {sessionId} = await ctx.sessionController.create({workspaceId:workspace.id}, signal)
      const result = await ctx.sessionSkillCatalog.list({sessionId}, signal)
      writeFileSync(config.receipt, JSON.stringify({names:result.skills.map(skill => skill.name)}), {mode:0o600})
    } catch (error) { writeFileSync(config.receipt, JSON.stringify({error:error.message}), {mode:0o600}) }
  }, 4000)
  ctx.on('dispose', () => clearTimeout(timer))
}
"#,
    )?;
    let profile = launch.config_dir.join("profiles/desktop");
    let patch_path = profile.join("cordis.patch.yml");
    let mut patch: Vec<Value> = serde_json::from_slice(&std::fs::read(&patch_path)?)?;
    patch.push(json!({"insert":[{"id":"onex-catalogue-qualification","name":reqwest::Url::from_file_path(plugin).unwrap().as_str(),
        "config":{"workspace":workspace,"receipt":receipt}}]}));
    std::fs::write(&patch_path, serde_json::to_vec(&patch)?)?;
    state.desktop_sessions.start(
        token.clone(),
        "qa-device".into(),
        release.agent.clone(),
        release.version.clone(),
        release.id.clone(),
        "onex-qa".into(),
        workspace_hash,
        outbox,
    );
    state.desktop_sessions.set_deepseek_models(&token, &models);
    let log = root.path().join("native.log");
    let mut child = tokio::process::Command::new(&entry)
        .env_clear()
        .envs(&launch.env)
        .args(&launch.args)
        .current_dir(&workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(std::fs::File::create(&log)?)
        .kill_on_drop(true)
        .process_group(0)
        .spawn()?;
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if let Ok(raw) = std::fs::read(&receipt) {
                if let Ok(result) = serde_json::from_slice::<Value>(&raw) {
                    return Ok::<_, anyhow::Error>(result);
                }
            }
            anyhow::ensure!(child.try_wait()?.is_none(), "native GUI exited before listing Skills");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await;
    let stopped = stop_original_macos_desktop(&mut child, &profile).await;
    state.desktop_sessions.stop(&token);
    crate::launch::finish(root.path(), &launch.launch_id)?;
    let result = result??;
    anyhow::ensure!(
        result["names"].as_array().is_some_and(|names| names.contains(&json!("onex-qa-skill"))),
        "native Skill list before the first prompt did not include the managed package: {result}"
    );
    stopped?;
    Ok(())
}

#[cfg(all(windows, target_arch = "x86_64"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "opens the original DeepSeek Windows GUI; set ONEX_DEEPSEEK_QA_INSTALLER and ONEX_DEEPSEEK_QA_BUNDLE"]
async fn original_windows_gui_restores_native_session_and_settles_each_turn() -> anyhow::Result<()> {
    verify_windows_protocol_backup()?;
    run_original_deepseek(Scenario::Resume, false).await
}

#[cfg(all(windows, target_arch = "x86_64"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "opens the original DeepSeek Windows GUI; set ONEX_DEEPSEEK_QA_INSTALLER and ONEX_DEEPSEEK_QA_BUNDLE"]
async fn original_windows_gui_switches_native_workspaces() -> anyhow::Result<()> {
    verify_windows_protocol_backup()?;
    run_original_deepseek(Scenario::Workspaces, false).await
}

#[cfg(all(windows, target_arch = "x86_64"))]
fn verify_windows_protocol_backup() -> anyhow::Result<()> {
    let association = std::process::Command::new("reg.exe")
        .args(["query", r"HKCU\Software\Classes\dsh\shell\open\command", "/ve"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    anyhow::ensure!(
        !association.success() || std::env::var("ONEX_DEEPSEEK_QA_PROTOCOL_BACKED_UP").as_deref() == Ok("1"),
        "back up the existing dsh protocol handler before running Windows GUI QA"
    );
    Ok(())
}

#[cfg(all(windows, target_arch = "x86_64"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "opens the packaged DeepSeek Host without the GUI or protocol registration"]
async fn original_windows_host_restores_native_session_and_settles_each_turn() -> anyhow::Result<()> {
    run_original_deepseek(Scenario::Resume, true).await
}

#[cfg(all(windows, target_arch = "x86_64"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "opens the packaged DeepSeek Host without the GUI or protocol registration"]
async fn original_windows_host_switches_native_workspaces() -> anyhow::Result<()> {
    run_original_deepseek(Scenario::Workspaces, true).await
}

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), all(windows, target_arch = "x86_64")))]
#[derive(Clone, Copy, PartialEq, Eq)]
enum Scenario {
    Resume,
    #[cfg(target_os = "macos")]
    Attachments,
    Models,
    Workspaces,
}

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), all(windows, target_arch = "x86_64")))]
struct NativePrompt<'a> {
    workspace: &'a Path,
    marker: &'a Path,
    input: String,
    accepted: std::path::PathBuf,
}

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), all(windows, target_arch = "x86_64")))]
async fn run_original_deepseek(scenario: Scenario, host_only: bool) -> anyhow::Result<()> {
    #[cfg(target_os = "macos")]
    const IMAGE: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGMQL/sPRwzEcQB1UhjB1HLtUgAAAABJRU5ErkJggg==";
    #[cfg(target_os = "macos")]
    const PDF_TEXT: &str = "Onex fixture PDF has cobalt seven";
    #[cfg(target_os = "macos")]
    const TXT_TEXT: &str = "Onex fixture text has amber eleven";
    #[cfg(target_os = "macos")]
    let attachments = scenario == Scenario::Attachments;
    let mixed_models = scenario == Scenario::Models;
    let (release, entry) = original_deepseek_entry()?;
    let root = tempfile::tempdir()?;
    let cwd = root.path().join("workspace");
    let other_cwd = root.path().join("合同 项目");
    std::fs::create_dir(&cwd)?;
    #[cfg(target_os = "macos")]
    let (observed, mut incoming) = tokio::sync::mpsc::unbounded_channel();
    #[cfg(target_os = "macos")]
    let observer = attachments.then_some(observed);
    #[cfg(windows)]
    let observer = None;
    let (state, addr, mut usage) = router_fixture(&release, observer).await?;
    let mut turns = vec![("onex", "onex-qa", "model"); 2];
    state
        .config
        .write()
        .unwrap()
        .model_limits
        .insert("model".into(), serde_json::from_value(json!({"context_window":262144,"max_output_tokens":16384}))?);
    if mixed_models {
        let mut config = state.config.write().unwrap();
        let primary = config.routes[0].clone();
        let rate = config.rates[0].clone();
        let extras = [
            (
                "onex",
                "onex-qa-chat-alt",
                "chat-alt",
                "openai_chat",
                "wire-model",
                UpstreamAuth::Bearer,
                json!({"context_window":131072,"max_output_tokens":8192}),
            ),
            (
                "onex-anthropic",
                "onex-qa-claude",
                "claude",
                "anthropic",
                "wire-claude",
                UpstreamAuth::XApiKey,
                json!({"context_window":200000,"max_output_tokens":12288}),
            ),
        ];
        turns.truncate(1);
        for (provider, model, model_id, protocol, upstream, auth, limits) in extras {
            turns.push((provider, model, model_id));
            config.routes.push(Route {
                model: model.into(),
                model_id: model_id.into(),
                protocol: protocol.into(),
                auth,
                upstream_model: Some(upstream.into()),
                ..primary.clone()
            });
            config.rates.push(Rate { model_id: model_id.into(), ..rate.clone() });
            config.model_limits.insert(model_id.into(), serde_json::from_value(limits)?);
        }
    }
    let models = crate::ipc::deepseek_model_choices(&state.config.read().unwrap());
    let outbox = Arc::new(Outbox::open(&root.path().join("outbox.sqlite"))?);
    let marker = root.path().join("native-id");
    let other_marker = root.path().join("native-id-other");
    let failure = root.path().join("input-error");
    let mut sessions = std::collections::HashMap::<&Path, (String, usize)>::new();
    let mut settled_turns = 0;
    for (index, (provider, selected, model_id)) in turns.into_iter().enumerate() {
        let turn = index + 1;
        let launch_token = crate::id::token();
        let paths = match (scenario, index) {
            (Scenario::Workspaces, 0) => vec![(&cwd, &marker), (&other_cwd, &other_marker), (&cwd, &marker)],
            (Scenario::Workspaces, _) => vec![(&other_cwd, &other_marker)],
            _ => vec![(&cwd, &marker)],
        };
        let prompts = paths
            .into_iter()
            .enumerate()
            .map(|(step, (workspace, marker))| NativePrompt {
                workspace,
                marker,
                input: format!("native qualification launch {turn} prompt {}", step + 1),
                accepted: root.path().join(format!("accepted-{turn}-{step}")),
            })
            .collect::<Vec<_>>();
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
                deepseek_models: &models,
                tools: &[],
            },
            None,
        )?;
        let plugin = launch.run_dir.join("qualification.mjs");
        std::fs::write(&plugin, INPUT_PLUGIN)?;
        let patch_file = launch.config_dir.join("profiles/desktop/cordis.patch.yml");
        let mut patch: Vec<Value> = serde_json::from_slice(&std::fs::read(&patch_file)?)?;
        let providers = &patch.iter().find(|row| row["id"] == "llm-pi-ai").unwrap()["config"]["providers"];
        let qwen = &providers["onex"]["models"][0];
        assert_eq!(
            (qwen["id"].as_str(), qwen["contextWindow"].as_u64(), qwen["maxTokens"].as_u64()),
            (Some("onex-qa"), Some(262144), Some(16384))
        );
        if mixed_models {
            let chat = &providers["onex"]["models"][1];
            assert_eq!(
                (chat["id"].as_str(), chat["contextWindow"].as_u64(), chat["maxTokens"].as_u64()),
                (Some("onex-qa-chat-alt"), Some(131072), Some(8192))
            );
            let claude = &providers["onex-anthropic"]["models"][0];
            assert_eq!(
                (claude["id"].as_str(), claude["contextWindow"].as_u64(), claude["maxTokens"].as_u64()),
                (Some("onex-qa-claude"), Some(200000), Some(12288))
            );
        }
        let test_config = json!({"failure":failure,"prompts":prompts.iter().map(|prompt| json!({
            "workspace":prompt.workspace,"marker":prompt.marker,"input":prompt.input,"accepted":prompt.accepted,
            "createDirectory":prompt.workspace == other_cwd && turn == 1,
            "selected":mixed_models.then(|| json!({"provider":provider,"model":selected}))
        })).collect::<Vec<_>>()});
        #[cfg(target_os = "macos")]
        let mut test_config = test_config;
        #[cfg(target_os = "macos")]
        if attachments {
            for entry in
                patch.iter_mut().filter_map(|row| row.get_mut("insert").and_then(Value::as_array_mut)).flatten()
            {
                if entry["id"] == "onex-managed-session" {
                    entry["config"]["extractor"] = std::env::var("ONEX_DEEPSEEK_QA_DAEMON")?.into();
                }
            }
            if turn == 1 {
                test_config["prompts"][0]["image"] = IMAGE.into();
                let pdf = crate::attachment_pdf::fixture_pdf(1, &format!("BT /F1 16 Tf 20 200 Td ({PDF_TEXT}) Tj ET"));
                test_config["prompts"][0]["files"] =
                    json!({"one.pdf":STANDARD.encode(pdf), "two.txt":STANDARD.encode(TXT_TEXT)});
            }
        }
        patch.push(json!({"insert":[{"id":"onex-qualification-input","name":reqwest::Url::from_file_path(plugin).unwrap().as_str(),
            "config":test_config}]}));
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
        state.desktop_sessions.set_deepseek_models(&launch_token, &models);
        let native_log = root.path().join(format!("native-turn-{turn}.log"));
        let stderr = std::fs::File::create(&native_log)?;
        let mut command = tokio::process::Command::new(&entry);
        command
            .env_clear()
            .envs(&launch.env)
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(if cfg!(windows) { Stdio::inherit() } else { Stdio::from(stderr) })
            .kill_on_drop(true);
        #[cfg(target_os = "macos")]
        command.process_group(0);
        let stop_file = launch.run_dir.join("stop-qualification-host");
        if host_only {
            let wrapper = launch.run_dir.join("qualification-host.cjs");
            std::fs::write(&wrapper, HOST_WRAPPER)?;
            command
                .arg(wrapper)
                .arg(launch.config_dir.join("profiles/desktop"))
                .arg(&stop_file)
                .env("ELECTRON_RUN_AS_NODE", "1")
                .env("DSH_CLIENT_VERSION", &release.version);
        } else {
            command.args(&launch.args);
        }
        let mut child = command.spawn()?;
        eprintln!("native qualification turn {turn}, {provider}/{selected}");
        let accepted = tokio::time::timeout(Duration::from_secs(120), async {
            for prompt in prompts {
                let rows = loop {
                    if let Some(status) = child.try_wait()? {
                        anyhow::bail!("original desktop exited before QA finished: {status}");
                    }
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
                    if replies > settled_turns {
                        assert_eq!(replies, settled_turns + 1);
                        break rows;
                    }
                    tokio::time::sleep(Duration::from_millis(400)).await;
                };
                let request = usage.recv().await.unwrap();
                let session = request.session_id.as_deref().unwrap();
                let native_id = std::fs::read_to_string(prompt.marker)?;
                assert_eq!(session, crate::native_capture::session_id("qa-device", &release.agent, &native_id));
                assert!(state.desktop_sessions.is_ready(&launch_token));
                assert!(sessions.iter().all(|(path, (id, _))| (*path == prompt.workspace) == (id == session)));
                let session_turns = {
                    let entry = sessions.entry(prompt.workspace).or_insert((session.to_owned(), 0));
                    entry.1 += 1;
                    entry.1
                };
                settled_turns += 1;
                assert!(rows.iter().all(|row| sessions.values().any(|(id, _)| row.item["session_id"] == id.as_str())));
                let session_rows = rows.iter().filter(|row| row.item["session_id"] == session).collect::<Vec<_>>();
                let start = session_rows.iter().filter(|row| row.item["kind"] == "session_start").collect::<Vec<_>>();
                assert_eq!(start.len(), 1);
                let workspace = desktop_launch::path_text(&prompt.workspace.canonicalize()?)?;
                assert_eq!(start[0].item["payload"]["cwd_hash"], desktop_launch::workspace_hash(&workspace));
                assert_eq!(session_rows.iter().filter(|row| row.item["kind"] == "user_message").count(), session_turns);
                assert!(session_rows.iter().any(|row| row.item["payload"]["content"]
                    .as_str()
                    .is_some_and(|text| text.contains(&prompt.input))));
                #[cfg(target_os = "macos")]
                if attachments {
                    let body = incoming.try_recv()?;
                    let messages = body["messages"].to_string();
                    assert!(messages.contains(PDF_TEXT), "PDF text missing at the upstream");
                    assert!(messages.contains(TXT_TEXT), "TXT text missing at the upstream");
                    assert!(messages.contains("\"type\":\"image_url\""));
                    assert!(messages.contains("data:image/"));
                    assert!(!messages.contains("verbatim read-only copy saved at"));
                    let journal = rows.iter().map(|row| row.item.to_string()).collect::<String>();
                    assert!(journal.contains("文件附件 one.pdf") && journal.contains("图片附件"));
                    assert!(!journal.contains(PDF_TEXT) && !journal.contains(TXT_TEXT) && !journal.contains(IMAGE));
                }
                assert!(request.usage_final);
                assert_eq!(request.model_id, model_id);
                assert_eq!(request.model, selected);
                assert_eq!(request.cost_milli, 7);
                assert_eq!((request.tokens.input, request.tokens.output), (3, 2));
                let ledger = state.lease.snapshot();
                assert_eq!(ledger.used_milli, settled_turns as i64 * 7);
                assert_eq!(ledger.inflight_milli, 0);
                assert_eq!(request.lease_id.as_deref(), Some("qa-lease"));
                if cfg!(windows) || scenario == Scenario::Workspaces {
                    let runtime = if host_only { "Host" } else { "GUI" };
                    let project = prompt.workspace.file_name().unwrap().to_string_lossy();
                    eprintln!(
                        "verified native {runtime} turn {settled_turns}: workspace={project}, session={session}, cost_milli={}",
                        request.cost_milli
                    );
                }
                if mixed_models {
                    eprintln!("verified native model {provider}/{selected}, cost_milli={}", request.cost_milli);
                }
                std::fs::write(&prompt.accepted, [])?;
            }
            Ok::<_, anyhow::Error>(())
        })
        .await;
        if !matches!(accepted, Ok(Ok(()))) {
            let journal = outbox.pending(0, 128)?;
            let kinds = journal.iter().map(|row| row.item["kind"].as_str()).collect::<Vec<_>>();
            let native_log = std::fs::read_to_string(native_log).unwrap_or_default();
            let last_lines =
                native_log.lines().rev().take(24).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>();
            eprintln!(
                "native turn {turn} diagnostics: ready={}, journal={kinds:?}\n{}",
                state.desktop_sessions.is_ready(&launch_token),
                last_lines.join("\n")
            );
        }
        let stopped = if host_only {
            stop_qualification_host(&mut child, &stop_file).await
        } else {
            #[cfg(target_os = "macos")]
            let stopped = stop_original_macos_desktop(&mut child, &launch.config_dir.join("profiles/desktop")).await;
            #[cfg(windows)]
            let stopped = stop_original_windows_desktop(&mut child).await;
            stopped
        };
        state.desktop_sessions.stop(&launch_token);
        crate::launch::finish(root.path(), &launch.launch_id)?;
        accepted??;
        stopped?;
    }
    Ok(())
}

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), all(windows, target_arch = "x86_64")))]
async fn stop_qualification_host(child: &mut tokio::process::Child, marker: &std::path::Path) -> anyhow::Result<()> {
    std::fs::write(marker, [])?;
    let status = tokio::time::timeout(Duration::from_secs(38), child.wait())
        .await
        .map_err(|_| anyhow::anyhow!("packaged Host did not exit after its shutdown request"))??;
    anyhow::ensure!(status.success(), "packaged host failed to shut down: {status}");
    Ok(())
}

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), all(windows, target_arch = "x86_64")))]
const HOST_WRAPPER: &str = r#"
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');
const [profile, stop] = process.argv.slice(2);
const resources = join(dirname(process.execPath), 'resources');
const packages = join(resources, 'app.asar', 'dsh');
const runtime = join(resources, 'runtime', 'primary-runtime');
const host = join(packages, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js');
const child = spawn(process.execPath, ['--expose-internals', host, packages, profile, runtime,
  join(runtime, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'), join(resources, 'runtime', 'bin')],
  { cwd: profile, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let stopping = false;
let completed = false;
let forced = false;
let deadline;
const timer = setInterval(() => {
  if (stopping || !existsSync(stop)) return;
  stopping = true;
  child.send({ type: 'shutdown' }, error => { if (error) console.error('Could not request packaged Host shutdown'); });
  deadline = setTimeout(() => {
    forced = child.kill();
    console.error(`Packaged Host required termination after shutdown (acknowledged=${completed})`);
  }, 10000);
}, 200);
child.on('message', message => {
  if (message?.type === 'ready') console.error('Packaged Host ready');
  if (message?.type === 'shutdown-complete') {
    completed = true;
    console.error('Packaged Host acknowledged shutdown');
  }
  if (message?.type === 'fatal') console.error('Packaged Host reported a startup error');
});
child.on('disconnect', () => console.error('Packaged Host IPC disconnected'));
child.on('error', error => console.error(error.message));
child.on('exit', code => {
  clearInterval(timer);
  clearTimeout(deadline);
  console.error(`Packaged Host exit: ${code}`);
  process.exitCode = stopping && completed && (code === 0 || forced) ? 0 : 1;
});
"#;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn original_deepseek_entry() -> anyhow::Result<(AgentRelease, std::path::PathBuf)> {
    let path = std::env::var("ONEX_DEEPSEEK_QA_BUNDLE")?;
    let release = manifest_release("deepseek-desktop", std::env::var("ONEX_DEEPSEEK_QA_SHA256").ok().as_deref())?;
    let entry = super::Bundle::candidate(&release).unwrap().verify(Path::new(&path))?;
    Ok((release, entry))
}

#[cfg(all(windows, target_arch = "x86_64"))]
fn original_deepseek_entry() -> anyhow::Result<(AgentRelease, std::path::PathBuf)> {
    use sha2::{Digest, Sha256};

    let identity = |path: &std::path::Path| -> anyhow::Result<(u64, String)> {
        let mut file = std::fs::File::open(path)?;
        let mut hash = Sha256::new();
        let size = std::io::copy(&mut file, &mut hash)?;
        Ok((size, crate::capture::hex(&hash.finalize())))
    };
    let archive = std::env::var("ONEX_DEEPSEEK_QA_INSTALLER")?;
    let (size, sha256) = identity(archive.as_ref())?;
    anyhow::ensure!(
        size == 289_415_960 && sha256 == "1e3876baaa20c3f26371dba7b6873bb70c3ef9b91403f6d3f87d2b27d4fd1e3a",
        "Windows QA requires the exact vendor RC3 installer"
    );
    let bundle = std::path::PathBuf::from(std::env::var("ONEX_DEEPSEEK_QA_BUNDLE")?);
    let entry = bundle.join("DeepSeek Harness.exe");
    anyhow::ensure!(
        identity(&entry)?.1 == "fd7d298f4ba03ee9bab1719a892afeaef5c09bf50c574a592a64c85f64574c0c"
            && identity(&bundle.join("resources/app.asar"))?.1
                == "04b32e3a872826ba15cfb2081c6a929a8d4ecaa65e09a2543e5a6b30e2eff1f0",
        "installed Windows DeepSeek payload differs from the original release"
    );
    Ok((
        AgentRelease {
            id: "qa-native-windows".into(),
            agent: "deepseek-desktop".into(),
            version: "0.2.1-rc.3".into(),
            os: "win32".into(),
            arch: "x64".into(),
            url: "/v1/edge/agent-artifacts/qa-native-windows".into(),
            size,
            sha256,
        },
        entry,
    ))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
async fn original_macos_host_groups(profile: &Path) -> anyhow::Result<Vec<u32>> {
    let profile_text = desktop_launch::path_text(profile)?;
    let canonical_text = desktop_launch::path_text(&profile.canonicalize()?)?;
    let process_list = tokio::process::Command::new("/bin/ps")
        .args(["-axww", "-o", "pgid=", "-o", "state=", "-o", "command="])
        .output()
        .await?;
    anyhow::ensure!(process_list.status.success(), "could not read macOS process groups");
    let output = String::from_utf8_lossy(&process_list.stdout);
    Ok(output
        .lines()
        .filter(|line| {
            line.contains("/@deepseek-ai/dsh-desktop-host/lib/index.js")
                && (line.contains(&profile_text) || line.contains(&canonical_text))
        })
        .filter_map(|line| {
            let mut columns = line.split_whitespace();
            let group = columns.next()?.parse().ok()?;
            (!columns.next()?.starts_with('Z')).then_some(group)
        })
        .collect())
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
async fn stop_original_macos_desktop(child: &mut tokio::process::Child, profile: &Path) -> anyhow::Result<()> {
    let Some(id) = child.id() else {
        anyhow::bail!("original macOS desktop already reaped before shutdown");
    };
    let groups = original_macos_host_groups(profile).await;
    let status = tokio::process::Command::new("/bin/kill").args(["-TERM", &id.to_string()]).status().await?;
    let stop = tokio_util::sync::CancellationToken::new();
    if let Ok(result) =
        tokio::time::timeout(Duration::from_secs(20), crate::macos_desktop_job::wait(child, &stop)).await
    {
        result?;
    } else {
        stop.cancel();
        crate::macos_desktop_job::wait(child, &stop).await?;
        anyhow::bail!("original macOS GUI did not quit after SIGTERM");
    }
    anyhow::ensure!(status.success(), "could not terminate original macOS desktop");
    let groups = groups?;
    assert_eq!(groups, [id], "original DeepSeek Host was not in its fixture GUI group");
    assert!(
        original_macos_host_groups(profile).await?.is_empty(),
        "original DeepSeek Host survived its fixture GUI exit"
    );
    eprintln!("verified original macOS GUI and its native Host stopped after workspace capture");
    Ok(())
}

#[cfg(all(windows, target_arch = "x86_64"))]
async fn stop_original_windows_desktop(child: &mut tokio::process::Child) -> anyhow::Result<()> {
    if let Some(id) = child.id() {
        let stopped = tokio::process::Command::new("taskkill.exe")
            .args(["/PID", &id.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await?;
        anyhow::ensure!(stopped.success(), "original desktop did not terminate");
    }
    tokio::time::timeout(Duration::from_secs(15), child.wait()).await??;
    Ok(())
}

#[tokio::test]
async fn workbuddy_interleaved_requests_bill_only_the_registered_native_task() -> anyhow::Result<()> {
    let release = fixture_release("workbuddy");
    let (state, addr, mut usage) = router_fixture(&release, None).await?;
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
        "control",
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
    let bind = |token: &str, sid: &str| {
        client
            .post(format!("http://{addr}/v1/onex/workbuddy/session"))
            .bearer_auth(token)
            .json(&json!({"native_id":sid,"source":{"project":"fixture","cwd":workspace}}))
    };
    assert_eq!(bind("model", "task-a").send().await?.status(), 403);
    let mut keys = Vec::new();
    for sid in ["task-a", "task-b", "task-a"] {
        let reply: Value = bind("control", sid).send().await?.error_for_status()?.json().await?;
        keys.push(reply["model_token"].as_str().unwrap().to_owned());
    }
    assert_ne!(keys[0], keys[1]);
    assert_eq!(keys[0], keys[2]);
    let task_call = |index: usize| {
        client.post(format!("http://{addr}/v1/chat/completions")).header("x-api-key", keys[index].as_str()).json(
            &json!({"model":"custom-local:wire-model","stream":true,"messages":[{"role":"user","content":"fixture"}]}),
        )
    };
    assert_eq!(task_call(1).header("X-Conversation-Request-ID", a).send().await?.status(), 401);
    for (index, sid) in [(0, "task-a"), (1, "task-b"), (0, "task-a")] {
        let response = task_call(index).send().await?.error_for_status()?;
        assert!(response.text().await?.contains("verified reply"));
        let record = tokio::time::timeout(Duration::from_secs(5), usage.recv()).await?.unwrap();
        assert_eq!(record.session_id, Some(crate::native_capture::session_id("device", "workbuddy", sid)));
        assert_eq!(record.cost_milli, 7);
    }
    state.workbuddy_turns.stop("control");
    assert_eq!(task_call(0).send().await?.status(), 401);
    assert_eq!(state.lease.snapshot().used_milli, 49);
    Ok(())
}

#[tokio::test]
async fn codex_desktop_responses_bill_the_declared_native_turn_and_recheck_the_grant() -> anyhow::Result<()> {
    let release = fixture_release("codex-desktop");
    let (state, addr, mut usage) = router_fixture(&release, None).await?;
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
