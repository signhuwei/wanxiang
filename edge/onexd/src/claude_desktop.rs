//! Private Claude Desktop 3P profile and native Code session evidence.

use crate::native_capture::open_private_regular as regular;
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::desktop_bundle::RuntimeBundle;
use crate::desktop_launch::{Request, path_text, publish};
use crate::launch;

const CONFIG_ID: &str = "e6e7642d-8d12-46cf-951f-af48c32fe8f9";
const MAX_USER_PREFIX: u64 = 1024 * 1024;
const MAX_RECORD_SIZE: u64 = 256 * 1024;

#[derive(Clone, Debug)]
pub(crate) struct Profile {
    pub(crate) code: PathBuf,
    pub(crate) records: PathBuf,
    pub(crate) cwd: PathBuf,
}

pub(crate) fn prepare(
    request: &Request<'_>,
    home: &Path,
    run: &Path,
    cwd: &Path,
    engine_archive: &Path,
    engine: RuntimeBundle,
    env: &mut BTreeMap<String, String>,
) -> Result<Profile> {
    ensure!(request.agent == "claude-desktop", "invalid Claude Desktop launch target");
    let endpoint = request.router.parse::<SocketAddr>().context("invalid Claude Desktop local router")?;
    ensure!(endpoint.ip() == Ipv4Addr::LOCALHOST && endpoint.port() != 0, "Claude Desktop needs the local router");
    let model = policy_model(request.model).context("unsupported Claude Desktop contract model")?;
    ensure!(private_root(home) && private_root(run), "Claude Desktop launch roots must be private");
    let onex_home = request.home.canonicalize()?;
    let home = home.canonicalize()?;
    let run = run.canonicalize()?;
    ensure!(
        home.starts_with(onex_home.join("agents/claude-desktop/profiles")) && run.starts_with(onex_home.join("run")),
        "Claude Desktop launch roots must stay inside OneX"
    );
    ensure!(cwd.is_dir() && cwd.canonicalize()? == cwd, "Claude Desktop workspace must be canonical");

    let code = subdir(&home, ".claude")?;
    let library = subdir(&home, "Library")?;
    let support = subdir(&library, "Application Support")?;
    let desktop = subdir(&support, "Claude-3p")?;
    prepare_engine(&desktop, engine_archive, engine)?;
    let profiles = subdir(&desktop, "configLibrary")?;
    let records = subdir(&desktop, "claude-code-sessions")?;
    let helper = run.join("claude-desktop-credential.sh");
    let bearer = crate::desktop_sessions::claude_model_token(request.token);
    launch::write_private(&run.join("claude-desktop-credential.sh.token"), bearer.as_bytes())?;
    write_helper(&helper)?;

    let policy = json!({
        "inferenceProvider":"gateway",
        "inferenceGatewayBaseUrl":format!("http://{endpoint}"),
        "inferenceGatewayAuthScheme":"bearer",
        "inferenceCredentialHelper":path_text(&helper)?,
        "inferenceModels":[model],
        "modelDiscoveryEnabled":false,
        "modelCatalogEnabled":false,
        "alwaysStartWithDefaultModel":true,
        "deploymentMode":"3p",
        "disableDeploymentModeChooser":true,
        "desktopHome":"off",
        "isClaudeCodeForDesktopEnabled":true,
        "disableAutoUpdates":true,
        "disableDeepLinkRegistration":true,
        "disableNonessentialServices":true,
        "disableNonessentialTelemetry":true,
        "disableEssentialTelemetry":true,
        "developerModeEnabled":false,
        "autoModeEnabled":false,
        "disableBypassPermissionsMode":true,
        "scheduledTasksEnabled":false,
        "allowedWorkspaceFolders":[{"path":path_text(cwd)?,"mode":"rw","isDefaultSelected":true}],
        "blockReadsOutsideWorkingDirectories":true,
        "sshHostAllowlist":[],
        "sshConfigs":[],
        "isLocalDevMcpEnabled":false,
        "isDesktopExtensionEnabled":false
    });
    publish(&profiles, &format!("{CONFIG_ID}.json"), &serde_json::to_vec(&policy)?)?;
    publish(
        &profiles,
        "_meta.json",
        &serde_json::to_vec(&json!({
            "appliedId":CONFIG_ID,
            "entries":[{"id":CONFIG_ID,"name":"OneX"}]
        }))?,
    )?;
    publish(&desktop, "claude_desktop_config.json", br#"{"deploymentMode":"3p"}"#)?;

    env.insert("HOME".into(), path_text(&home)?);
    env.insert("CFFIXED_USER_HOME".into(), path_text(&home)?);
    env.insert("CLAUDE_CONFIG_DIR".into(), path_text(&code)?);
    Ok(Profile { code, records, cwd: cwd.to_owned() })
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn prepare_engine(desktop: &Path, archive: &Path, engine: RuntimeBundle) -> Result<()> {
    use std::process::{Command, Stdio};

    let version = subdir(&subdir(desktop, "claude-code")?, engine.version)?;
    // The pinned Desktop build discovers the engine at the same path it would
    // use after its own verified installation.
    let installed = version.join(&engine.digest[..12]);
    if installed.symlink_metadata().is_ok() {
        ensure!(
            safe_directory(&installed, &version) && private_root(&installed),
            "unsafe Claude Code engine directory"
        );
        engine.verify(&installed.join(engine.name))?;
        return publish(&installed, ".verified", engine.digest.as_bytes());
    }

    let stage = tempfile::Builder::new().prefix(".onex-engine-").tempdir_in(&version)?;
    launch::private_dir(stage.path())?;
    let archive = File::open(archive).context("open verified Claude Code archive")?;
    let extracted = Command::new("/usr/bin/tar")
        .args(["-x", "-f", "-", "--no-same-owner", "--no-same-permissions", "-C"])
        .arg(stage.path())
        .stdin(Stdio::from(archive))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context("extract Claude Code engine")?;
    ensure!(extracted.success(), "could not extract the approved Claude Code engine");
    engine.verify(&stage.path().join(engine.name))?;
    launch::write_private(&stage.path().join(".verified"), engine.digest.as_bytes())?;
    fs::rename(stage.path(), &installed).context("install verified Claude Code engine")?;
    Ok(())
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
fn prepare_engine(_: &Path, _: &Path, _: RuntimeBundle) -> Result<()> {
    anyhow::bail!("Claude Desktop runtime requires Apple Silicon")
}

fn policy_model(model: &str) -> Option<&'static Value> {
    static MODELS: std::sync::OnceLock<Vec<Value>> = std::sync::OnceLock::new();
    MODELS
        .get_or_init(|| {
            serde_json::from_str(include_str!("desktop_adapters/claude-models.json"))
                .expect("invalid Claude Desktop inference model catalog")
        })
        .iter()
        .find(|entry| entry["name"] == model)
}

#[cfg(unix)]
fn write_helper(helper: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    launch::write_private(helper, b"#!/bin/sh\nexec /bin/cat -- \"$0.token\"\n")?;
    fs::set_permissions(helper, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn write_helper(_: &Path) -> Result<()> {
    anyhow::bail!("Claude Desktop qualification requires macOS")
}

fn subdir(parent: &Path, name: &str) -> Result<PathBuf> {
    let child = parent.join(name);
    match fs::create_dir(&child) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    ensure!(safe_directory(&child, parent), "unsafe Claude Desktop profile subdirectory");
    launch::private_dir(&child)?;
    Ok(child)
}

#[cfg(unix)]
fn private_root(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir() && meta.permissions().mode() & 0o077 == 0)
}

#[cfg(not(unix))]
fn private_root(_: &Path) -> bool {
    false
}

fn safe_directory(path: &Path, owner: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
        && crate::capture::owned_by_same_principal(path, owner).unwrap_or(false)
}

fn directories(path: &Path) -> impl Iterator<Item = PathBuf> + '_ {
    fs::read_dir(path).into_iter().flatten().flatten().filter_map(|entry| {
        let child = entry.path();
        safe_directory(&child, path).then_some(child)
    })
}

fn canonical_uuid(value: &str) -> Option<Uuid> {
    Uuid::parse_str(value).ok().filter(|id| !id.is_nil() && id.hyphenated().to_string() == value)
}

impl Profile {
    /// The working Code engine writes a complete user frame before its first
    /// Messages request. Desktop writes the GUI-to-engine link after that request.
    pub(crate) fn transcript(&self, native: Uuid, model: &str) -> Option<PathBuf> {
        if native.is_nil() || policy_model(model).is_none() || !private_root(&self.code) {
            return None;
        }
        let projects = self.code.join("projects");
        if !safe_directory(&projects, &self.code) {
            return None;
        }
        let native = native.hyphenated().to_string();
        let filename = format!("{native}.jsonl");
        let mut accepted = None;
        for directory in directories(&projects) {
            let file = directory.join(&filename);
            let Some(handle) = regular(&file, &self.code) else { continue };
            if user_prefix(handle, &native, &self.cwd) {
                if accepted.replace(file).is_some() {
                    return None;
                }
            }
        }
        accepted
    }

    /// Recover the GUI identity after Desktop persists its own record. It is
    /// supplemental evidence on startup, since a first request may block it.
    pub(crate) fn session_record(&self, native: Uuid, model: &str) -> Option<PathBuf> {
        if native.is_nil() || policy_model(model).is_none() || !private_root(&self.records) {
            return None;
        }
        let native = native.hyphenated().to_string();
        let identity_dir =
            |path: &PathBuf| path.file_name().and_then(|name| name.to_str()).and_then(canonical_uuid).is_some();
        let mut accepted = None;
        for account in directories(&self.records).filter(identity_dir) {
            for org in directories(&account).filter(identity_dir) {
                for entry in fs::read_dir(&org).ok()?.flatten() {
                    let path = entry.path();
                    let name = entry.file_name();
                    let Some(gui) = name.to_str().and_then(|name| name.strip_suffix(".json")) else { continue };
                    if gui.strip_prefix("local_").and_then(canonical_uuid).is_none() {
                        continue;
                    }
                    let Some(file) = regular(&path, &self.records) else { continue };
                    if file.metadata().ok()?.len() > MAX_RECORD_SIZE {
                        continue;
                    }
                    let Ok(value) = serde_json::from_reader::<_, Value>(file.take(MAX_RECORD_SIZE + 1)) else {
                        continue;
                    };
                    if value["cliSessionId"].as_str() != Some(&native) {
                        continue;
                    }
                    let matches = value["sessionId"].as_str() == Some(gui)
                        && value["model"].as_str() == Some(model)
                        && workspace(&value["cwd"], &self.cwd)
                        && workspace(&value["originCwd"], &self.cwd)
                        && workspace(&value["folderPlace"]["realPath"], &self.cwd);
                    if !matches || accepted.replace(path).is_some() {
                        return None;
                    }
                }
            }
        }
        accepted
    }
}

fn workspace(value: &Value, expected: &Path) -> bool {
    value.as_str().is_some_and(|cwd| Path::new(cwd) == expected)
}

fn user_prefix(file: File, native: &str, cwd: &Path) -> bool {
    let mut reader = BufReader::new(file.take(MAX_USER_PREFIX));
    let mut line = Vec::new();
    for _ in 0..128 {
        line.clear();
        if reader.read_until(b'\n', &mut line).ok().is_none_or(|size| size == 0) || line.last() != Some(&b'\n') {
            return false;
        }
        let Ok(record) = serde_json::from_slice::<Value>(&line) else { return false };
        let message = &record["message"];
        if record["type"] == "user"
            && record["sessionId"].as_str() == Some(native)
            && workspace(&record["cwd"], cwd)
            && record["isMeta"] != true
            && record["isCompactSummary"] != true
            && record["isSidechain"] != true
            && message["role"] == "user"
            && has_text(&message["content"])
        {
            return true;
        }
    }
    false
}

fn has_text(content: &Value) -> bool {
    let nonempty = |value: &Value| value.as_str().is_some_and(|text| !text.trim().is_empty());
    nonempty(content)
        || content
            .as_array()
            .is_some_and(|blocks| blocks.iter().any(|block| block["type"] == "text" && nonempty(&block["text"])))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    const NATIVE: &str = "d60ff259-0c6d-426d-8600-4efb9c19fc05";
    const MODEL: &str = "sonnet5.5";
    const GUI: &str = "local_28ed129b-9665-4e32-a7a3-f19f4fcdf1fe";

    fn fixture(root: &Path) -> (Profile, PathBuf) {
        let code = subdir(root, "code").unwrap();
        let records = subdir(root, "records").unwrap();
        let cwd = subdir(root, "work").unwrap();
        let projects = subdir(&code, "projects").unwrap();
        let project = subdir(&projects, "one-workspace").unwrap();
        (Profile { code, records, cwd }, project.join(format!("{NATIVE}.jsonl")))
    }

    fn user(native: &str, cwd: &Path) -> Value {
        json!({"type":"user", "sessionId":native, "cwd":cwd, "isSidechain":false,
            "message":{"role":"user", "content":[{"type":"text", "text":"first native prompt"}]}})
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    #[ignore = "requires ONEX_TEST_CLAUDE_ENGINE_ARCHIVE with the pinned vendor archive"]
    fn installs_and_reuses_the_signed_vendor_engine_in_the_private_profile() {
        let archive = std::env::var_os("ONEX_TEST_CLAUDE_ENGINE_ARCHIVE").unwrap();
        let archive = Path::new(&archive);
        let sandbox = tempfile::tempdir().unwrap();
        let manifest: Vec<Value> =
            serde_json::from_str(include_str!("../../../server/src/desktop-qualifications.json")).unwrap();
        let mut build =
            manifest.into_iter().find(|row| row["agent"] == "claude-desktop" && row["version"] == "6.28899.6").unwrap();
        build["id"] = "test-claude".into();
        build["url"] = "/v1/edge/agent-artifacts/test-claude".into();
        let release = serde_json::from_value(build).unwrap();
        let engine = crate::desktop_bundle::Bundle::for_release(&release).unwrap().runtime.unwrap();
        let installed = sandbox.path().join("claude-code").join(engine.version).join(&engine.digest[..12]);
        let invalid = sandbox.path().join("invalid.tar.zst");
        fs::write(&invalid, b"invalid").unwrap();
        assert!(prepare_engine(sandbox.path(), &invalid, engine).is_err());
        assert!(!installed.exists());

        prepare_engine(sandbox.path(), archive, engine).unwrap();
        assert_eq!(fs::read(installed.join(".verified")).unwrap(), engine.digest.as_bytes());
        assert!(installed.join(engine.name).join(engine.executable).is_file());
        assert!(private_root(&installed));
        prepare_engine(sandbox.path(), &invalid, engine).unwrap();
    }

    #[test]
    fn accepts_first_complete_native_user_before_the_gui_record() {
        let sandbox = tempfile::tempdir().unwrap();
        let (profile, transcript) = fixture(sandbox.path());
        let native = Uuid::parse_str(NATIVE).unwrap();
        let line = user(NATIVE, &profile.cwd);
        fs::write(&transcript, line.to_string()).unwrap();
        assert_eq!(profile.transcript(native, MODEL), None);
        let queue = json!({"type":"queue-operation", "sessionId":NATIVE});
        fs::write(&transcript, format!("{queue}\n{line}\n")).unwrap();
        assert_eq!(profile.transcript(native, MODEL).as_ref(), Some(&transcript));
        assert_eq!(profile.session_record(native, MODEL), None);

        let account = subdir(&profile.records, "c275bcbb-d672-4c96-86b3-68c99ab2d9bb").unwrap();
        let org = subdir(&account, "00000000-0000-4000-8000-000000000001").unwrap();
        let record = org.join(format!("{GUI}.json"));
        let value = json!({"sessionId":GUI,"cliSessionId":NATIVE,"model":MODEL,"cwd":profile.cwd,
            "originCwd":profile.cwd,"folderPlace":{"realPath":profile.cwd}});
        fs::write(&record, value.to_string()).unwrap();
        assert_eq!(profile.session_record(native, MODEL), Some(record));
    }

    #[test]
    fn rejects_conflicting_workspace_links_and_non_user_frames() {
        use std::os::unix::fs::symlink;

        let sandbox = tempfile::tempdir().unwrap();
        let (profile, transcript) = fixture(sandbox.path());
        let native = Uuid::parse_str(NATIVE).unwrap();
        let outside = subdir(sandbox.path(), "other").unwrap();
        let wrong = user(NATIVE, &outside);
        fs::write(&transcript, format!("{wrong}\n")).unwrap();
        assert_eq!(profile.transcript(native, MODEL), None);
        let mut meta = user(NATIVE, &profile.cwd);
        meta["isMeta"] = true.into();
        fs::write(&transcript, format!("{meta}\n")).unwrap();
        assert_eq!(profile.transcript(native, MODEL), None);

        let external = outside.join("another.jsonl");
        let valid = user(NATIVE, &profile.cwd);
        fs::write(&external, format!("{valid}\n")).unwrap();
        fs::remove_file(&transcript).unwrap();
        symlink(&external, &transcript).unwrap();
        assert_eq!(profile.transcript(native, MODEL), None);
        fs::remove_file(&transcript).unwrap();
        fs::hard_link(&external, &transcript).unwrap();
        assert_eq!(profile.transcript(native, MODEL), None);
        assert!(policy_model("Qwen3.8-27B").is_none());
    }
}
