//! Native WorkBuddy JSONL. Read only the sources named by this private profile's trusted Hook.
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::{capture, native_capture, outbox::Outbox, pricing};

const MAX_LINE: usize = 2 * 1024 * 1024;
const MAX_TEXT: usize = 48 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Source {
    pub(crate) project: String,
    pub(crate) cwd: PathBuf,
}

#[derive(Default, Deserialize, Serialize)]
struct Cursor {
    offset: u64,
    identity: String,
    skipping: bool,
    started: bool,
    anchor: String,
}

pub(crate) struct Capture {
    config: PathBuf,
    workspace: PathBuf,
    private_home: PathBuf,
    device: String,
    version: String,
    model: String,
    store: Arc<Outbox>,
    index: String,
    sources: Mutex<BTreeMap<String, Source>>,
}

impl Capture {
    pub(crate) fn new(
        config: &Path,
        workspace: &Path,
        device: &str,
        version: &str,
        model: &str,
        store: Arc<Outbox>,
    ) -> Result<Self> {
        ensure!(config.symlink_metadata()?.is_dir(), "invalid WorkBuddy private config directory");
        let config = config.canonicalize()?;
        let private_home = config.parent().context("missing private profile")?.join("home/WorkBuddy");
        let workspace = workspace.canonicalize()?;
        let index = format!(
            "workbuddy-sources:{}",
            native_capture::session_id(device, "workbuddy", config.to_str().context("invalid profile path")?)
        );
        let sources = store.cursor(&index)?.map(serde_json::from_value).transpose()?.unwrap_or_default();
        Ok(Self {
            config,
            workspace,
            private_home,
            device: device.into(),
            version: version.into(),
            model: model.into(),
            store,
            index,
            sources: Mutex::new(sources),
        })
    }

    fn accepts(&self, id: &str, source: &Source) -> bool {
        let mut project = Path::new(&source.project).components();
        !id.is_empty()
            && id.len() <= 128
            && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
            && source.project.len() <= 255
            && matches!(project.next(),Some(Component::Normal(name)) if name == source.project.as_str())
            && project.next().is_none()
            && !source.project.contains('\\')
            && (source.cwd == self.workspace || source.cwd.starts_with(&self.private_home))
            && source.cwd.canonicalize().is_ok_and(|cwd| cwd == source.cwd && cwd.is_dir())
            && self.safe_transcript_path(id, source)
    }

    fn safe_transcript_path(&self, id: &str, source: &Source) -> bool {
        let projects = self.config.join("projects");
        let project = projects.join(&source.project);
        let file = project.join(format!("{id}.jsonl"));
        [(projects, false), (project, false), (file, true)].iter().all(|(path, is_file)| {
            match path.symlink_metadata() {
                Ok(meta) => {
                    (if *is_file { meta.is_file() } else { meta.is_dir() })
                        && path.canonicalize().is_ok_and(|resolved| resolved == *path)
                        && capture::owned_by_same_principal(path, &self.config).unwrap_or(false)
                }
                Err(error) => error.kind() == std::io::ErrorKind::NotFound,
            }
        })
    }

    pub(crate) fn register(&self, id: &str, source: Source) -> Result<()> {
        ensure!(self.accepts(id, &source), "WorkBuddy source outside the private launch");
        let mut sources = self.sources.lock().unwrap();
        if let Some(known) = sources.get(id) {
            ensure!(known == &source, "WorkBuddy changed an existing native source");
            return Ok(());
        }
        loop {
            let previous = self.store.cursor(&self.index)?;
            let mut next: BTreeMap<String, Source> =
                previous.clone().map(serde_json::from_value).transpose()?.unwrap_or_default();
            if let Some(known) = next.get(id) {
                ensure!(known == &source, "WorkBuddy changed an existing native source");
                *sources = next;
                return Ok(());
            }
            ensure!(next.len() < 4096, "WorkBuddy source index is full");
            next.insert(id.to_owned(), source.clone());
            if self.store.append_if_cursor(
                Vec::new(),
                &self.index,
                &serde_json::to_value(&next)?,
                Some(previous.as_ref().unwrap_or(&Value::Null)),
            )? {
                *sources = next;
                return Ok(());
            }
        }
    }

    fn read_source(&self, id: &str, source: &Source, drain: bool) -> Result<()> {
        ensure!(self.accepts(id, source), "invalid WorkBuddy source");
        let file_path = self.config.join("projects").join(&source.project).join(format!("{id}.jsonl"));
        match file_path.canonicalize() {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            other => ensure!(other? == file_path, "WorkBuddy transcript follows a link"),
        }
        let mut file = native_capture::open_private_regular(&file_path, &self.config)
            .context("invalid WorkBuddy transcript file")?;
        ensure!(file_path.canonicalize()? == file_path, "WorkBuddy source moved while opening");
        let meta = file.metadata()?;
        let identity = file_identity(&meta);
        let session = native_capture::session_id(&self.device, "workbuddy", id);
        let key = format!("workbuddy-transcript:{session}");
        let mut previous = self.store.cursor(&key)?;
        let mut cursor: Cursor = previous.clone().map(serde_json::from_value).transpose()?.unwrap_or_default();
        if cursor.offset > 0 {
            ensure!(
                cursor.identity == identity
                    && meta.len() >= cursor.offset
                    && anchor(&mut file, cursor.offset)? == cursor.anchor,
                "WorkBuddy transcript replaced or truncated"
            );
        }
        cursor.identity = identity;
        let cwd_hash = capture::hex(&Sha256::digest(source.cwd.to_str().context("invalid workspace")?.as_bytes()));
        while cursor.offset < meta.len() {
            let before = cursor.offset;
            file.seek(SeekFrom::Start(before))?;
            let mut bytes = Vec::new();
            (&mut file).take((meta.len() - before).min(MAX_LINE as u64 + 1)).read_to_end(&mut bytes)?;
            let mut events = Vec::new();
            for line in bytes.split_inclusive(|b| *b == b'\n') {
                if line.last() != Some(&b'\n') {
                    if cursor.skipping || line.len() > MAX_LINE {
                        cursor.skipping = true;
                        cursor.offset += line.len() as u64;
                    }
                    break;
                }
                cursor.offset += line.len() as u64;
                if std::mem::take(&mut cursor.skipping) || line.len() > MAX_LINE {
                    continue;
                }
                let Some((kind, payload, time)) = visible(line, id, &source.cwd) else { continue };
                if !cursor.started {
                    events.push(json!({"session_id":session,"source_offset":null,"at":time,"kind":"session_start",
                        "payload":{"agent":"workbuddy","agent_version":self.version,"model":self.model,"cwd_hash":cwd_hash,"sidechain":false}}));
                    cursor.started = true;
                }
                let mut payload = payload;
                payload["uuid"] = format!("{session}:{}", cursor.offset).into();
                events.push(
                    json!({"session_id":session,"source_offset":cursor.offset,"at":time,"kind":kind,"payload":payload}),
                );
                if events.len() >= 32 {
                    break;
                }
            }
            if before == cursor.offset {
                break;
            }
            cursor.anchor = anchor(&mut file, cursor.offset)?;
            let next = serde_json::to_value(&cursor)?;
            if !self.store.append_if_cursor(events, &key, &next, Some(previous.as_ref().unwrap_or(&Value::Null)))? {
                break;
            }
            previous = Some(next);
            if !drain {
                break;
            }
        }
        Ok(())
    }

    pub(crate) async fn run(self: Arc<Self>, stop: CancellationToken) {
        loop {
            let ending = stop.is_cancelled();
            let capture = self.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let sources = capture.sources.lock().unwrap().clone();
                for (id, source) in sources {
                    if let Err(err) = capture.read_source(&id, &source, ending) {
                        tracing::debug!(%err,"WorkBuddy transcript capture deferred");
                    }
                }
            })
            .await;
            if ending {
                return;
            }
            tokio::select! { _=stop.cancelled()=>{}, _=tokio::time::sleep(Duration::from_millis(500))=>{} }
        }
    }
}

#[cfg(unix)]
fn file_identity(meta: &fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!("{}:{}", meta.dev(), meta.ino())
}
// WorkBuddy native qualification currently requires macOS. The regular-file check fails closed on other targets.
#[cfg(not(unix))]
fn file_identity(_: &fs::Metadata) -> String {
    String::new()
}

fn anchor(file: &mut fs::File, end: u64) -> Result<String> {
    let size = end.min(256);
    file.seek(SeekFrom::Start(end - size))?;
    let mut bytes = vec![0; size as usize];
    file.read_exact(&mut bytes)?;
    Ok(capture::hex(&Sha256::digest(bytes)))
}

fn visible(line: &[u8], id: &str, cwd: &Path) -> Option<(&'static str, Value, String)> {
    let row = serde_json::from_slice::<Value>(line).ok()?;
    if row["type"] != "message"
        || row["sessionId"] != id
        || row["cwd"].as_str().map(Path::new) != Some(cwd)
        || !(row["isSidechain"].is_null() || row["isSidechain"] == false)
        || !(row["isMeta"].is_null() || row["isMeta"] == false)
    {
        return None;
    }
    let (block, kind) = match row["role"].as_str()? {
        "user" => ("input_text", "user_message"),
        "assistant"
            if (row["providerData"]["error"].is_null() || row["providerData"]["error"] == false)
                && row["status"] != "incomplete" =>
        {
            ("output_text", "assistant_message")
        }
        _ => return None,
    };
    let mut text = row["content"]
        .as_array()?
        .iter()
        .filter(|b| b["type"] == block)
        .filter_map(|b| b["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if text.is_empty() {
        return None;
    }
    let truncated = text.len() > MAX_TEXT;
    if truncated {
        let mut cut = MAX_TEXT - 3;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push('…');
    }
    let at = row["timestamp"].as_str().and_then(pricing::parse_ms).unwrap_or_else(crate::outbox::now_ms);
    Some((kind, json!({"content":text,"sidechain":false,"truncated":truncated}), pricing::format_ms(at)))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::symlink;

    #[test]
    fn workbuddy_history_recovers_partial_lines_and_deduplicates_concurrent_readers() -> Result<()> {
        let root = tempfile::tempdir()?;
        let config = root.path().join("config");
        let project = config.join("projects/managed");
        let cwd = root.path().join("work");
        fs::create_dir_all(&project)?;
        fs::create_dir(&cwd)?;
        let cwd = cwd.canonicalize()?;
        let db = Arc::new(Outbox::open(&root.path().join("db"))?);
        let new = || Capture::new(&config, &cwd, "device", "release", "model", db.clone());
        let source = Source { project: "managed".into(), cwd: cwd.clone() };
        let capture = new()?;
        capture.register("task", source.clone())?;
        let message = |role: &str, kind: &str, text: &str| {
            json!({"type":"message","sessionId":"task","cwd":cwd,"role":role,
            "timestamp":"2025-01-01T12:00:00Z","content":[{"type":"thinking","text":"hidden"},{"type":kind,"text":text}]})
        };
        let user = message("user", "input_text", "first");
        let assistant = message("assistant", "output_text", "reply");
        let path = project.join("task.jsonl");
        let mut file = fs::File::create(&path)?;
        for (key, value) in [
            ("sessionId", json!("foreign")),
            ("cwd", json!("/foreign")),
            ("isMeta", json!(true)),
            ("isSidechain", json!(true)),
        ] {
            let mut hidden = user.clone();
            hidden[key] = value;
            writeln!(file, "{hidden}")?;
        }
        let mut incomplete = assistant.clone();
        incomplete["status"] = "incomplete".into();
        writeln!(file, "{incomplete}")?;
        writeln!(file, "{user}")?;
        let reply = assistant.to_string();
        file.write_all(&reply.as_bytes()[..9])?;
        let concurrent = new()?;
        std::thread::scope(|scope| -> Result<()> {
            let first = scope.spawn(|| capture.read_source("task", &source, true));
            concurrent.read_source("task", &source, true)?;
            first.join().unwrap()
        })?;
        assert_eq!(db.pending(0, 20)?.len(), 2);
        let reopened = new()?;
        assert_eq!(reopened.sources.lock().unwrap().get("task"), Some(&source));
        file.write_all(&reply.as_bytes()[9..])?;
        file.write_all(b"\n")?;
        reopened.read_source("task", &source, true)?;
        reopened.read_source("task", &source, true)?;
        let rows = db.pending(0, 20)?;
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[1].item["payload"]["content"], "first");
        assert_eq!(rows[2].item["payload"]["content"], "reply");
        assert_eq!(rows[2].item["at"], pricing::format_ms(pricing::parse_ms("2025-01-01T12:00:00Z").unwrap()));
        assert_eq!(rows[2].item["source_offset"], file.metadata()?.len());
        file.set_len(1)?;
        assert!(reopened.read_source("task", &source, true).is_err());
        let foreign = root.path().join("outside");
        fs::write(&foreign, format!("{user}\n"))?;
        symlink(foreign, project.join("linked.jsonl"))?;
        assert!(capture.register("linked", source.clone()).is_err());
        symlink(&project, project.parent().unwrap().join("linked-project"))?;
        assert!(capture.register("different", Source { project: "linked-project".into(), cwd: cwd.clone() }).is_err());
        assert!(capture.register("different", Source { project: "../other".into(), cwd }).is_err());
        assert_eq!(db.pending(0, 20)?.len(), 3);
        Ok(())
    }
}
