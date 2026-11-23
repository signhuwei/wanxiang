//! Copy same-workspace Kimi conversations into a launch-private native home.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{capture, launch, native_capture};

const MANIFEST: &str = "onex-imported-history.json";
const MAX_STATE_BYTES: u64 = 64 * 1024;
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_WIRE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_RESTORE_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ImportedWire {
    pub(crate) length: u64,
    pub(crate) identity: u64,
    pub(crate) protocol: Option<String>,
    pub(crate) prefix_hash: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct RestoredHistory {
    workspace: String,
    source_launch: String,
    state_hash: String,
    pub(crate) wires: BTreeMap<String, ImportedWire>,
}

pub struct KimiHistory {
    home: PathBuf,
    config: PathBuf,
    cwd: PathBuf,
    device: String,
}

impl KimiHistory {
    pub(crate) fn new(home: PathBuf, config: PathBuf, cwd: PathBuf, device: String) -> Self {
        Self { home, config, cwd, device }
    }

    pub(crate) fn bind(&self, native: &str) -> Option<String> {
        if !native_id(native) {
            return None;
        }
        let cwd = self.cwd.canonicalize().ok()?;
        let sessions = self.config.join("sessions");
        if !dir_chain(&sessions, &self.home) {
            return None;
        }
        for workspace in dirs(&sessions, &self.home) {
            let session = workspace.join(native);
            if !private_dir(&session, &self.home) {
                continue;
            }
            let Some(state) = read_json(&session.join("state.json"), &self.home, MAX_STATE_BYTES) else { continue };
            if state["id"].as_str().is_some_and(|id| id == native || native.strip_prefix("session_") == Some(id))
                && state["cwd"].as_str().and_then(|path| Path::new(path).canonicalize().ok()).as_ref() == Some(&cwd)
            {
                return Some(native_capture::session_id(&self.device, "kimi-code", native));
            }
        }
        None
    }
}

pub(crate) type RestoredHistories = BTreeMap<String, RestoredHistory>;

struct Session {
    root: PathBuf,
    config: PathBuf,
    workspace: String,
    launch: String,
    state: Value,
    updated: (u64, SystemTime),
}

fn private_dir(path: &Path, owner: &Path) -> bool {
    native_capture::plain_directory(path) && capture::owned_by_same_principal(path, owner).unwrap_or(false)
}

fn dirs(path: &Path, owner: &Path) -> impl Iterator<Item = PathBuf> {
    private_dir(path, owner).then(|| fs::read_dir(path).ok()).flatten().into_iter().flatten().filter_map(|entry| {
        let path = entry.ok()?.path();
        private_dir(&path, owner).then_some(path)
    })
}

fn plain_name(path: &Path) -> Option<&str> {
    let name = path.file_name()?.to_str()?;
    safe_component(name).then_some(name)
}

fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && !matches!(value, "." | "..")
        && !value.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
}

fn native_id(value: &str) -> bool {
    value
        .strip_prefix("session_")
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id))
}

fn read_json(path: &Path, owner: &Path, max: u64) -> Option<Value> {
    let file = native_capture::open_private_regular(path, owner)?;
    (file.metadata().ok()?.len() <= max).then_some(())?;
    serde_json::from_reader(file.take(max + 1)).ok()
}

// An interrupted daemon can remove config.toml while the independently spawned CLI still
// writes the conversation. The native CLI holds its own lock from before opening the wire.
fn has_native_writer(config: &Path, home: &Path, session: &str) -> bool {
    let lock = config.join("locks").join("sessions").join(format!("{session}.lock"));
    if fs::symlink_metadata(&lock).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
        return false;
    }
    if !lock.parent().is_some_and(|dir| dir_chain(dir, home)) {
        return true;
    }
    let Some(data) = read_json(&lock, home, 4096) else { return true };
    if data["version"] != 1 || data["clientIdentity"] != "kimi_code_cli" {
        return true;
    }
    let Some(pid) = data["pid"].as_u64().and_then(|pid| u32::try_from(pid).ok()).filter(|&pid| pid > 0) else {
        return true;
    };
    !process_already_gone(pid)
}

#[cfg(unix)]
fn process_already_gone(pid: u32) -> bool {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    let Ok(pid) = i32::try_from(pid) else { return false };
    // Safety: a signal of 0 only performs the kernel's existence and permissions check.
    let result = unsafe { kill(pid, 0) };
    result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(3) // ESRCH on supported Unix systems
}

#[cfg(windows)]
fn process_already_gone(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, HANDLE};
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> HANDLE;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    // Safety: no caller-owned memory is passed and any returned handle is closed below.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        std::io::Error::last_os_error().raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32)
    } else {
        unsafe { CloseHandle(handle) };
        false
    }
}

fn sessions(home: &Path, profiles: &Path, cwd: &Path) -> BTreeMap<String, Session> {
    let mut sessions = BTreeMap::<String, Session>::new();
    let mut locked = BTreeSet::new();
    for source in dirs(profiles, home) {
        let Some(launch) = plain_name(&source).filter(|name| launch::is_generated_launch_id(name)) else { continue };
        let config = source.join("kimi");
        if !private_dir(&config, home) {
            continue;
        }
        let open =
            !fs::symlink_metadata(config.join("config.toml")).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound);
        for workspace in dirs(&config.join("sessions"), home) {
            let Some(workspace_name) = plain_name(&workspace).filter(|name| name.starts_with("wd_")) else { continue };
            for root in dirs(&workspace, home) {
                let Some(id) = plain_name(&root).filter(|name| native_id(name)).map(str::to_owned) else { continue };
                if open || has_native_writer(&config, home, &id) {
                    locked.insert(id);
                    continue;
                }
                let state_path = root.join("state.json");
                let Some(state) = read_json(&state_path, home, MAX_STATE_BYTES) else { continue };
                if state["id"] != id
                    || state["version"] != 2
                    || state["cwd"].as_str().and_then(|value| Path::new(value).canonicalize().ok()).as_deref()
                        != Some(cwd)
                {
                    continue;
                }
                let Some(modified) = fs::symlink_metadata(&state_path).ok().and_then(|meta| meta.modified().ok())
                else {
                    continue;
                };
                let updated = (state["updatedAt"].as_u64().unwrap_or(0), modified);
                if sessions.get(&id).is_none_or(|previous| updated > previous.updated) {
                    sessions.insert(
                        id,
                        Session {
                            root,
                            config: config.clone(),
                            workspace: workspace_name.to_owned(),
                            launch: launch.to_owned(),
                            state,
                            updated,
                        },
                    );
                }
            }
        }
    }
    sessions.retain(|id, _| !locked.contains(id));
    sessions
}

fn complete_wire_end(file: &mut fs::File, mut end: u64) -> Result<u64> {
    let mut buffer = [0u8; 16 * 1024];
    while end > 0 {
        let length = end.min(buffer.len() as u64) as usize;
        let start = end - length as u64;
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut buffer[..length])?;
        if let Some(last) = buffer[..length].iter().rposition(|byte| *byte == b'\n') {
            file.seek(SeekFrom::Start(0))?;
            return Ok(start + last as u64 + 1);
        }
        end = start;
    }
    anyhow::bail!("native Kimi transcript contains no complete records");
}

fn copy_wire(source: &Path, destination: &Path, owner: &Path, available: u64) -> Result<ImportedWire> {
    let mut file =
        native_capture::open_private_regular(source, owner).context("invalid native Kimi transcript file")?;
    let before = file.metadata()?;
    ensure!(before.len() <= MAX_WIRE_BYTES, "native Kimi transcript exceeds restore limit");
    let length = complete_wire_end(&mut file, before.len())?;
    ensure!(length <= available, "native Kimi restore exceeds profile budget");
    let mut reader = BufReader::new(file);
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options.open(destination)?;
    let mut first_line = Vec::new();
    Read::take(&mut reader, MAX_STATE_BYTES + 1).read_until(b'\n', &mut first_line)?;
    ensure!(
        first_line.last() == Some(&b'\n') && first_line.len() as u64 <= length,
        "incomplete native Kimi transcript"
    );
    let protocol = serde_json::from_slice::<Value>(&first_line).ok().and_then(|row| {
        (row["type"] == "metadata").then(|| row["protocol_version"].as_str().map(str::to_owned)).flatten()
    });
    output.write_all(&first_line)?;
    let mut hash = Sha256::new();
    hash.update(&first_line);
    let mut remaining = length - first_line.len() as u64;
    let mut buffer = [0u8; 16 * 1024];
    while remaining > 0 {
        let chunk = remaining.min(buffer.len() as u64) as usize;
        reader.read_exact(&mut buffer[..chunk])?;
        output.write_all(&buffer[..chunk])?;
        hash.update(&buffer[..chunk]);
        remaining -= chunk as u64;
    }
    let after = reader.get_ref().metadata()?;
    ensure!(
        after.len() == before.len() && after.modified()? == before.modified()?,
        "native Kimi file changed during restore"
    );
    output.sync_all()?;
    let identity = crate::kimi_capture::wire_identity(&output, &output.metadata()?)?;
    Ok(ImportedWire { length, identity, protocol, prefix_hash: capture::hex(&hash.finalize()) })
}

pub(super) fn restore(home: &Path, profiles: &Path, config: &Path, cwd: &Path) -> Result<()> {
    let cwd = cwd.canonicalize()?;
    if !dir_chain(profiles, home) || !dir_chain(config, home) {
        return Ok(());
    }
    let mut known = RestoredHistories::new();
    let mut index = Vec::new();
    let mut available = MAX_RESTORE_BYTES;
    let mut manifest_size = 0;
    let mut candidates: Vec<_> = sessions(home, profiles, &cwd).into_iter().collect();
    candidates.sort_by_key(|(_, session)| std::cmp::Reverse(session.updated));
    for (id, mut session) in candidates {
        let source_agents = session.root.join("agents");
        if !private_dir(&source_agents, home)
            || ["upcoming-goals.json", "goal.json", "queue.json"].iter().any(|name| session.root.join(name).exists())
        {
            continue;
        }
        let Some(agents) = session.state["agents"].as_object_mut() else { continue };
        if !agents.contains_key("main") || agents.len() > 64 || !agents.keys().all(|name| safe_component(name)) {
            continue;
        }
        if !agents
            .keys()
            .all(|name| private_dir(&source_agents.join(name), home) && !source_agents.join(name).join("cron").exists())
        {
            continue;
        }
        let destination = config.join("sessions").join(&session.workspace).join(&id);
        launch::private_dir(destination.parent().context("Kimi workspace path has no parent")?)?;
        let staging = tempfile::Builder::new().prefix(".restore-").tempdir_in(destination.parent().unwrap())?;
        let mut wires = BTreeMap::new();
        let mut budget = available;
        let copied = (|| -> Result<()> {
            for (name, agent) in agents {
                ensure!(agent.is_object(), "invalid native Kimi agent");
                let dir = staging.path().join("agents").join(name);
                launch::private_dir(&dir)?;
                let wire =
                    copy_wire(&source_agents.join(name).join("wire.jsonl"), &dir.join("wire.jsonl"), home, budget)?;
                budget -= wire.length;
                wires.insert(name.clone(), wire);
                agent["homedir"] = json!(destination.join("agents").join(name));
            }
            Ok(())
        })();
        if let Err(error) = copied {
            tracing::warn!(%error, "could not restore a native Kimi conversation");
            continue;
        }
        if has_native_writer(&session.config, home, &id) {
            continue;
        }
        let work_dir = &session.state["cwd"];
        let state = serde_json::to_vec(&session.state)?;
        let state_hash = crate::capture::hex(&Sha256::digest(&state));
        let imported =
            RestoredHistory { workspace: session.workspace, source_launch: session.launch, state_hash, wires };
        manifest_size += serde_json::to_vec(&imported)?.len() as u64 + id.len() as u64 + 6;
        if manifest_size >= MAX_MANIFEST_BYTES {
            break;
        }
        launch::write_private(&staging.path().join("state.json"), &state)?;
        fs::rename(staging.path(), &destination)?;
        available = budget;
        serde_json::to_writer(&mut index, &json!({"sessionId":id,"sessionDir":destination,"workDir":work_dir}))?;
        index.push(b'\n');
        known.insert(id, imported);
    }
    if !known.is_empty() {
        launch::write_private(&config.join(MANIFEST), &serde_json::to_vec(&known)?)?;
        launch::write_private(&config.join("session_index.jsonl"), &index)?;
    }
    Ok(())
}

pub(crate) fn restored_history(config: &Path) -> Result<RestoredHistories> {
    let path = config.join(MANIFEST);
    if fs::symlink_metadata(&path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
        return Ok(RestoredHistories::new());
    }
    let file = native_capture::open_private_regular(&path, config).context("invalid Kimi history manifest")?;
    ensure!(file.metadata()?.len() <= MAX_MANIFEST_BYTES, "oversized Kimi history manifest");
    Ok(serde_json::from_reader(file.take(MAX_MANIFEST_BYTES + 1))?)
}

pub(crate) fn restored_history_floor(
    histories: &RestoredHistories,
    config: &Path,
    native: &str,
    path: &Path,
) -> Result<Option<RestoredHistory>> {
    let Some(imported) = histories.get(native) else { return Ok(None) };
    ensure!(
        safe_component(&imported.workspace)
            && native_id(native)
            && path == config.join("sessions").join(&imported.workspace).join(native),
        "invalid Kimi history destination"
    );
    Ok(Some(imported.clone()))
}

pub(crate) fn prune_unmodified_restored_sessions(config: &Path) -> Result<()> {
    let Some(profiles) = config.parent().and_then(Path::parent) else { return Ok(()) };
    let Some(home) = profiles.ancestors().nth(3) else { return Ok(()) };
    if !dir_chain(config, home) {
        return Ok(());
    }
    for (native, imported) in restored_history(config)? {
        if !native_id(&native)
            || !safe_component(&imported.workspace)
            || !launch::is_generated_launch_id(&imported.source_launch)
        {
            continue;
        }
        let new = config.join("sessions").join(&imported.workspace).join(&native);
        let old_home = profiles.join(&imported.source_launch).join("kimi");
        let old = old_home.join("sessions").join(&imported.workspace).join(&native);
        if old_home == config
            || !dir_chain(&old, home)
            || !dir_chain(&new, home)
            || !pristine_state(&new, config, &imported.state_hash)
        {
            continue;
        }
        // Native Kimi may add task state, logs or subagents. Preserve changed directories.
        if !n_names(&new, 2) || !n_names(&new.join("agents"), imported.wires.len()) || imported.wires.is_empty() {
            continue;
        }
        let eligible = imported.wires.iter().all(|(id, wire)| {
            if !safe_component(id) {
                return false;
            }
            let relative = PathBuf::from("agents").join(id);
            let new_agent = new.join(&relative);
            let old_agent = old.join(&relative);
            dir_chain(&new_agent, &new)
                && dir_chain(&old_agent, &old)
                && n_names(&new_agent, 1)
                && identical_import(
                    &new_agent.join("wire.jsonl"),
                    config,
                    &old_agent.join("wire.jsonl"),
                    &old_home,
                    wire,
                )
        });
        if eligible {
            fs::remove_dir_all(&new)?;
        }
    }
    Ok(())
}

fn dir_chain(path: &Path, owner: &Path) -> bool {
    path.strip_prefix(owner).ok().is_some_and(|relative| {
        private_dir(owner, owner)
            && relative
                .components()
                .try_fold(owner.to_path_buf(), |current, component| {
                    let child = current.join(component);
                    private_dir(&child, owner).then_some(child)
                })
                .is_some()
    })
}

fn n_names(path: &Path, count: usize) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
        && fs::read_dir(path).is_ok_and(|entries| entries.take(count + 1).count() == count)
}

fn pristine_state(session: &Path, config: &Path, expected_hash: &str) -> bool {
    if !private_dir(session, config) {
        return false;
    }
    let Some(file) = native_capture::open_private_regular(&session.join("state.json"), config) else { return false };
    let mut bytes = Vec::new();
    file.take(MAX_STATE_BYTES + 1).read_to_end(&mut bytes).is_ok()
        && crate::capture::hex(&Sha256::digest(&bytes)) == expected_hash
}

fn identical_import(new: &Path, new_home: &Path, old: &Path, old_home: &Path, wire: &ImportedWire) -> bool {
    let matched = (|| -> Result<bool> {
        let new_file =
            native_capture::open_private_regular(new, new_home).context("missing restored Kimi transcript")?;
        let old_file =
            native_capture::open_private_regular(old, old_home).context("missing original Kimi transcript")?;
        let meta = new_file.metadata()?;
        if meta.len() != wire.length
            || crate::kimi_capture::wire_identity(&new_file, &meta)? != wire.identity
            || old_file.metadata()?.len() != wire.length
        {
            return Ok(false);
        }
        let mut new_reader = BufReader::new(new_file);
        let mut old_reader = BufReader::new(old_file);
        loop {
            let lhs = new_reader.fill_buf()?;
            let rhs = old_reader.fill_buf()?;
            if lhs != rhs {
                return Ok(false);
            }
            if lhs.is_empty() {
                return Ok(true);
            }
            let length = lhs.len();
            new_reader.consume(length);
            old_reader.consume(length);
        }
    })();
    matched.unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::kimi_capture::{Capture, Session as CaptureSession};
    use crate::kimi_launch::prepare_kimi_code_with_history;
    use crate::outbox::Outbox;

    const NATIVE: &str = "session_70e68dcc-912e-48ce-9589-abd8edbb1973";
    const WORKSPACE: &str = "wd_sample_9ddd1c26d4f2";

    fn user_message(id: &str, text: &str) -> Value {
        json!({"type":"agent.message.appended","time":1650000000000i64,
            "message":{"message":{"role":"user","content":text},"meta":{"userMessageId":id}}})
    }

    #[test]
    fn same_user_reopens_native_kimi_and_captures_only_new_events() {
        let device = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let other_cwd = tempfile::tempdir().unwrap();
        let program = device.path().join(if cfg!(windows) { "kimi.exe" } else { "kimi" });
        let request = launch::Request {
            agent: "kimi-code",
            home: device.path(),
            router_addr: "127.0.0.1:4567",
            local_token: "old-local-token",
            model: "old-model",
            program: &program,
            cwd: cwd.path(),
            client_env: &BTreeMap::new(),
        };
        let old = prepare_kimi_code_with_history(&request, true).unwrap();
        let session = old.config_dir.join("sessions").join(WORKSPACE).join(NATIVE);
        let old_agent = session.join("agents/main");
        fs::create_dir_all(&old_agent).unwrap();
        let wire = format!(
            "{}\n{}\n",
            json!({"type":"metadata","protocol_version":"1.5"}),
            user_message("old", "old user message")
        );
        fs::write(old_agent.join("wire.jsonl"), &wire).unwrap();
        fs::write(
            session.join("state.json"),
            json!({"id":NATIVE,"cwd":cwd.path(),"version":2,"createdAt":1,"updatedAt":2,
                "agents":{"main":{"homedir":old_agent,"type":"main"}}})
            .to_string(),
        )
        .unwrap();
        fs::write(old.config_dir.join("mcp.json"), r#"{"oldSecret":"never imported"}"#).unwrap();
        fs::write(old.config_dir.join("device_id"), "old vendor identity").unwrap();

        let active = prepare_kimi_code_with_history(&request, true).unwrap();
        assert!(!active.config_dir.join("session_index.jsonl").exists());
        launch::finish(device.path(), &old.launch_id).unwrap();
        let locks = old.config_dir.join("locks/sessions");
        fs::create_dir_all(&locks).unwrap();
        let writer = locks.join(format!("{NATIVE}.lock"));
        fs::write(&writer, json!({"version":1,"clientIdentity":"kimi_code_cli","pid":std::process::id()}).to_string())
            .unwrap();
        let interrupted = prepare_kimi_code_with_history(&request, true).unwrap();
        assert!(!interrupted.config_dir.join("session_index.jsonl").exists());
        fs::remove_file(&writer).unwrap();

        let outbox = Arc::new(Outbox::open(&device.path().join("outbox.sqlite")).unwrap());
        let native = CaptureSession {
            session_id: native_capture::session_id("device-a", "kimi-code", NATIVE),
            session_dir: session.clone(),
            agent_version: Some("2.3.0".into()),
            model: "old-model".into(),
            cwd: cwd.path().to_path_buf(),
        };
        Capture::new(native.clone(), outbox.clone()).end(Some(0)).unwrap();
        assert_eq!(outbox.pending(0, 100).unwrap().len(), 3);
        let older_wire = format!("{wire}{}", r#"{"type":"interrupted"#);
        fs::write(old_agent.join("wire.jsonl"), &older_wire).unwrap();

        let request = launch::Request { local_token: "new-local-token", model: "new-model", ..request };
        let refreshed = prepare_kimi_code_with_history(&request, true).unwrap();
        let refreshed_session = refreshed.config_dir.join("sessions").join(WORKSPACE).join(NATIVE);
        let refreshed_wire = refreshed_session.join("agents").join("main").join("wire.jsonl");
        assert_eq!(fs::read_to_string(&refreshed_wire).unwrap(), wire);
        let state = read_json(&refreshed_session.join("state.json"), &refreshed.config_dir, MAX_STATE_BYTES).unwrap();
        assert_eq!(state["agents"]["main"]["homedir"], json!(refreshed_wire.parent().unwrap()));
        let index = fs::read_to_string(refreshed.config_dir.join("session_index.jsonl")).unwrap();
        let index: Value = serde_json::from_str(index.trim()).unwrap();
        assert_eq!(index["sessionId"], NATIVE);
        assert_eq!(index["sessionDir"], json!(refreshed_session));
        assert_eq!(index["workDir"], json!(cwd.path()));
        assert!(!refreshed.config_dir.join("mcp.json").exists());
        assert!(!refreshed.config_dir.join("device_id").exists());
        let config = fs::read_to_string(refreshed.config_dir.join("config.toml")).unwrap();
        assert!(config.contains("new-model") && config.contains("new-local-token"));
        assert!(!config.contains("old-local-token") && !config.contains("old-model"));

        let histories = restored_history(&refreshed.config_dir).unwrap();
        let baseline = restored_history_floor(&histories, &refreshed.config_dir, NATIVE, &refreshed_session).unwrap();
        let capture = Capture::new(
            CaptureSession { session_dir: refreshed_session.clone(), model: "new-model".into(), ..native },
            outbox.clone(),
        )
        .with_restored_history(baseline);
        assert!(!capture.has_native_activity());
        capture.end(Some(0)).unwrap();
        assert_eq!(outbox.pending(0, 100).unwrap().len(), 3);
        writeln!(
            fs::OpenOptions::new().append(true).open(&refreshed_wire).unwrap(),
            "{}",
            user_message("new", "new user message")
        )
        .unwrap();
        assert!(capture.has_native_activity());
        assert_eq!(capture.pass().unwrap().events, 2);
        assert_eq!(capture.pass().unwrap().events, 0);
        capture.end(Some(0)).unwrap();
        let events = outbox.pending(0, 100).unwrap().into_iter().map(|r| r.item).collect::<Vec<_>>();
        let kinds = events.iter().map(|e| e["kind"].as_str().unwrap()).collect::<Vec<_>>();
        assert_eq!(
            kinds,
            ["session_start", "user_message", "session_end", "session_resume", "user_message", "session_end"]
        );
        assert_eq!(events[1]["payload"]["content"], "old user message");
        assert_eq!(events[4]["payload"]["content"], "new user message");

        let parallel = prepare_kimi_code_with_history(&request, true).unwrap();
        assert!(!parallel.config_dir.join("session_index.jsonl").exists());
        launch::finish(device.path(), &refreshed.launch_id).unwrap();
        let idle = prepare_kimi_code_with_history(&request, true).unwrap();
        let idle_session = idle.config_dir.join("sessions").join(WORKSPACE).join(NATIVE);
        assert!(idle_session.exists());
        prune_unmodified_restored_sessions(&idle.config_dir).unwrap();
        prune_unmodified_restored_sessions(&refreshed.config_dir).unwrap();
        assert!(!idle_session.exists());
        assert!(refreshed_session.exists());
        assert_eq!(fs::read_to_string(old_agent.join("wire.jsonl")).unwrap(), older_wire);
        let separate = prepare_kimi_code_with_history(&request, false).unwrap();
        assert!(!separate.config_dir.join("session_index.jsonl").exists());
        for request in
            [launch::Request { home: other.path(), ..request }, launch::Request { cwd: other_cwd.path(), ..request }]
        {
            let launch = prepare_kimi_code_with_history(&request, true).unwrap();
            assert!(!launch.config_dir.join("session_index.jsonl").exists());
        }
    }
}
