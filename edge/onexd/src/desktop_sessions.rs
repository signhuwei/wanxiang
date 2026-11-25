//! A desktop adapter identifies a native session before obtaining the model
//! credential for it. Native event sequence and the outbox advance together.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use axum::body::Bytes;
use axum::extract::State as AxState;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::watch;
use uuid::Uuid;

use crate::outbox::{DesktopActivity, Outbox, desktop_launch_key, now_ms};
use crate::router::{AgentProtocol, Router};
use crate::state::LaunchBinding;

#[derive(Default)]
pub struct DesktopSessions(Mutex<Registry>, watch::Sender<()>);

#[derive(Default)]
struct Registry {
    launches: HashMap<String, Launch>,
    models: HashMap<String, Grant>,
    codex_models: HashMap<String, String>,
    claude_windows: HashMap<String, String>,
    claude_models: HashMap<String, (Uuid, LaunchBinding)>,
}

struct Grant {
    owner: String,
    expires: std::time::Instant,
    binding: LaunchBinding,
    protocol: AgentProtocol,
    documents: Vec<PromptDocument>,
}

pub(crate) struct Launch {
    pub(crate) device: String,
    pub(crate) agent: String,
    pub(crate) version: String,
    pub(crate) release_id: String,
    pub(crate) model: String,
    pub(crate) workspace_hash: String,
    pub(crate) outbox: Arc<Outbox>,
    deepseek_models: HashMap<String, AgentProtocol>,
    turns: HashMap<Uuid, Uuid>,
    claude_profile: Option<crate::claude_desktop::Profile>,
    claude_transcripts: HashMap<Uuid, (String, std::path::PathBuf)>,
    claude_tokens: HashMap<Uuid, String>,
    workbuddy_capture: Option<Arc<crate::workbuddy_capture::Capture>>,
    ready: bool,
}

pub(crate) fn codex_model_token(control: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"onex-codex-desktop-model\0");
    digest.update(control.as_bytes());
    crate::capture::hex(&digest.finalize())
}

pub(crate) fn claude_model_token(control: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"onex-claude-desktop-model\0");
    digest.update(control.as_bytes());
    crate::capture::hex(&digest.finalize())
}

impl DesktopSessions {
    pub(crate) fn start(
        &self,
        token: String,
        device: String,
        agent: String,
        version: String,
        release_id: String,
        model: String,
        workspace_hash: String,
        outbox: Arc<Outbox>,
    ) {
        let deepseek_models = if agent == "deepseek-desktop" {
            HashMap::from([(model.clone(), AgentProtocol::Chat)])
        } else {
            HashMap::new()
        };
        let launch = Launch {
            device,
            agent,
            version,
            release_id,
            model,
            workspace_hash,
            outbox,
            deepseek_models,
            turns: HashMap::new(),
            claude_profile: None,
            claude_transcripts: HashMap::new(),
            claude_tokens: HashMap::new(),
            workbuddy_capture: None,
            ready: false,
        };
        let mut registry = self.0.lock().unwrap();
        if launch.agent == "codex-desktop" {
            registry.codex_models.insert(codex_model_token(&token), token.clone());
        }
        registry.launches.insert(token, launch);
    }

    pub(crate) fn set_deepseek_models(&self, control: &str, models: &[crate::desktop_launch::DeepSeekModel]) {
        let mut registry = self.0.lock().unwrap();
        if let Some(launch) = registry.launches.get_mut(control).filter(|launch| launch.agent == "deepseek-desktop") {
            launch.deepseek_models = models
                .iter()
                .filter(|model| matches!(model.api, AgentProtocol::Chat | AgentProtocol::Messages))
                .map(|model| (model.name.clone(), model.api))
                .collect();
        }
    }

    pub(crate) fn stop(&self, token: &str) {
        let mut registry = self.0.lock().unwrap();
        if let Some(launch) = registry.launches.remove(token) {
            registry.codex_models.remove(&codex_model_token(token));
            registry.claude_windows.remove(&claude_model_token(token));
            for key in launch.claude_tokens.values() {
                registry.claude_models.remove(key);
            }
            self.1.send_replace(());
        }
        registry.models.retain(|_, grant| grant.owner != token);
    }

    pub(crate) fn clear(&self) {
        *self.0.lock().unwrap() = Registry::default();
        self.1.send_replace(());
    }

    pub(crate) fn model(&self, token: &str) -> Option<LaunchBinding> {
        self.0.lock().unwrap().claude_models.get(token).map(|(_, binding)| binding.clone())
    }

    pub(crate) fn take_deepseek_prompt(
        &self,
        headers: &HeaderMap,
        protocol: AgentProtocol,
    ) -> Option<(LaunchBinding, Vec<PromptDocument>)> {
        let token = deepseek_token(headers, protocol)?;
        let mut registry = self.0.lock().unwrap();
        let grant = registry.models.get(token)?;
        if grant.protocol != protocol || grant.expires <= std::time::Instant::now() {
            return None;
        }
        let grant = registry.models.remove(token)?;
        Some((grant.binding, grant.documents))
    }

    pub(crate) fn claude_native_id(&self, headers: &HeaderMap) -> Option<Uuid> {
        Some(self.0.lock().unwrap().claude_models.get(bearer(headers)?)?.0)
    }

    pub(crate) fn register_claude_window(&self, control: &str, profile: crate::claude_desktop::Profile) {
        let mut registry = self.0.lock().unwrap();
        if let Some(launch) = registry.launches.get_mut(control).filter(|launch| launch.agent == "claude-desktop") {
            launch.claude_profile = Some(profile);
            registry.claude_windows.insert(claude_model_token(control), control.to_owned());
        }
    }

    pub(crate) fn attach_workbuddy_capture(&self, control: &str, capture: Arc<crate::workbuddy_capture::Capture>) {
        if let Some(launch) = self.0.lock().unwrap().launches.get_mut(control).filter(|l| l.agent == "workbuddy") {
            launch.workbuddy_capture = Some(capture);
        }
    }

    pub(crate) async fn register_workbuddy_source(
        &self,
        control: &str,
        native_id: &str,
        source: crate::workbuddy_capture::Source,
    ) -> bool {
        let Some(capture) = self.0.lock().unwrap().launches.get(control).and_then(|l| l.workbuddy_capture.clone())
        else {
            return false;
        };
        let native_id = native_id.to_owned();
        tokio::task::spawn_blocking(move || capture.register(&native_id, source))
            .await
            .is_ok_and(|result| result.is_ok())
            && self.mark_ready(control)
    }

    pub(crate) fn is_claude_window(&self, headers: &HeaderMap) -> bool {
        bearer(headers).is_some_and(|token| self.0.lock().unwrap().claude_windows.contains_key(token))
    }

    pub(crate) async fn bind_claude_window(
        &self,
        headers: &HeaderMap,
        native: Uuid,
        model: &str,
    ) -> Option<LaunchBinding> {
        let (control, profile) = {
            let registry = self.0.lock().unwrap();
            let control = registry.claude_windows.get(bearer(headers)?)?;
            let launch = registry.launches.get(control)?;
            if model != launch.model || native.is_nil() {
                return None;
            }
            (control.clone(), launch.claude_profile.clone()?)
        };
        let model = model.to_owned();
        let path = tokio::task::spawn_blocking(move || {
            let transcript = profile.transcript(native, &model)?;
            if profile.session_record(native, &model).is_some() {
                tracing::debug!(native_session = %native, "Claude Desktop confirmed its GUI session record");
            }
            Some(transcript)
        })
        .await
        .ok()??;
        let token = self
            .receive(
                &control,
                Batch {
                    bind_model: true,
                    native_id: native.to_string(),
                    model: None,
                    records: vec![],
                    documents: vec![],
                },
            )
            .ok()???;
        let mut registry = self.0.lock().unwrap();
        let binding = registry.claude_models.get(&token)?.1.clone();
        let launch = registry.launches.get_mut(&control)?;
        launch.claude_transcripts.insert(native, (binding.session_id.clone(), path));
        if !launch.ready {
            tracing::info!(agent = %launch.agent, "native desktop adapter ready");
            launch.ready = true;
        }
        Some(binding)
    }

    pub(crate) fn claude_transcripts(&self, control: &str) -> Vec<(Uuid, String, std::path::PathBuf)> {
        self.0
            .lock()
            .unwrap()
            .launches
            .get(control)
            .into_iter()
            .flat_map(|launch| launch.claude_transcripts.iter())
            .map(|(native, (session, path))| (*native, session.clone(), path.clone()))
            .collect()
    }

    pub(crate) fn is_ready(&self, token: &str) -> bool {
        self.0.lock().unwrap().launches.get(token).is_some_and(|launch| launch.ready)
    }

    fn mark_ready(&self, token: &str) -> bool {
        let mut registry = self.0.lock().unwrap();
        let Some(launch) = registry.launches.get_mut(token) else { return false };
        if !launch.ready {
            tracing::info!(agent = %launch.agent, "native desktop adapter ready");
            launch.ready = true;
        }
        true
    }

    fn receive(&self, credential: &str, batch: Batch) -> Result<Option<Option<String>>> {
        let mut registry = self.0.lock().unwrap();
        let Some(launch) = registry.launches.get_mut(credential) else { return Ok(None) };
        let deepseek = launch.agent == "deepseek-desktop";
        if matches!(launch.agent.as_str(), "codex-desktop" | "workbuddy")
            || (batch.bind_model && !matches!(launch.agent.as_str(), "deepseek-desktop" | "claude-desktop"))
            || (!batch.documents.is_empty() && !deepseek)
            || (batch.model.is_some() && (!deepseek || !batch.bind_model))
        {
            return Ok(None);
        }
        let chosen_model = batch.model.as_deref().unwrap_or(&launch.model);
        let deepseek_protocol = if deepseek && batch.bind_model {
            let Some(protocol) = launch.deepseek_models.get(chosen_model).copied() else { return Ok(None) };
            Some(protocol)
        } else {
            None
        };
        let claude_native_id = if launch.agent == "claude-desktop" {
            let Some(native) = Uuid::parse_str(&batch.native_id)
                .ok()
                .filter(|id| !id.is_nil() && id.hyphenated().to_string() == batch.native_id)
            else {
                return Ok(None);
            };
            Some(native)
        } else {
            None
        };
        let session = crate::native_capture::session_id(&launch.device, &launch.agent, &batch.native_id);
        let key = format!("desktop:{session}");
        let cursor = launch.outbox.cursor(&key)?;
        // The plugin scans the whole managed journal to recover late writes.
        // A scan alone cannot start a previously unbound desktop session.
        if deepseek && cursor.is_none() && !batch.bind_model {
            return Ok(None);
        }
        let mut seq = cursor.as_ref().and_then(|value| value["seq"].as_u64()).unwrap_or(0);
        let observed = now_ms();
        let at = crate::pricing::format_ms(observed);
        let mut events = Vec::new();
        let event = |kind, payload, offset: Option<u64>| json!({"session_id":session, "kind":kind, "payload":payload, "source_offset":offset, "at":at});
        if let Some(saved) = &cursor {
            if saved["workspace_hash"] != launch.workspace_hash {
                return Ok(None);
            }
        } else {
            events.push(event(
                "session_start",
                json!({
                    "agent":launch.agent, "agent_version":launch.version, "model":chosen_model,
                    "cwd_hash":launch.workspace_hash, "uuid":null, "parentUuid":null, "sidechain":false, "agent_id":null
                }),
                None,
            ));
        }
        let new_stage = events.len();
        for record in batch.records {
            if record.seq <= seq {
                continue;
            }
            seq = record.seq;
            let (kind, mut payload) = match record.kind {
                Kind::User => ("user_message", json!({ "content": record.text })),
                Kind::Assistant => ("assistant_message", json!({ "content": record.text })),
                Kind::ToolCall => (
                    "tool_call",
                    json!({
                        "tool_call_id": record.call_id, "tool": record.tool,
                        "input": serde_json::from_str::<serde_json::Value>(&record.text).unwrap_or_else(|_| record.text.into()),
                    }),
                ),
                Kind::ToolResult => (
                    "tool_result",
                    json!({
                        "tool_call_id": record.call_id, "output": record.text, "is_error": record.failed,
                    }),
                ),
            };
            if record.truncated {
                payload["truncated"] = true.into();
            }
            payload["uuid"] = format!("{session}:{}", record.seq).into();
            payload["sidechain"] = false.into();
            let mut item = event(kind, payload, Some(record.seq));
            if let Some(time) = record.at_ms {
                item["at"] = crate::pricing::format_ms(time).into();
            } else if deepseek {
                item["at"] = serde_json::Value::Null;
            }
            events.push(item);
        }
        let next = json!({"seq":seq, "workspace_hash":launch.workspace_hash});
        if deepseek && (!events.is_empty() || batch.bind_model) {
            if !launch.outbox.append_desktop_events(
                events,
                &key,
                &next,
                None,
                DesktopActivity {
                    session: &session,
                    launch: &desktop_launch_key(credential),
                    live_from: batch.bind_model.then_some(new_stage),
                    at_ms: observed,
                },
            )? {
                return Ok(None);
            }
        } else if !events.is_empty() {
            launch.outbox.append_events_with_cursor(events, &key, &next)?;
        }
        if !batch.bind_model {
            return Ok(Some(None));
        }
        let binding = LaunchBinding {
            session_id: session,
            agent: launch.agent.clone(),
            release_id: Some(launch.release_id.clone()),
            approved_model: Some(chosen_model.to_owned()),
            first_native_session: None,
        };
        if let Some(native) = claude_native_id {
            if let Some(token) = launch.claude_tokens.get(&native) {
                return Ok(Some(Some(token.clone())));
            }
            if launch.claude_tokens.len() >= 512 {
                return Ok(None);
            }
            let token = crate::id::token();
            launch.claude_tokens.insert(native, token.clone());
            registry.claude_models.insert(token.clone(), (native, binding));
            return Ok(Some(Some(token)));
        }
        let Some(protocol) = deepseek_protocol else { return Ok(None) };
        let token = crate::id::token();
        let now = std::time::Instant::now();
        let grant = Grant {
            owner: credential.to_owned(),
            expires: now + std::time::Duration::from_secs(60),
            binding,
            protocol,
            documents: batch.documents,
        };
        registry.models.retain(|_, grant| grant.expires > now);
        if registry.models.len() >= 512 {
            return Ok(None);
        }
        registry.models.insert(token.clone(), grant);
        Ok(Some(Some(token)))
    }
    fn observe_codex_turn(&self, credential: &str, change: TurnChange) -> bool {
        let mut registry = self.0.lock().unwrap();
        let Some(launch) = registry.launches.get_mut(credential).filter(|launch| launch.agent == "codex-desktop")
        else {
            return false;
        };
        let native = change.session;
        if change.started {
            if launch.turns.len() >= 32 && !launch.turns.contains_key(&native.thread_id) {
                return false;
            }
            launch.turns.insert(native.thread_id, native.turn_id);
        } else if launch.turns.get(&native.thread_id) == Some(&native.turn_id) {
            launch.turns.remove(&native.thread_id);
        }
        self.1.send_replace(());
        true
    }

    pub(crate) async fn codex_response(&self, headers: &HeaderMap) -> Result<Option<LaunchBinding>, ()> {
        let Some(token) = bearer(headers) else { return Ok(None) };
        let mut changed = self.1.subscribe();
        if !self.0.lock().unwrap().codex_models.contains_key(token) {
            return Ok(None);
        }
        let native = native_turn(headers).ok_or(())?;
        if headers.contains_key("x-api-key") {
            return Err(());
        }
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                {
                    let registry = self.0.lock().unwrap();
                    let control = registry.codex_models.get(token).ok_or(())?;
                    let launch = registry.launches.get(control).ok_or(())?;
                    if let Some(turn) = launch.turns.get(&native.thread_id) {
                        if *turn != native.turn_id {
                            return Err(());
                        }
                        let session_id = crate::native_capture::session_id(
                            &launch.device,
                            &launch.agent,
                            &native.thread_id.to_string(),
                        );
                        return Ok(Some(LaunchBinding {
                            session_id,
                            agent: launch.agent.clone(),
                            first_native_session: None,
                            approved_model: Some(launch.model.clone()),
                            release_id: Some(launch.release_id.clone()),
                        }));
                    }
                }
                changed.changed().await.map_err(|_| ())?;
            }
        })
        .await
        .map_err(|_| ())?
    }
}

#[derive(Deserialize)]
pub(crate) struct NativeTurn {
    pub(crate) thread_id: Uuid,
    turn_id: Uuid,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TurnChange {
    session: NativeTurn,
    started: bool,
}

pub(crate) fn native_turn(headers: &HeaderMap) -> Option<NativeTurn> {
    if headers.get_all("x-codex-turn-metadata").iter().count() != 1 || headers.get_all("thread-id").iter().count() > 1 {
        return None;
    }
    let raw = headers.get("x-codex-turn-metadata")?.as_bytes();
    if raw.len() > 4096 {
        return None;
    }
    let turn: NativeTurn = serde_json::from_slice(raw).ok()?;
    if turn.thread_id.is_nil() || turn.turn_id.is_nil() {
        return None;
    }
    if let Some(thread) = headers.get("thread-id")
        && thread.as_bytes() != turn.thread_id.to_string().as_bytes()
    {
        return None;
    }
    Some(turn)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Batch {
    bind_model: bool,
    native_id: String,
    model: Option<String>,
    records: Vec<Record>,
    #[serde(default)]
    documents: Vec<PromptDocument>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PromptDocument {
    name: String,
    marker: String,
    text: String,
}

/// Substitute only handles produced by the original prompt. A changed vendor
/// serialization is surfaced before sending a request with missing contents.
pub(crate) fn project_prompt_documents(
    body: &mut serde_json::Value,
    documents: &[PromptDocument],
) -> Result<(), &'static str> {
    if documents.is_empty() {
        return Ok(());
    }
    let Some(messages) = body["messages"].as_array_mut() else { return Err("缺少包含附件的原生消息。") };
    let mut seen = vec![false; documents.len()];
    let mut inserted = 0;
    let mut project = |value: &mut serde_json::Value| -> Result<(), &'static str> {
        let Some(mut source) = value.as_str() else { return Ok(()) };
        let mut result = String::new();
        while let Some((start, index, document)) = documents
            .iter()
            .enumerate()
            .filter_map(|(index, document)| source.find(&document.marker).map(|at| (at, index, document)))
            .min_by_key(|(at, _, _)| *at)
        {
            inserted += document.name.len() + document.text.len() + 48;
            if inserted > 256 * 1024 {
                return Err("本次请求的附件展开内容超过大小限制。");
            }
            result.push_str(&source[..start]);
            result.push_str(&format!("[附件 {} 的文本]\n{}\n[附件结束]", document.name, document.text));
            seen[index] = true;
            source = &source[start + document.marker.len()..];
        }
        if !result.is_empty() {
            result.push_str(source);
            *value = result.into();
        }
        Ok(())
    };
    for message in messages.iter_mut().filter(|item| matches!(item["role"].as_str(), Some("user" | "tool"))) {
        let Some(content) = message.get_mut("content") else { continue };
        if let Some(blocks) = content.as_array_mut() {
            for block in blocks.iter_mut().filter(|block| block["type"] == "text") {
                project(&mut block["text"])?;
            }
        } else {
            project(content)?;
        }
    }
    if seen.into_iter().all(|item| item) { Ok(()) } else { Err("附件与原生消息不匹配，请重试。") }
}

pub(crate) fn accepts_images(route: &onex_core::ws::Route) -> bool {
    route.protocol == "openai_chat"
        && route.input_capabilities.as_ref().is_some_and(|capability| {
            capability.modalities.contains(&onex_core::ws::InputModality::Image)
                && capability
                    .valid_until
                    .as_deref()
                    .is_none_or(|expiry| crate::pricing::parse_ms(expiry).is_some_and(|time| time > now_ms()))
        })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    seq: u64,
    #[serde(default)]
    at_ms: Option<i64>,
    kind: Kind,
    text: String,
    #[serde(default)]
    call_id: Option<String>,
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    failed: bool,
    #[serde(default)]
    truncated: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    User,
    Assistant,
    ToolCall,
    ToolResult,
}

impl Batch {
    fn valid(&self) -> bool {
        !self.native_id.is_empty()
            && self.native_id.len() <= 128
            && self.native_id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
            && self.model.as_ref().is_none_or(|model| {
                self.bind_model
                    && !model.trim().is_empty()
                    && model.len() <= 1024
                    && !model.chars().any(char::is_control)
            })
            && (self.bind_model || self.documents.is_empty())
            && self.documents.len() <= 8
            && self.documents.iter().map(|file| file.text.len()).sum::<usize>() <= 128 * 1024
            && self.documents.iter().all(|file| {
                !file.name.is_empty()
                    && file.name.len() <= 255
                    && !file.name.chars().any(char::is_control)
                    && !file.marker.is_empty()
                    && file.marker.len() <= 4096
                    && !file.text.trim().is_empty()
                    && file.text.len() <= 64 * 1024
                    && !file.text.contains('\0')
            })
            && self.records.len() <= 32
            && self.records.iter().all(|record| {
                let name = |value: &Option<String>| value.as_ref().is_some_and(|s| !s.is_empty() && s.len() <= 256);
                record.seq > 0
                    && record.at_ms.is_none_or(|time| (0..=253402300799999).contains(&time))
                    && record.text.len() <= 48 * 1024
                    && match record.kind {
                        Kind::User | Kind::Assistant => {
                            !record.text.is_empty() && record.call_id.is_none() && record.tool.is_none()
                        }
                        Kind::ToolCall => name(&record.call_id) && name(&record.tool),
                        Kind::ToolResult => name(&record.call_id) && record.tool.is_none(),
                    }
            })
            && self.records.windows(2).all(|pair| pair[0].seq < pair[1].seq)
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    if headers.get_all(header::AUTHORIZATION).iter().count() != 1 {
        return None;
    }
    headers.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ")
}

fn deepseek_token(headers: &HeaderMap, protocol: AgentProtocol) -> Option<&str> {
    match protocol {
        AgentProtocol::Chat => {
            if headers.contains_key("x-api-key") {
                return None;
            }
            bearer(headers)
        }
        AgentProtocol::Messages => {
            let mut keys = headers.get_all("x-api-key").iter();
            let key = keys.next().map(|value| value.to_str()).transpose().ok()?;
            if keys.next().is_some() {
                return None;
            }
            if headers.contains_key(header::AUTHORIZATION) {
                let token = bearer(headers)?;
                key.is_none_or(|value| value == token).then_some(token)
            } else {
                key
            }
        }
        AgentProtocol::Responses => None,
    }
}

pub(crate) async fn ready(AxState(rt): AxState<Arc<Router>>, headers: HeaderMap) -> StatusCode {
    if bearer(&headers).is_some_and(|token| rt.state.desktop_sessions.mark_ready(token)) {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::UNAUTHORIZED
    }
}

pub(crate) async fn codex_turn(AxState(rt): AxState<Arc<Router>>, headers: HeaderMap, body: Bytes) -> StatusCode {
    let Some(credential) = bearer(&headers) else { return StatusCode::UNAUTHORIZED };
    let Ok(change) = serde_json::from_slice::<TurnChange>(&body) else { return StatusCode::UNPROCESSABLE_ENTITY };
    if change.session.thread_id.is_nil() || change.session.turn_id.is_nil() {
        return StatusCode::UNPROCESSABLE_ENTITY;
    }
    if rt.state.desktop_sessions.observe_codex_turn(credential, change) {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::UNAUTHORIZED
    }
}

pub(crate) async fn ingest(AxState(rt): AxState<Arc<Router>>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(credential) = bearer(&headers).map(str::to_owned) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Ok(batch) = serde_json::from_slice::<Batch>(&body) else {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    };
    if !batch.valid() {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    match tokio::task::spawn_blocking(move || rt.state.desktop_sessions.receive(&credential, batch)).await {
        Ok(Ok(Some(token))) => axum::Json(json!({"model_token":token})).into_response(),
        Ok(Ok(None)) => StatusCode::FORBIDDEN.into_response(),
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start(registry: &DesktopSessions, token: &str, workspace: &str, outbox: &Arc<Outbox>) {
        registry.start(
            token.into(),
            "device".into(),
            "deepseek-desktop".into(),
            "test".into(),
            "approved-release".into(),
            "managed-model".into(),
            workspace.into(),
            outbox.clone(),
        );
    }

    fn batch(native_id: &str, seq: u64, kind: Kind) -> Batch {
        Batch {
            bind_model: true,
            native_id: native_id.into(),
            model: None,
            documents: vec![],
            records: vec![Record {
                seq,
                at_ms: Some(now_ms()),
                kind,
                text: "visible fixture".into(),
                call_id: None,
                tool: None,
                failed: false,
                truncated: false,
            }],
        }
    }

    fn chat_binding(registry: &DesktopSessions, token: &str) -> Option<LaunchBinding> {
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, format!("Bearer {token}").parse().unwrap());
        registry.take_deepseek_prompt(&headers, AgentProtocol::Chat).map(|(binding, _)| binding)
    }

    #[test]
    fn deepseek_binds_each_selected_model_to_its_wire_and_keeps_the_native_session() -> Result<()> {
        use crate::desktop_launch::DeepSeekModel;

        let root = tempfile::tempdir()?;
        let outbox = Arc::new(Outbox::open(&root.path().join("events.sqlite"))?);
        let registry = DesktopSessions::default();
        start(&registry, "control", "workspace", &outbox);
        registry.set_deepseek_models(
            "control",
            &[
                DeepSeekModel { name: "managed-model".into(), api: AgentProtocol::Chat, image_input: false },
                DeepSeekModel { name: "second-chat".into(), api: AgentProtocol::Chat, image_input: false },
                DeepSeekModel { name: "managed-messages".into(), api: AgentProtocol::Messages, image_input: false },
            ],
        );
        let make = |model: &str| {
            let mut input = batch("native", 1, Kind::User);
            input.model = Some(model.into());
            input
        };
        assert!(registry.receive("control", make("outside-contract"))?.is_none());
        assert!(outbox.pending(0, 10)?.is_empty());
        let mut unbound = make("managed-messages");
        unbound.bind_model = false;
        assert!(!unbound.valid());
        assert!(registry.receive("control", unbound)?.is_none());

        let first = registry.receive("control", make("second-chat"))?.flatten().unwrap();
        assert!(registry.model(&first).is_none());
        let first_binding = chat_binding(&registry, &first).unwrap();
        assert_eq!(first_binding.approved_model.as_deref(), Some("second-chat"));
        assert!(chat_binding(&registry, &first).is_none());

        let second = registry.receive("control", make("managed-messages"))?.flatten().unwrap();
        assert!(registry.model(&second).is_none());
        assert!(chat_binding(&registry, &second).is_none());
        let mut headers = HeaderMap::new();
        headers.insert("x-api-key", second.parse()?);
        assert!(registry.take_deepseek_prompt(&headers, AgentProtocol::Chat).is_none());
        headers.append("x-api-key", second.parse()?);
        assert!(registry.take_deepseek_prompt(&headers, AgentProtocol::Messages).is_none());
        headers.insert("x-api-key", second.parse()?);
        headers.insert(header::AUTHORIZATION, "Bearer invalid".parse()?);
        assert!(registry.take_deepseek_prompt(&headers, AgentProtocol::Messages).is_none());
        headers.insert(header::AUTHORIZATION, format!("Bearer {second}").parse()?);
        let (second_binding, documents) = registry.take_deepseek_prompt(&headers, AgentProtocol::Messages).unwrap();
        assert!(documents.is_empty());
        assert_eq!(second_binding.approved_model.as_deref(), Some("managed-messages"));
        assert_eq!(first_binding.session_id, second_binding.session_id);
        assert_eq!(first_binding.release_id, second_binding.release_id);
        assert!(registry.take_deepseek_prompt(&headers, AgentProtocol::Messages).is_none());

        let rows = outbox.pending(0, 10)?;
        assert_eq!(rows[0].item["kind"], "session_start");
        assert_eq!(rows[0].item["payload"]["model"], "second-chat");
        assert_eq!(rows.iter().filter(|row| row.item["kind"] == "session_start").count(), 1);
        Ok(())
    }

    #[tokio::test]
    async fn deepseek_routes_chat_and_messages_on_one_native_session_at_the_selected_model_rate() -> Result<()> {
        use crate::desktop_launch::DeepSeekModel;
        use axum::{Json, routing::post};
        use onex_core::ws::{AgentRelease, Lease, Rate, Route, UpstreamAuth};
        use serde_json::Value;
        use tokio::net::TcpListener;

        let upstream_listener = TcpListener::bind("127.0.0.1:0").await?;
        let upstream_url = format!("http://{}", upstream_listener.local_addr()?);
        let upstream_app = axum::Router::new()
            .route(
                "/v1/chat/completions",
                post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                    assert_eq!(headers[header::AUTHORIZATION], "Bearer chat-upstream-key");
                    assert_eq!(body["model"], "managed-model");
                    Json(json!({
                        "id":"chat_fixture","object":"chat.completion","model":"managed-model",
                        "choices":[{"index":0,"message":{"role":"assistant","content":"chat"},"finish_reason":"stop"}],
                        "usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}
                    }))
                }),
            )
            .route(
                "/v1/messages",
                post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                    assert_eq!(headers["x-api-key"], "messages-upstream-key");
                    assert_eq!(body["model"], "messages-model");
                    assert_eq!(
                        body["messages"][0]["content"][0]["text"],
                        "before [附件 notes.txt 的文本]\nfixture contents\n[附件结束] after"
                    );
                    Json(json!({
                        "id":"msg_fixture","type":"message","role":"assistant","model":"messages-model",
                        "content":[{"type":"text","text":"messages"}],"stop_reason":"end_turn",
                        "usage":{"input_tokens":2,"output_tokens":1}
                    }))
                }),
            );
        let upstream_task = tokio::spawn(axum::serve(upstream_listener, upstream_app).into_future());
        let state = Arc::new(crate::state::State::default());
        {
            let mut config = state.config.write().unwrap();
            config.agents.push(AgentRelease {
                id: "approved-release".into(),
                agent: "deepseek-desktop".into(),
                os: "darwin".into(),
                arch: "arm64".into(),
                version: "test".into(),
                url: "/v1/edge/agent-artifacts/approved-release".into(),
                sha256: "a".repeat(64),
                size: 1,
            });
            for (model, protocol, provider, auth, rate) in [
                ("managed-model", "openai_chat", "chat", UpstreamAuth::Bearer, 1_000_000),
                ("messages-model", "anthropic", "messages", UpstreamAuth::XApiKey, 2_000_000),
            ] {
                config.routes.push(Route {
                    model: model.into(),
                    model_id: format!("{provider}-model-id"),
                    provider_id: provider.into(),
                    protocol: protocol.into(),
                    base_url: upstream_url.clone(),
                    upstream_model: Some(model.into()),
                    auth,
                    proxy: None,
                    input_capabilities: None,
                });
                config.rates.push(Rate {
                    model_id: format!("{provider}-model-id"),
                    input_milli_per_mtok: rate,
                    output_milli_per_mtok: rate,
                    cache_read_milli_per_mtok: 0,
                    cache_write_milli_per_mtok: 0,
                    effective_from: None,
                });
                state.secrets.write().unwrap().insert(provider.into(), format!("{provider}-upstream-key"));
            }
        }
        state.lease.grant(&Lease {
            id: "grant".into(),
            re: None,
            lease_id: "lease".into(),
            expires_at: crate::pricing::format_ms(now_ms() + 60_000),
            budget_milli: 10_000,
            seq: 1,
            model_budgets: Default::default(),
            commerce_plan_id: None,
        })?;
        let root = tempfile::tempdir()?;
        let outbox = Arc::new(Outbox::open(&root.path().join("events.sqlite"))?);
        start(&state.desktop_sessions, "launch", "workspace", &outbox);
        state.desktop_sessions.set_deepseek_models(
            "launch",
            &[
                DeepSeekModel { name: "managed-model".into(), api: AgentProtocol::Chat, image_input: false },
                DeepSeekModel { name: "messages-model".into(), api: AgentProtocol::Messages, image_input: false },
            ],
        );

        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let client = reqwest::Client::builder().no_proxy().timeout(std::time::Duration::from_secs(3)).build()?;
        let (usage, mut recorded) = tokio::sync::mpsc::unbounded_channel();
        let app = Router::new(state.clone(), "daemon".into(), client.clone(), usage).app();
        let server = tokio::spawn(axum::serve(listener, app).into_future());
        let grant = |model: &str, documents: Value| {
            client
                .post(format!("{base}/v1/onex/desktop/session"))
                .bearer_auth("launch")
                .json(&json!({
                    "native_id":"native", "bind_model":true, "model":model, "records":[], "documents":documents
                }))
                .send()
        };
        assert_eq!(grant("unapproved", json!([])).await?.status(), StatusCode::FORBIDDEN);
        let chat_token = grant("managed-model", json!([])).await?.error_for_status()?.json::<Value>().await?;
        let chat_token = chat_token["model_token"].as_str().unwrap();
        let messages_token = grant(
            "messages-model",
            json!([{
                "name":"notes.txt","marker":"[[opaque]]","text":"fixture contents"
            }]),
        )
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
        let messages_token = messages_token["model_token"].as_str().unwrap();
        let call_chat = |token: &str| {
            client
                .post(format!("{base}/v1/chat/completions"))
                .bearer_auth(token)
                .json(&json!({
                    "model":"managed-model","max_tokens":8,"messages":[{"role":"user","content":"fixture"}]
                }))
                .send()
        };
        let call_messages = |token: &str| {
            client
                .post(format!("{base}/v1/messages"))
                .header("x-api-key", token)
                .json(&json!({
                    "model":"messages-model","max_tokens":8,
                    "messages":[{"role":"user","content":[{"type":"text","text":"before [[opaque]] after"}]}]
                }))
                .send()
        };
        assert_eq!(call_chat(messages_token).await?.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(call_messages(chat_token).await?.status(), StatusCode::UNAUTHORIZED);
        let chat = call_chat(chat_token).await?.error_for_status()?.json::<Value>().await?;
        assert_eq!(chat["choices"][0]["message"]["content"], "chat");
        let messages = call_messages(messages_token).await?.error_for_status()?.json::<Value>().await?;
        assert_eq!(messages["content"][0]["text"], "messages");
        assert_eq!(call_messages(messages_token).await?.status(), StatusCode::UNAUTHORIZED);

        let chat_usage = recorded.try_recv()?;
        let messages_usage = recorded.try_recv()?;
        assert_eq!((chat_usage.model_id.as_str(), chat_usage.cost_milli), ("chat-model-id", 3));
        assert_eq!((messages_usage.model_id.as_str(), messages_usage.cost_milli), ("messages-model-id", 6));
        assert!(chat_usage.usage_final && messages_usage.usage_final);
        assert_eq!(chat_usage.session_id, messages_usage.session_id);
        assert!(chat_usage.session_id.is_some() && recorded.try_recv().is_err());
        server.abort();
        upstream_task.abort();
        Ok(())
    }

    #[test]
    fn tool_results_keep_the_native_time_and_do_not_issue_a_model_grant() {
        let tmp = tempfile::tempdir().unwrap();
        let outbox = Arc::new(Outbox::open(&tmp.path().join("outbox.sqlite")).unwrap());
        let sessions = DesktopSessions::default();
        start(&sessions, "launch", "workspace", &outbox);
        let binding: Batch = serde_json::from_value(json!({
            "native_id":"original-session", "bind_model":true, "records":[]
        }))
        .unwrap();
        assert!(sessions.receive("launch", binding).unwrap().flatten().is_some());
        let records: Batch = serde_json::from_value(json!({
            "native_id":"original-session", "bind_model":false,
            "records":[
                {"seq":4, "at_ms":1000, "kind":"tool_call", "call_id":"call", "tool":"read",
                    "text":"{\"path\":\"notes.md\"}"},
                {"seq":7, "at_ms":2000, "kind":"tool_result", "call_id":"call", "text":"hello", "failed":false}
            ]
        }))
        .unwrap();
        assert!(records.valid());
        assert_eq!(sessions.receive("launch", records).unwrap(), Some(None));
        let rows = outbox.pending(0, 10).unwrap();
        assert_eq!(rows[1].item["payload"]["input"]["path"], "notes.md");
        assert_eq!(rows[2].item["at"], crate::pricing::format_ms(2000));
        assert_eq!(rows[2].item["payload"]["tool_call_id"], "call");
        assert_eq!(rows[2].item["source_offset"], 7);
    }

    #[test]
    fn reopened_native_session_keeps_its_identity_and_reads_each_event_once() {
        let root = tempfile::tempdir().unwrap();
        let outbox = Arc::new(Outbox::open(&root.path().join("events.sqlite")).unwrap());
        let registry = DesktopSessions::default();
        start(&registry, "before", "workspace", &outbox);
        let old = registry.receive("before", batch("native", 1, Kind::User)).unwrap().unwrap().unwrap();
        let id = chat_binding(&registry, &old).unwrap().session_id;
        assert!(chat_binding(&registry, &old).is_none());
        let different = registry.receive("before", batch("other", 1, Kind::User)).unwrap().unwrap().unwrap();
        assert_ne!(chat_binding(&registry, &different).unwrap().session_id, id);
        let unspent = registry.receive("before", batch("native", 1, Kind::User)).unwrap().unwrap().unwrap();
        registry.stop("before");
        outbox.close_desktop_sessions(Some(&desktop_launch_key("before")), Some(now_ms())).unwrap();
        assert!(chat_binding(&registry, &unspent).is_none());
        assert!(chat_binding(&registry, &old).is_none());
        assert!(chat_binding(&registry, &different).is_none());

        start(&registry, "outside", "another-workspace", &outbox);
        assert!(registry.receive("outside", batch("native", 5, Kind::Assistant)).unwrap().is_none());
        start(&registry, "after", "workspace", &outbox);
        let fresh = registry.receive("after", batch("native", 1, Kind::User)).unwrap().unwrap().unwrap();
        assert_ne!(fresh, old);
        let binding = chat_binding(&registry, &fresh).unwrap();
        assert_eq!(binding.session_id, id);
        assert_eq!(binding.approved_model.as_deref(), Some("managed-model"));
        registry.receive("after", batch("native", 4, Kind::Assistant)).unwrap();
        let rows = outbox.pending(0, 30).unwrap();
        let kinds: Vec<_> = rows
            .iter()
            .filter(|row| row.item["session_id"] == id)
            .map(|row| row.item["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["session_start", "user_message", "session_end", "session_resume", "assistant_message"]);
        assert_eq!(rows.len(), 8);
    }

    #[test]
    fn deepseek_scan_preserves_the_first_new_prompt_until_the_native_turn_binds() -> Result<()> {
        let root = tempfile::tempdir()?;
        let outbox = Arc::new(Outbox::open(&root.path().join("events.sqlite"))?);
        let registry = DesktopSessions::default();
        start(&registry, "before", "workspace", &outbox);
        let make = |native_id: &str, bind_model, seq: Option<u64>, at_ms| Batch {
            native_id: native_id.to_owned(),
            bind_model,
            model: None,
            documents: vec![],
            records: seq
                .map(|seq| Record {
                    seq,
                    at_ms,
                    kind: Kind::User,
                    text: format!("fixture {seq}"),
                    call_id: None,
                    tool: None,
                    failed: false,
                    truncated: false,
                })
                .into_iter()
                .collect(),
        };
        assert!(registry.receive("before", make("unbound", false, Some(1u64), Some(1)))?.is_none());
        assert!(outbox.pending(0, 10)?.is_empty());
        registry.receive("before", make("native", true, Some(1), Some(1)))?;
        registry.stop("before");
        drop(outbox);
        let outbox = Arc::new(Outbox::open(&root.path().join("events.sqlite"))?);
        outbox.recover_desktop_sessions()?;
        let rows = outbox.pending(0, 10)?;
        assert_eq!(rows.last().unwrap().item["payload"]["reason"], "daemon_restart");
        let last = rows.last().unwrap();
        let closed = crate::pricing::parse_ms(last.item["at"].as_str().unwrap()).unwrap();

        start(&registry, "after", "workspace", &outbox);
        // A passive scan cannot advance past the prompt that just awakened this session.
        assert!(registry.receive("after", make("native", false, Some(2), Some(closed + 1)))?.is_none());
        assert_eq!(outbox.pending(0, 10)?, rows);
        registry.receive("after", make("native", true, None, None))?;
        registry.receive("after", make("native", false, Some(2), Some(closed + 1)))?;
        registry.receive("after", make("native", false, Some(3), None))?;
        let rows = outbox.pending(0, 10)?;
        assert_eq!(rows[3].item["kind"], "session_resume");
        assert_eq!(rows[4].item["payload"]["content"], "fixture 2");
        assert_eq!(rows[4].item["at"], crate::pricing::format_ms(closed + 1));
        assert_eq!(rows.len(), 5, "unproven historic records cannot reappear after recovery");
        Ok(())
    }
    #[tokio::test]
    async fn codex_bills_exact_thread_and_turn_and_retires_the_launch_credential() {
        let root = tempfile::tempdir().unwrap();
        let outbox = Arc::new(Outbox::open(&root.path().join("events.sqlite")).unwrap());
        let registry = DesktopSessions::default();
        let start = |credential: &str| {
            registry.start(
                credential.into(),
                "device".into(),
                "codex-desktop".into(),
                "test".into(),
                "approved-release".into(),
                "approved-model".into(),
                "workspace".into(),
                outbox.clone(),
            )
        };
        let thread_id = "019b7c8c-5786-7f4a-a8ba-80525131b6a2".parse().unwrap();
        let turn_id = "019b7c8c-5786-7f4a-a8ba-80525131b6a3".parse().unwrap();
        let change = |started| TurnChange { session: NativeTurn { thread_id, turn_id }, started };
        let headers = |credential| {
            let mut headers = HeaderMap::new();
            headers.insert(header::AUTHORIZATION, format!("Bearer {}", codex_model_token(credential)).parse().unwrap());
            headers.insert(
                "x-codex-turn-metadata",
                json!({"thread_id":thread_id, "turn_id":turn_id,
                "session_id":"root-is-irrelevant", "root_turn_id":"root-turn-is-irrelevant"})
                .to_string()
                .parse()
                .unwrap(),
            );
            headers
        };
        start("before");
        let before = headers("before");
        let wrong = {
            let mut headers = before.clone();
            headers.insert("thread-id", "019b7c8c-5786-7f4a-a8ba-80525131b6a4".parse().unwrap());
            headers
        };
        assert!(!registry.observe_codex_turn(&codex_model_token("before"), change(true)));
        assert!(registry.observe_codex_turn("before", change(true)));
        assert!(registry.codex_response(&wrong).await.is_err());
        let id = registry.codex_response(&before).await.unwrap().unwrap().session_id;
        registry.stop("before");
        assert!(registry.codex_response(&before).await.unwrap().is_none());

        start("after");
        let after = headers("after");
        let (binding, _) = tokio::join!(registry.codex_response(&after), async {
            tokio::task::yield_now().await;
            assert!(registry.observe_codex_turn("after", change(true)));
        });
        let binding = binding.unwrap().unwrap();
        assert_eq!(binding.session_id, id);
        assert_eq!(binding.approved_model.as_deref(), Some("approved-model"));
        assert_eq!(binding.release_id.as_deref(), Some("approved-release"));
        assert!(registry.receive("after", batch("wrong-capture-path", 1, Kind::User)).unwrap().is_none());
    }

    #[tokio::test]
    async fn claude_messages_require_the_bound_native_session_model_and_release() {
        use onex_core::ws::{AgentRelease, Lease, Rate, Route, UpstreamAuth};
        use tokio::net::TcpListener;

        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_url = format!("http://{}", upstream.local_addr().unwrap());
        let app = axum::Router::new().route(
            "/v1/messages",
            axum::routing::post(|| async {
                axum::Json(json!({"id":"msg_fixture", "type":"message", "role":"assistant",
                "content":[{"type":"text", "text":"fixture"}], "stop_reason":"end_turn",
                "usage":{"input_tokens":2, "output_tokens":1}}))
            }),
        );
        let upstream = tokio::spawn(async move { axum::serve(upstream, app).await.unwrap() });

        let state = Arc::new(crate::state::State::default());
        let model = "claude-sonnet-5-5";
        let release = AgentRelease {
            id: "approved-release".into(),
            agent: "claude-desktop".into(),
            os: "darwin".into(),
            arch: "arm64".into(),
            version: "6.28899.6".into(),
            url: "/v1/edge/agent-artifacts/approved-release".into(),
            sha256: "a".repeat(64),
            size: 1,
        };
        {
            let mut cfg = state.config.write().unwrap();
            cfg.agents.push(release.clone());
            cfg.routes.push(Route {
                model: model.into(),
                model_id: "fixture-model".into(),
                provider_id: "fixture-provider".into(),
                protocol: "anthropic".into(),
                base_url: upstream_url,
                upstream_model: Some(model.into()),
                auth: UpstreamAuth::XApiKey,
                proxy: None,
                input_capabilities: None,
            });
            cfg.rates.push(Rate {
                model_id: "fixture-model".into(),
                input_milli_per_mtok: 1_000_000,
                output_milli_per_mtok: 1_000_000,
                cache_read_milli_per_mtok: 0,
                cache_write_milli_per_mtok: 0,
                effective_from: None,
            });
        }
        state.secrets.write().unwrap().insert("fixture-provider".into(), "fixture-key".into());
        state
            .lease
            .grant(&Lease {
                id: "grant".into(),
                re: None,
                lease_id: "lease".into(),
                expires_at: crate::pricing::format_ms(crate::outbox::now_ms() + 60_000),
                budget_milli: 10_000,
                seq: 1,
                model_budgets: Default::default(),
                commerce_plan_id: None,
            })
            .unwrap();

        let root = tempfile::tempdir().unwrap();
        let outbox = Arc::new(Outbox::open(&root.path().join("events.sqlite")).unwrap());
        let native = "019b7c8c-5786-7f4a-a8ba-80525131b6a2";
        let bind = |control: &str, seq| {
            state.desktop_sessions.start(
                control.into(),
                "device".into(),
                release.agent.clone(),
                release.version.clone(),
                release.id.clone(),
                model.into(),
                "workspace".into(),
                outbox.clone(),
            );
            state.desktop_sessions.receive(control, batch(native, seq, Kind::User)).unwrap().unwrap().unwrap()
        };
        let first = bind("before", 1);
        assert!(state.desktop_sessions.receive("before", batch("bad-native-id", 1, Kind::User)).unwrap().is_none());
        let code = root.path().join("code");
        let project = code.join("projects/workspace");
        let records = root.path().join("records");
        let cwd = root.path().join("workspace");
        for folder in [&code, &project, &records, &cwd] {
            crate::launch::private_dir(folder).unwrap();
        }
        let cwd = cwd.canonicalize().unwrap();
        let code = code.canonicalize().unwrap();
        let records = records.canonicalize().unwrap();
        state
            .desktop_sessions
            .register_claude_window("before", crate::claude_desktop::Profile { code, records, cwd: cwd.clone() });
        let helper = claude_model_token("before");
        let (tx, mut usage) = tokio::sync::mpsc::unbounded_channel();
        let client = reqwest::Client::builder().no_proxy().timeout(std::time::Duration::from_secs(3)).build().unwrap();
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", server.local_addr().unwrap());
        let app = Router::new(state.clone(), "daemon".into(), client.clone(), tx).app();
        let server = tokio::spawn(async move { axum::serve(server, app).await.unwrap() });
        let request = |token: &str, path: &str, requested_model: &str, session: &str| {
            client.post(format!("{base}{path}")).bearer_auth(token).json(&json!({
                "model":requested_model, "max_tokens":32, "messages":[{"role":"user", "content":"fixture"}],
                "metadata":{"user_id":json!({"device_id":"native-device", "account_uuid":"", "session_id":session}).to_string()}
            })).send()
        };
        assert_eq!(request(&first, "/v1/messages", model, "another-session").await.unwrap().status(), 403);
        assert_eq!(request(&first, "/v1/messages", "claude-unapproved", native).await.unwrap().status(), 403);
        for path in ["/v1/responses", "/v1/chat/completions"] {
            assert_eq!(request(&first, path, model, native).await.unwrap().status(), 403);
        }
        assert_eq!(request(&helper, "/v1/messages", model, native).await.unwrap().status(), 403);
        assert!(usage.try_recv().is_err());
        let frame = json!({"type":"user","sessionId":native,"cwd":cwd,"message":{"role":"user","content":"fixture"}});
        crate::launch::write_private(&project.join(format!("{native}.jsonl")), format!("{frame}\n").as_bytes())
            .unwrap();
        // Native Claude Desktop binds only through a private transcript root, which non-Unix builds reject.
        let transcript_status = request(&helper, "/v1/messages", model, native).await.unwrap().status();
        #[cfg(unix)]
        let first_usage = {
            assert_eq!(transcript_status, 200);
            let first_usage = usage.recv().await.unwrap();
            assert!(first_usage.usage_final);
            assert_eq!(first_usage.cost_milli, 3);
            first_usage
        };
        #[cfg(not(unix))]
        assert_eq!(transcript_status, 403);
        state.desktop_sessions.stop("before");
        assert_eq!(request(&first, "/v1/messages", model, native).await.unwrap().status(), 401);
        assert_eq!(request(&helper, "/v1/messages", model, native).await.unwrap().status(), 401);
        let second = bind("after", 2);
        assert_ne!(second, first);
        #[cfg(unix)]
        {
            assert_eq!(request(&second, "/v1/messages", model, native).await.unwrap().status(), 200);
            let second_usage = usage.recv().await.unwrap();
            assert_eq!(second_usage.session_id, first_usage.session_id);
            assert_eq!(second_usage.cost_milli, 3);
        }
        state.config.write().unwrap().agents.clear();
        assert_eq!(request(&second, "/v1/messages", model, native).await.unwrap().status(), 403);
        assert!(usage.try_recv().is_err());
        server.abort();
        upstream.abort();
    }
}
