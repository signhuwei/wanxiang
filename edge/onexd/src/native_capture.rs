//! Bind native sessions discovered inside one managed launch to durable OneX IDs.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde_json::Value;
use sha1::{Digest, Sha1};
use tokio_util::sync::CancellationToken;
use tracing::warn;
use uuid::Uuid;

use crate::{capture, kimi_capture, outbox::Outbox, state::State};

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

pub(crate) struct LaunchCapture {
    session: capture::Session,
    state: Arc<State>,
    outbox: Arc<Outbox>,
    token: String,
    device: String,
}

impl LaunchCapture {
    pub(crate) fn new(session: capture::Session, state: Arc<State>, outbox: Arc<Outbox>, token: String) -> Self {
        let device = state
            .conn
            .lock()
            .unwrap()
            .device_id
            .clone()
            .or_else(|| state.expected_device_id.read().unwrap().clone())
            .unwrap_or_else(|| state.device_key.public_b64());
        Self { session, state, outbox, token, device }
    }

    fn bind_usage(&self, id: String) {
        if let Some(current) = self.state.launch_tokens.write().unwrap().get_mut(&self.token) {
            *current = id;
        }
    }

    fn capture_kimi(&self, ending: bool, code: Option<i32>) {
        let mut last: Option<(SystemTime, String)> = None;
        for (native, path, modified) in kimi_sources(&self.session.config_dir, &self.session.cwd) {
            let id = session_id(&self.device, "kimi-code", &native);
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
            let result = if ending { capture.end(code) } else { capture.pass().map(|_| ()) };
            if let Err(error) = result {
                warn!(%error, session_id = %id, "Kimi native capture failed");
            } else if last.as_ref().is_none_or(|(at, _)| modified >= *at) {
                last = Some((modified, id));
            }
        }
        if let Some((_, id)) = last {
            self.bind_usage(id);
        }
    }

    pub(crate) async fn run_kimi(self, stop: CancellationToken, exit: Arc<Mutex<Option<i32>>>) {
        let capture = Arc::new(self);
        loop {
            let current = capture.clone();
            let _ = tokio::task::spawn_blocking(move || current.capture_kimi(false, None)).await;
            tokio::select! {
                _ = stop.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_millis(250)) => {}
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        let code = *exit.lock().unwrap();
        let _ = tokio::task::spawn_blocking(move || capture.capture_kimi(true, code)).await;
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
