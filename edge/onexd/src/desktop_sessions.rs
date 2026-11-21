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

use crate::outbox::Outbox;
use crate::router::Router;
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
}

pub(crate) struct Launch {
    pub(crate) device: String,
    pub(crate) agent: String,
    pub(crate) version: String,
    pub(crate) release_id: String,
    pub(crate) model: String,
    pub(crate) workspace_hash: String,
    pub(crate) outbox: Arc<Outbox>,
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
        let launch = Launch {
            device,
            agent,
            version,
            release_id,
            model,
            workspace_hash,
            outbox,
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
        let mut registry = self.0.lock().unwrap();
        if let Some((_, binding)) = registry.claude_models.get(token) {
            return Some(binding.clone());
        }
        registry
            .models
            .remove(token)
            .filter(|grant| grant.expires > std::time::Instant::now())
            .map(|grant| grant.binding)
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
            .receive(&control, Batch { bind_model: true, native_id: native.to_string(), records: vec![] })
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
        if matches!(launch.agent.as_str(), "codex-desktop" | "workbuddy")
            || (batch.bind_model && !matches!(launch.agent.as_str(), "deepseek-desktop" | "claude-desktop"))
        {
            return Ok(None);
        }
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
        let mut seq = cursor.as_ref().and_then(|value| value["seq"].as_u64()).unwrap_or(0);
        let at = crate::pricing::format_ms(crate::outbox::now_ms());
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
                    "agent":launch.agent, "agent_version":launch.version, "model":launch.model,
                    "cwd_hash":launch.workspace_hash, "uuid":null, "parentUuid":null, "sidechain":false, "agent_id":null
                }),
                None,
            ));
        }
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
            }
            events.push(item);
        }
        if !events.is_empty() {
            launch.outbox.append_events_with_cursor(
                events,
                &key,
                &json!({"seq":seq, "workspace_hash":launch.workspace_hash}),
            )?;
        }
        if !batch.bind_model {
            return Ok(Some(None));
        }
        let binding = LaunchBinding {
            session_id: session,
            agent: launch.agent.clone(),
            release_id: Some(launch.release_id.clone()),
            approved_model: Some(launch.model.clone()),
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
        let token = crate::id::token();
        let now = std::time::Instant::now();
        let grant = Grant { owner: credential.to_owned(), expires: now + std::time::Duration::from_secs(60), binding };
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
struct NativeTurn {
    thread_id: Uuid,
    turn_id: Uuid,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TurnChange {
    session: NativeTurn,
    started: bool,
}

fn native_turn(headers: &HeaderMap) -> Option<NativeTurn> {
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
    records: Vec<Record>,
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
            records: vec![Record {
                seq,
                at_ms: None,
                kind,
                text: "visible fixture".into(),
                call_id: None,
                tool: None,
                failed: false,
                truncated: false,
            }],
        }
    }

    #[test]
    fn tool_results_keep_the_native_time_and_do_not_issue_a_model_grant() {
        let tmp = tempfile::tempdir().unwrap();
        let outbox = Arc::new(Outbox::open(&tmp.path().join("outbox.sqlite")).unwrap());
        let sessions = DesktopSessions::default();
        start(&sessions, "launch", "workspace", &outbox);
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
        let id = registry.model(&old).unwrap().session_id;
        assert!(registry.model(&old).is_none());
        let different = registry.receive("before", batch("other", 1, Kind::User)).unwrap().unwrap().unwrap();
        assert_ne!(registry.model(&different).unwrap().session_id, id);
        let unspent = registry.receive("before", batch("native", 1, Kind::User)).unwrap().unwrap().unwrap();
        registry.stop("before");
        assert!(registry.model(&unspent).is_none());
        assert!(registry.model(&old).is_none());
        assert!(registry.model(&different).is_none());

        start(&registry, "outside", "another-workspace", &outbox);
        assert!(registry.receive("outside", batch("native", 5, Kind::Assistant)).unwrap().is_none());
        start(&registry, "after", "workspace", &outbox);
        let fresh = registry.receive("after", batch("native", 1, Kind::User)).unwrap().unwrap().unwrap();
        assert_ne!(fresh, old);
        let binding = registry.model(&fresh).unwrap();
        assert_eq!(binding.session_id, id);
        assert_eq!(binding.approved_model.as_deref(), Some("managed-model"));
        registry.receive("after", batch("native", 4, Kind::Assistant)).unwrap();
        let rows = outbox.pending(0, 30).unwrap();
        assert_eq!(rows.len(), 5);
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
        assert_eq!(request(&helper, "/v1/messages", model, native).await.unwrap().status(), 200);
        let first_usage = usage.recv().await.unwrap();
        assert!(first_usage.usage_final);
        assert_eq!(first_usage.cost_milli, 3);
        state.desktop_sessions.stop("before");
        assert_eq!(request(&first, "/v1/messages", model, native).await.unwrap().status(), 401);
        assert_eq!(request(&helper, "/v1/messages", model, native).await.unwrap().status(), 401);
        let second = bind("after", 2);
        assert_ne!(second, first);
        assert_eq!(request(&second, "/v1/messages", model, native).await.unwrap().status(), 200);
        let second_usage = usage.recv().await.unwrap();
        assert_eq!(second_usage.session_id, first_usage.session_id);
        assert_eq!(second_usage.cost_milli, 3);
        state.config.write().unwrap().agents.clear();
        assert_eq!(request(&second, "/v1/messages", model, native).await.unwrap().status(), 403);
        assert!(usage.try_recv().is_err());
        server.abort();
        upstream.abort();
    }
}
