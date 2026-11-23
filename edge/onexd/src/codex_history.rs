//! Restore the native transcripts into each private Codex launch profile.

use std::collections::HashMap;
use std::fs::{self, File, FileTimes};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tracing::warn;

use crate::{capture, launch, native_capture};

use super::PROVIDER;

static ACTIVE: Mutex<Vec<(PathBuf, PathBuf)>> = Mutex::new(Vec::new());

/// Owned through the final transcript pass, which can outlive the run directory.
pub(crate) struct HistoryLease {
    profile: PathBuf,
    restored: HashMap<String, RestoredHistory>,
}

#[derive(Clone)]
pub(crate) struct RestoredHistory {
    pub(crate) identity: u64,
    pub(crate) floor: u64,
    pub(crate) digest: [u8; 32],
    relative: PathBuf,
    source: PathBuf,
    source_identity: u64,
    source_len: u64,
    source_complete: u64,
    original_header_len: u64,
    restored_header_len: u64,
    modified: SystemTime,
}

impl RestoredHistory {
    pub(crate) fn capture_offset(&self, saved: &Value) -> u64 {
        if saved["ino"].as_u64() != Some(self.source_identity) {
            return self.floor;
        }
        match saved["offset"].as_u64() {
            Some(0) => 0,
            Some(offset) if (self.original_header_len..=self.source_complete).contains(&offset) => {
                offset - self.original_header_len + self.restored_header_len
            }
            _ => self.floor,
        }
    }
}

#[derive(Deserialize, Serialize)]
struct SessionName {
    id: String,
    thread_name: String,
    updated_at: String,
}

impl HistoryLease {
    pub(crate) fn restored_history(&self, native: &str) -> Option<RestoredHistory> {
        self.restored.get(native).cloned()
    }
}

impl Drop for HistoryLease {
    fn drop(&mut self) {
        // The old copy still exists. Discard only the copies this daemon made
        // that the new launch never changed, so ordinary launches don't duplicate
        // the entire conversation corpus on disk.
        let config = self.profile.join("codex");
        for copy in self.restored.values() {
            let path = config.join(&copy.relative);
            if same_file(&copy.source, copy.source_identity, copy.source_len, copy.modified)
                && same_file(&path, copy.identity, copy.floor, copy.modified)
            {
                let _ = fs::remove_file(path);
            }
        }
        ACTIVE.lock().unwrap().retain(|(profile, _)| profile != &self.profile);
    }
}

pub(crate) fn restore_history(launch: &launch::Launch, home: &Path) -> Result<HistoryLease> {
    let workspace = launch.cwd.canonicalize()?;
    let profile = launch.config_dir.parent().context("Codex profile path")?.to_path_buf();
    let profiles = profile.parent().context("Codex profiles path")?;
    ensure!(
        launch.config_dir.starts_with(home)
            && native_capture::plain_directory(home)
            && launch.config_dir.ancestors().take_while(|path| *path != home).all(|path| private_directory(path, home)),
        "invalid managed Codex profile directory"
    );
    let workspace_busy = {
        let mut active = ACTIVE.lock().unwrap();
        let busy = active.iter().any(|(p, cwd)| p.parent() == Some(profiles) && cwd == &workspace);
        active.push((profile.clone(), workspace.clone()));
        busy
    };
    let mut lease = HistoryLease { profile: profile.clone(), restored: HashMap::new() };
    if workspace_busy {
        return Ok(lease);
    }

    // Scan only this enrollment's own managed profiles. The enrollments for
    // other OneX principals have separate device homes.
    let mut candidates = Vec::new();
    let mut configs = Vec::new();
    for entry in fs::read_dir(profiles)?.flatten() {
        let name = entry.file_name();
        let Some(id) = name.to_str().filter(|name| launch::is_generated_launch_id(name)) else { continue };
        let source_profile = entry.path();
        if source_profile == profile
            || fs::symlink_metadata(home.join("run").join(id)).is_ok()
            || ACTIVE.lock().unwrap().iter().any(|(active, _)| active == &source_profile)
            || !private_directory(&source_profile, home)
        {
            continue;
        }
        let config = source_profile.join("codex");
        if private_directory(&config, home) {
            for (native, path, modified) in native_capture::codex_history_sources(&config, &workspace) {
                candidates.push((modified, id.to_owned(), native, path, config.clone()));
            }
            configs.push((id.to_owned(), config));
        }
    }
    // The newest retained version of a native thread wins. Prefer the newer
    // launch when an archive/unarchive move leaves the original mtime unchanged.
    candidates.sort_unstable_by(|a, b| (&b.0, &b.1).cmp(&(&a.0, &a.1)));
    for (_, _, native, path, config) in candidates {
        if lease.restored.contains_key(&native) {
            continue;
        }
        match snapshot(&path, &config, &launch.config_dir, &native, &workspace) {
            Ok(copy) => {
                lease.restored.insert(native, copy);
            }
            Err(error) => warn!(%error, "could not restore a Codex rollout; source retained"),
        }
    }
    if !lease.restored.is_empty() {
        write_names(configs, &launch.config_dir, &lease.restored)?;
    }
    Ok(lease)
}

fn private_directory(dir: &Path, owner: &Path) -> bool {
    native_capture::plain_directory(dir) && capture::owned_by_same_principal(dir, owner).unwrap_or(false)
}

fn snapshot(path: &Path, config: &Path, destination: &Path, native: &str, workspace: &Path) -> Result<RestoredHistory> {
    let relative = path.strip_prefix(config)?.to_path_buf();
    let target = destination.join(&relative);
    let parent = target.parent().context("Codex rollout directory")?;
    let mut source = native_capture::open_private_regular(path, config).context("invalid Codex rollout")?;
    let before = source.metadata()?;
    let identity = capture::file_identity(path, &before)?;
    let modified = before.modified()?;
    let complete = complete_prefix(&mut source, before.len())?;
    source.rewind()?;
    let mut source = BufReader::new(source.take(complete));
    let mut header = Vec::new();
    source.by_ref().take(256 * 1024).read_until(b'\n', &mut header)?;
    ensure!(
        header.ends_with(b"\n")
            && native_capture::codex_header_identity(&header, workspace, None).as_deref() == Some(native),
        "Codex rollout identity changed"
    );
    let original_header_len = header.len() as u64;
    normalize_provider(&mut header)?;

    launch::private_dir(parent)?;
    let mut copy = tempfile::NamedTempFile::new_in(parent)?;
    copy.write_all(&header)?;
    // Reject a short read even if the source changes back before the path check.
    let remaining = source.buffer().len() as u64 + source.get_ref().limit();
    ensure!(io::copy(&mut source, &mut copy)? == remaining, "Codex rollout ended during restore");
    copy.as_file().set_times(FileTimes::new().set_modified(modified))?;
    copy.as_file().sync_all()?;
    ensure!(same_file(path, identity, before.len(), modified), "Codex rollout changed while restoring it");
    let size = copy.as_file().metadata()?.len();
    let digest = prefix_digest(copy.as_file_mut(), size)?;
    let persisted = copy.persist_noclobber(&target)?;
    let meta = persisted.metadata()?;
    Ok(RestoredHistory {
        identity: capture::file_identity(&target, &meta)?,
        floor: size,
        digest,
        relative,
        source: path.to_path_buf(),
        source_identity: identity,
        source_len: before.len(),
        source_complete: complete,
        original_header_len,
        restored_header_len: header.len() as u64,
        modified,
    })
}

pub(crate) fn prefix_digest(file: &mut File, len: u64) -> Result<[u8; 32]> {
    let mut digest = Sha256::new();
    file.rewind()?;
    let mut input = file.take(len);
    let mut buffer = [0; 8192];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    ensure!(input.limit() == 0, "incomplete Codex rollout prefix");
    Ok(digest.finalize().into())
}

fn same_file(path: &Path, identity: u64, expected_size: u64, modified: SystemTime) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| {
        meta.is_file()
            && meta.len() == expected_size
            && meta.modified().ok() == Some(modified)
            && capture::file_identity(path, &meta).ok() == Some(identity)
    })
}

fn complete_prefix(file: &mut File, mut end: u64) -> Result<u64> {
    let mut chunk = [0; 8192];
    while end > 0 {
        let len = end.min(chunk.len() as u64) as usize;
        file.seek(SeekFrom::Start(end - len as u64))?;
        file.read_exact(&mut chunk[..len])?;
        if let Some(last_newline) = chunk[..len].iter().rposition(|byte| *byte == b'\n') {
            return Ok(end - len as u64 + last_newline as u64 + 1);
        }
        end -= len as u64;
    }
    Ok(0)
}

fn normalize_provider(header: &mut Vec<u8>) -> Result<()> {
    let mut record: Value = serde_json::from_slice(header)?;
    if let Some(previous) = record["payload"]["model_provider"].as_str()
        && launch::is_generated_launch_id(&previous.replacen("onex_", "lch_", 1))
        && previous.starts_with("onex_")
        && previous != PROVIDER
    {
        // This is an older managed provider identifier, which the native picker
        // would otherwise hide. Only the copied header is rewritten.
        record["payload"]["model_provider"] = PROVIDER.into();
        *header = serde_json::to_vec(&record)?;
        header.push(b'\n');
    }
    Ok(())
}

fn write_names(
    mut configs: Vec<(String, PathBuf)>,
    destination: &Path,
    restored: &HashMap<String, RestoredHistory>,
) -> Result<()> {
    configs.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    let mut names = HashMap::<String, (Option<i64>, SessionName)>::new();
    for (_, config) in configs {
        let Some(file) = native_capture::open_private_regular(&config.join("session_index.jsonl"), &config) else {
            continue;
        };
        // A name entry is tiny. Limit the index read separately from rollouts.
        let mut reader = BufReader::new(file.take(16 * 1024 * 1024));
        let mut line = Vec::new();
        while reader.read_until(b'\n', &mut line).unwrap_or(0) > 0 {
            if line.ends_with(b"\n")
                && let Ok(name) = serde_json::from_slice::<SessionName>(&line)
                && restored.contains_key(&name.id)
            {
                let at = crate::pricing::parse_ms(&name.updated_at);
                if names.get(&name.id).is_none_or(|(previous, _)| at >= *previous) {
                    names.insert(name.id.clone(), (at, name));
                }
            }
            line.clear();
        }
    }
    if !names.is_empty() {
        let mut index = Vec::new();
        for (_, name) in names.into_values() {
            serde_json::to_writer(&mut index, &name)?;
            index.push(b'\n');
        }
        launch::write_private(&destination.join("session_index.jsonl"), &index)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_capture::Capture;
    use crate::outbox::Outbox;
    use serde_json::json;
    use std::sync::Arc;

    const THREAD: &str = "00000000-0000-4000-8000-000000000042";
    const OLDER: &str = "00000000-0000-4000-8000-000000000043";
    const OTHER: &str = "00000000-0000-4000-8000-000000000044";

    fn prepare(home: &Path, cwd: &Path) -> launch::Launch {
        super::super::prepare(&launch::Request {
            agent: "codex",
            home,
            router_addr: "127.0.0.1:1",
            local_token: "token",
            model: "one-model",
            program: Path::new("/unused/codex"),
            cwd,
            client_env: &Default::default(),
        })
        .unwrap()
    }

    fn relative(native: &str, archived: bool) -> PathBuf {
        Path::new(if archived { "archived_sessions" } else { "sessions/2026/11/22" })
            .join(format!("rollout-2026-11-22T10-00-00-{native}.jsonl"))
    }

    fn write_source(launch: &launch::Launch, native: &str, cwd: &Path, archived: bool) -> PathBuf {
        let path = launch.config_dir.join(relative(native, archived));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut source = File::create(&path).unwrap();
        let header = json!({"type":"session_meta", "payload": {
            "id":native, "cwd":cwd, "model_provider":launch.launch_id.replacen("lch_", "onex_", 1)
        }});
        writeln!(source, "{header}").unwrap();
        append_message(&path, "previous conversation");
        path
    }

    fn append_message(path: &Path, msg: &str) {
        let mut file = fs::OpenOptions::new().append(true).open(path).unwrap();
        let response = json!({"type":"response_item", "payload": {
            "type":"message", "role":"user", "content":[{"type":"input_text", "text":msg}]
        }});
        writeln!(file, "{response}").unwrap();
    }

    #[test]
    fn restores_only_closed_same_account_workspace_with_separate_runtime_state() {
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let foreign = tempfile::tempdir().unwrap();
        let old = prepare(home.path(), cwd.path());
        let original = write_source(&old, THREAD, cwd.path(), false);
        write_source(&old, OLDER, cwd.path(), true);
        write_source(&old, OTHER, foreign.path(), false);
        let mut old_file = fs::OpenOptions::new().append(true).open(&original).unwrap();
        write!(old_file, "incomplete tail").unwrap();
        drop(old_file);
        for data in ["auth.json", "queue_1.sqlite", "state_5.sqlite", "goals_1.sqlite"] {
            fs::write(old.config_dir.join(data), "previous launch only").unwrap();
        }
        let index = [
            json!({"id":THREAD, "thread_name":"my conversation", "updated_at":"2026-11-22T10:00:00Z"}),
            json!({"id":OTHER, "thread_name":"other workspace", "updated_at":"2026-11-22T10:00:00Z"}),
        ];
        fs::write(old.config_dir.join("session_index.jsonl"), format!("{}\n{}\n", index[0], index[1])).unwrap();
        // First launch had not reported completion yet.
        let overlap = prepare(home.path(), cwd.path());
        let overlap_lease = restore_history(&overlap, home.path()).unwrap();
        assert!(overlap_lease.restored.is_empty());
        drop(overlap_lease);
        launch::finish(home.path(), &overlap.launch_id).unwrap();
        launch::finish(home.path(), &old.launch_id).unwrap();

        let new = prepare(home.path(), cwd.path());
        let lease = restore_history(&new, home.path()).unwrap();
        assert_eq!(lease.restored.len(), 2);
        let copied = new.config_dir.join(relative(THREAD, false));
        assert!(new.config_dir.join(relative(OLDER, true)).is_file());
        assert!(!new.config_dir.join(relative(OTHER, false)).exists());
        let contents = fs::read_to_string(&copied).unwrap();
        assert!(contents.ends_with('\n'));
        assert!(!contents.contains("incomplete tail"));
        assert!(fs::read_to_string(&original).unwrap().ends_with("incomplete tail"));
        let header: Value = serde_json::from_str(contents.lines().next().unwrap()).unwrap();
        assert_eq!(header["payload"]["model_provider"], PROVIDER);
        let copy_index = fs::read_to_string(new.config_dir.join("session_index.jsonl")).unwrap();
        let name: Value = serde_json::from_str(copy_index.trim_end()).unwrap();
        assert_eq!(name["thread_name"], "my conversation");
        for data in ["auth.json", "queue_1.sqlite", "state_5.sqlite", "goals_1.sqlite"] {
            assert!(!new.config_dir.join(data).exists());
        }
        // End reports before the final native pass when the window closes.
        launch::finish(home.path(), &new.launch_id).unwrap();
        let concurrent = prepare(home.path(), cwd.path());
        let concurrent_lease = restore_history(&concurrent, home.path()).unwrap();
        assert!(concurrent_lease.restored.is_empty());
        let other_account = prepare(foreign.path(), cwd.path());
        assert!(restore_history(&other_account, foreign.path()).unwrap().restored.is_empty());
        drop(lease);
        assert!(!copied.exists());
        assert!(original.is_file());
    }

    #[test]
    fn imported_prefix_cannot_replay_and_only_appended_data_reopens_the_session() {
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let old = prepare(home.path(), cwd.path());
        let original = write_source(&old, THREAD, cwd.path(), false);
        let outbox = Arc::new(Outbox::open(&home.path().join("outbox.sqlite")).unwrap());
        let session = |config: &Path| capture::Session {
            session_id: native_capture::session_id("assigned-device", "codex", THREAD),
            config_dir: config.to_path_buf(),
            agent_version: None,
            model: "one-model".into(),
            cwd: cwd.path().into(),
        };
        Capture::new(session(&old.config_dir), original.clone(), outbox.clone()).end(Some(0)).unwrap();
        append_message(&original, "unreported turn before the Edge stopped");
        launch::finish(home.path(), &old.launch_id).unwrap();
        let new = prepare(home.path(), cwd.path());
        let lease = restore_history(&new, home.path()).unwrap();
        let path = new.config_dir.join(relative(THREAD, false));
        let capture = Capture::new(session(&new.config_dir), path.clone(), outbox.clone())
            .with_restored_history(lease.restored_history(THREAD));
        assert!(!capture.has_native_activity().unwrap());
        capture.end(Some(0)).unwrap();
        assert_eq!(outbox.pending(0, 100).unwrap().len(), 3);
        append_message(&path, "after upgrading");
        assert!(capture.has_native_activity().unwrap());
        capture.pass().unwrap();
        capture.end(Some(0)).unwrap();
        let rows = outbox.pending(0, 100).unwrap();
        let kinds: Vec<&str> = rows.iter().map(|row| row.item["kind"].as_str().unwrap()).collect();
        assert_eq!(
            kinds,
            [
                "session_start",
                "user_message",
                "session_end",
                "session_resume",
                "user_message",
                "user_message",
                "session_end"
            ]
        );
        assert_eq!(rows[4].item["payload"]["content"], "unreported turn before the Edge stopped");
        assert_eq!(rows[5].item["payload"]["content"], "after upgrading");
        let unknown_outbox = Arc::new(Outbox::open(&home.path().join("recreated.sqlite")).unwrap());
        Capture::new(session(&new.config_dir), path.clone(), unknown_outbox.clone())
            .with_restored_history(lease.restored_history(THREAD))
            .end(Some(0))
            .unwrap();
        let rows = unknown_outbox.pending(0, 100).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[1].item["payload"]["content"], "after upgrading");
        assert!(!fs::read_to_string(&original).unwrap().contains("after upgrading"));
        launch::finish(home.path(), &new.launch_id).unwrap();
        drop(lease);
        assert!(path.is_file());
        let next = prepare(home.path(), cwd.path());
        let next_lease = restore_history(&next, home.path()).unwrap();
        assert!(next_lease.restored_history(THREAD).is_some());
        assert!(fs::read_to_string(next.config_dir.join(relative(THREAD, false))).unwrap().contains("after upgrading"));
    }
}
