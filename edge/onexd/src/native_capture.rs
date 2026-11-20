//! Bind native sessions discovered inside one managed launch to durable OneX IDs.

use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde_json::Value;
use sha1::{Digest, Sha1};
use tokio_util::sync::CancellationToken;
use tracing::warn;
use uuid::Uuid;

use crate::{capture, codex_capture, kimi_capture, outbox::Outbox, state::State};

fn uuid_v5(namespace: Uuid, name: &str) -> Uuid {
    let mut hash = Sha1::new();
    hash.update(namespace.as_bytes());
    hash.update(name.as_bytes());
    let mut bytes: [u8; 16] = hash.finalize()[..16].try_into().expect("16 digest bytes");
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

fn session_id(device: &str, agent: &str, native: &str) -> String {
    uuid_v5(uuid_v5(Uuid::NAMESPACE_DNS, device), &format!("{agent}:{native}")).to_string()
}

#[derive(Clone, Copy)]
pub(crate) enum Agent {
    Codex,
    Kimi,
}

impl Agent {
    fn id(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Kimi => "kimi-code",
        }
    }
}

pub(crate) struct LaunchCapture {
    session: capture::Session,
    state: Arc<State>,
    outbox: Arc<Outbox>,
    token: String,
    device: String,
    first_session: tokio::sync::watch::Sender<Option<String>>,
}

impl LaunchCapture {
    pub(crate) fn new(
        session: capture::Session,
        state: Arc<State>,
        outbox: Arc<Outbox>,
        token: String,
        first_session: tokio::sync::watch::Sender<Option<String>>,
    ) -> Self {
        let device = state
            .conn
            .lock()
            .unwrap()
            .device_id
            .clone()
            .or_else(|| state.expected_device_id.read().unwrap().clone())
            .unwrap_or_else(|| state.device_key.public_b64());
        Self { session, state, outbox, token, device, first_session }
    }

    fn bind_usage(&self, id: String) {
        self.first_session.send_if_modified(|first| {
            if first.is_some() {
                return false;
            }
            *first = Some(id.clone());
            true
        });
        if let Some(current) = self.state.launch_tokens.write().unwrap().get_mut(&self.token) {
            current.session_id = id;
            current.first_native_session = None;
        }
    }

    fn capture(&self, agent: Agent, ending: bool, code: Option<i32>) {
        let sources = match agent {
            Agent::Codex => codex_sources(&self.session.config_dir, &self.session.cwd),
            Agent::Kimi => kimi_sources(&self.session.config_dir, &self.session.cwd),
        };
        let mut last: Option<(SystemTime, String)> = None;
        for (native, path, modified) in sources {
            let id = session_id(&self.device, agent.id(), &native);
            let result = match agent {
                Agent::Codex => {
                    let mut session = self.session.clone();
                    session.session_id.clone_from(&id);
                    let capture = codex_capture::Capture::new(session, path, self.outbox.clone());
                    if ending { capture.end(code) } else { capture.pass() }
                }
                Agent::Kimi => {
                    let capture = kimi_capture::Capture::new(
                        kimi_capture::Session {
                            session_id: id.clone(),
                            session_dir: path,
                            agent_version: self.session.agent_version.clone(),
                            model: self.session.model.clone(),
                            cwd: self.session.cwd.clone(),
                        },
                        self.outbox.clone(),
                    );
                    if ending { capture.end(code) } else { capture.pass().map(|_| ()) }
                }
            };
            if let Err(error) = result {
                warn!(%error, agent = agent.id(), session_id = %id, "native capture failed");
            } else if last.as_ref().is_none_or(|(at, _)| modified >= *at) {
                last = Some((modified, id));
            }
        }
        if let Some((_, id)) = last {
            self.bind_usage(id);
        }
    }

    pub(crate) async fn run(self, agent: Agent, stop: CancellationToken, exit: Arc<Mutex<Option<i32>>>) {
        let capture = Arc::new(self);
        loop {
            let current = capture.clone();
            let _ = tokio::task::spawn_blocking(move || current.capture(agent, false, None)).await;
            tokio::select! {
                _ = stop.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_millis(250)) => {}
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        let code = *exit.lock().unwrap();
        let _ = tokio::task::spawn_blocking(move || capture.capture(agent, true, code)).await;
    }
}

fn child_dirs(dir: &Path) -> impl Iterator<Item = PathBuf> {
    fs::symlink_metadata(dir)
        .ok()
        .filter(|meta| meta.is_dir())
        .and_then(|_| fs::read_dir(dir).ok())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
}

fn codex_sources(home: &Path, cwd: &Path) -> Vec<(String, PathBuf, SystemTime)> {
    let Ok(cwd) = fs::canonicalize(cwd) else { return Vec::new() };
    if !fs::symlink_metadata(home).is_ok_and(|meta| meta.is_dir()) {
        return Vec::new();
    }
    let mut pending = vec![(home.join("sessions"), 0)];
    let mut rollouts = Vec::new();
    while let Some((dir, depth)) = pending.pop() {
        if !fs::symlink_metadata(&dir).is_ok_and(|meta| meta.is_dir()) {
            continue;
        }
        let Ok(entries) = fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() && depth < 6 {
                pending.push((path, depth + 1));
            } else if kind.is_file()
                && let Some((id, at)) = codex_identity(&path, home, &cwd)
            {
                rollouts.push((id, path, at));
            }
        }
    }
    rollouts.sort_by(|a, b| a.2.cmp(&b.2).then_with(|| a.1.cmp(&b.1)));
    // A thread has one canonical rollout. Retain the latest if the runtime copied it.
    let mut seen = std::collections::HashSet::new();
    rollouts.reverse();
    rollouts.retain(|(id, _, _)| seen.insert(id.clone()));
    rollouts
}

fn codex_identity(path: &Path, home: &Path, cwd: &Path) -> Option<(String, SystemTime)> {
    let name = path.file_name()?.to_str()?.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    let info = fs::symlink_metadata(path).ok()?;
    if !info.is_file() || !capture::owned_by_same_principal(path, home).ok()? {
        return None;
    }
    let source = File::open(path).ok()?.take(256 * 1024);
    let mut header = Vec::new();
    BufReader::new(source).read_until(b'\n', &mut header).ok()?;
    if !header.ends_with(b"\n") {
        return None;
    }
    let meta: Value = serde_json::from_slice(&header).ok()?;
    if meta["type"] != "session_meta" {
        return None;
    }
    let payload = &meta["payload"];
    if payload["source"].get("subagent").is_some() {
        return None;
    }
    let id = Uuid::parse_str(payload["id"].as_str()?).ok()?.to_string();
    if !name.strip_suffix(&id).is_some_and(|prefix| prefix.ends_with('-'))
        || fs::canonicalize(payload["cwd"].as_str()?).ok()? != cwd
    {
        return None;
    }
    Some((id, info.modified().ok()?))
}

fn kimi_sources(home: &Path, cwd: &Path) -> Vec<(String, PathBuf, SystemTime)> {
    let Ok(cwd) = fs::canonicalize(cwd) else { return Vec::new() };
    if !fs::symlink_metadata(home).is_ok_and(|meta| meta.is_dir()) {
        return Vec::new();
    }
    child_dirs(&home.join("sessions"))
        .flat_map(|workspace| {
            child_dirs(&workspace)
                .filter_map(|path| {
                    let name = path.file_name()?.to_str()?;
                    let id = name.strip_prefix("session_")?;
                    let native = format!("session_{}", Uuid::parse_str(id).ok()?);
                    if native != name {
                        return None;
                    }
                    let marker = path.join("state.json");
                    if !fs::symlink_metadata(&marker).is_ok_and(|meta| meta.is_file() && meta.len() <= 64 * 1024)
                        || !capture::owned_by_same_principal(&marker, home).ok()?
                    {
                        return None;
                    }
                    let source = File::open(&marker).ok()?.take(64 * 1024 + 1);
                    let state: Value = serde_json::from_reader(source).ok()?;
                    let stored_id = state["id"].as_str()?;
                    let stored_cwd = fs::canonicalize(state["cwd"].as_str()?).ok()?;
                    if (stored_id != native && stored_id != id) || stored_cwd != cwd {
                        return None;
                    }
                    let mut modified = fs::symlink_metadata(&marker).ok()?.modified().ok()?;
                    for agent in child_dirs(&path.join("agents")) {
                        if let Ok(info) = fs::symlink_metadata(agent.join("wire.jsonl"))
                            && info.is_file()
                            && let Ok(at) = info.modified()
                        {
                            modified = modified.max(at);
                        }
                    }
                    Some((native, path, modified))
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_ids_keep_device_and_agent_scopes_separate() {
        let first = session_id("device-a", "kimi-code", "session-x");
        assert_eq!(first, session_id("device-a", "kimi-code", "session-x"));
        assert_ne!(first, session_id("device-b", "kimi-code", "session-x"));
        assert_ne!(first, session_id("device-a", "codex", "session-x"));
        assert_eq!(Uuid::parse_str(&first).unwrap().get_version_num(), 5);
    }

    #[test]
    fn codex_discovery_binds_multiple_verified_threads_and_rejects_mismatches() {
        let profile = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let sessions = profile.path().join("sessions/2026/11/20");
        fs::create_dir_all(&sessions).unwrap();
        let first = "00000000-0000-4000-8000-000000000041";
        let second = "00000000-0000-4000-8000-000000000042";
        let write = |name: &str, id: &str, cwd: &Path| {
            let header = serde_json::json!({"type":"session_meta","payload":{"id":id,"cwd":cwd}});
            fs::write(sessions.join(format!("rollout-time-{name}.jsonl")), format!("{header}\n")).unwrap();
        };
        write(first, second, cwd.path());
        write(second, second, profile.path());
        assert!(codex_sources(profile.path(), cwd.path()).is_empty());
        write(first, first, cwd.path());
        write(second, second, cwd.path());
        let mut ids: Vec<String> = codex_sources(profile.path(), cwd.path()).into_iter().map(|(id, _, _)| id).collect();
        ids.sort();
        assert_eq!(ids, [first, second]);
    }

    #[test]
    fn kimi_discovery_requires_matching_native_id_and_working_directory() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let name = "session_00000000-0000-4000-8000-000000000042";
        let path = dir.path().join("sessions/project").join(name);
        fs::create_dir_all(&path).unwrap();
        let write = |id: &str, cwd: &Path| {
            fs::write(path.join("state.json"), serde_json::json!({"id": id, "cwd": cwd}).to_string()).unwrap();
        };
        write("session_wrong", cwd.path());
        assert!(kimi_sources(dir.path(), cwd.path()).is_empty());
        write(name, dir.path());
        assert!(kimi_sources(dir.path(), cwd.path()).is_empty());
        write(name, cwd.path());
        let sources = kimi_sources(dir.path(), cwd.path());
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].0, name);
    }
}
