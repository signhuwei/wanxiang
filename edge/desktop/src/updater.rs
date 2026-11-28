use std::fs::File;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, ensure};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use reqwest::header::{ACCEPT_ENCODING, CONTENT_ENCODING, CONTENT_RANGE, RANGE};
use reqwest::{Client, StatusCode, Url};
use ring::signature::{ED25519, UnparsedPublicKey};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::update_platform;

const MAX_ARTIFACT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 4096;
const POLL_INTERVAL: Duration = Duration::from_secs(60);
const PLATFORM: (&str, &str) = if cfg!(target_os = "macos") { ("darwin", "arm64") } else { ("windows", "x64") };

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
struct Manifest {
    id: String,
    version: String,
    os: String,
    arch: String,
    kind: String,
    size: u64,
    sha256: String,
    signature: String,
}

impl Manifest {
    fn validate(&self, key: &[u8; 32], current: &Version) -> Result<bool> {
        let id = self.id.strip_prefix("dsk_").unwrap_or_default();
        ensure!(
            id.len() == 26 && id.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()),
            "invalid update ID"
        );
        ensure!(
            (self.os.as_str(), self.arch.as_str()) == PLATFORM && self.kind == update_platform::ARTIFACT_KIND,
            "wrong update platform"
        );
        ensure!((1..=MAX_ARTIFACT_BYTES).contains(&self.size), "invalid update size");
        ensure!(
            self.sha256.len() == 64 && self.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "invalid update digest"
        );
        ensure!(self.version.len() <= 64, "invalid update version");
        let next = Version::parse(&self.version)?;
        let signature = URL_SAFE_NO_PAD.decode(&self.signature)?;
        let signed = format!(
            "onex-desktop-update-v1\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n",
            self.id, self.version, self.os, self.arch, self.kind, self.size, self.sha256
        );
        ensure!(
            UnparsedPublicKey::new(&ED25519, key).verify(signed.as_bytes(), &signature).is_ok(),
            "invalid update signature"
        );
        Ok(next.cmp_precedence(current).is_gt())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Phase {
    Available,
    Downloading,
    Installing,
    Failed,
    WaitingForAgents,
    #[cfg(windows)]
    UpdatingComponents,
    ComponentsFailed,
    #[cfg(target_os = "macos")]
    RestartingDaemon,
    #[cfg(target_os = "macos")]
    DaemonRestartRequired,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct UpdateView {
    version: String,
    phase: Phase,
    downloaded_bytes: u64,
    total_bytes: u64,
}

#[derive(Default)]
struct State {
    origin: Option<Url>,
    checked_at: Option<Instant>,
    candidate: Option<Manifest>,
    view: Option<UpdateView>,
}

impl State {
    fn in_progress(&self) -> bool {
        self.view.as_ref().is_some_and(|view| matches!(view.phase, Phase::Downloading | Phase::Installing))
    }
}

pub(crate) struct Updater {
    current: Version,
    key: Option<[u8; 32]>,
    client: Client,
    state: Mutex<State>,
    pending_components: Mutex<Option<UpdateView>>,
}

impl Updater {
    pub(crate) fn new(current: Version) -> Arc<Self> {
        let key = option_env!("ONEX_DESKTOP_UPDATE_KEY")
            .and_then(|encoded| URL_SAFE_NO_PAD.decode(encoded).ok())
            .and_then(|bytes| bytes.try_into().ok());
        Arc::new(Self {
            current,
            key,
            client: Client::builder()
                .no_proxy()
                .connect_timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("build Desktop update HTTP client"),
            state: Mutex::new(State::default()),
            pending_components: Mutex::new(None),
        })
    }

    pub(crate) fn observe(self: &Arc<Self>, origin: &str) -> Option<UpdateView> {
        if self.key.is_none() {
            return self.pending_components.lock().unwrap().clone();
        }
        let origin = Url::parse(origin).ok().filter(|url| matches!(url.scheme(), "http" | "https"));
        let mut state = self.state.lock().unwrap();
        if state.in_progress() {
            return state.view.clone();
        }
        if state.origin != origin {
            *state = State { origin: origin.clone(), ..State::default() };
        }
        if let Some(origin) = origin
            && state.checked_at.is_none_or(|checked| checked.elapsed() >= POLL_INTERVAL)
        {
            let started = Instant::now();
            state.checked_at = Some(started);
            let updater = Arc::clone(self);
            tauri::async_runtime::spawn(async move {
                let candidate = updater.current_release(&origin).await.ok().flatten();
                let mut state = updater.state.lock().unwrap();
                if state.origin.as_ref() != Some(&origin) || state.checked_at != Some(started) || state.in_progress() {
                    return;
                }
                if candidate != state.candidate {
                    state.view = candidate.as_ref().map(|m| UpdateView {
                        version: m.version.clone(),
                        phase: Phase::Available,
                        downloaded_bytes: 0,
                        total_bytes: m.size,
                    });
                    state.candidate = candidate;
                }
            });
        }
        if state.view.is_none() {
            return self.pending_components.lock().unwrap().clone();
        }
        state.view.clone()
    }

    pub(crate) fn install(self: &Arc<Self>, version: &str, origin: &str, app: tauri::AppHandle) -> Option<UpdateView> {
        let (origin, manifest) = {
            let mut state = self.state.lock().unwrap();
            if state.in_progress() {
                return None;
            }
            let selected_origin = state.origin.clone()?;
            let manifest = state.candidate.clone()?;
            if manifest.version != version || Url::parse(origin).ok().as_ref() != Some(&selected_origin) {
                return None;
            }
            state.view = Some(UpdateView {
                version: manifest.version.clone(),
                phase: Phase::Downloading,
                downloaded_bytes: 0,
                total_bytes: manifest.size,
            });
            (selected_origin, manifest)
        };
        let updater = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            match updater.download_and_install(&origin, &manifest).await {
                Ok(()) => app.exit(0),
                Err(error) => {
                    tracing::warn!(%error, "Desktop update could not be prepared");
                    if let Some(view) = &mut updater.state.lock().unwrap().view {
                        view.phase = Phase::Failed;
                    }
                }
            }
        });
        self.state.lock().unwrap().view.clone()
    }

    async fn current_release(&self, origin: &Url) -> Result<Option<Manifest>> {
        let (os, arch) = PLATFORM;
        let url = origin.join(&format!("/v1/desktop-updates/{os}/{arch}"))?;
        let mut response = self.client.get(url).timeout(Duration::from_secs(8)).send().await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        response = response.error_for_status()?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(chunk.len() <= MAX_MANIFEST_BYTES - bytes.len(), "update manifest is too large");
            bytes.extend_from_slice(&chunk);
        }
        let manifest: Manifest = serde_json::from_slice(&bytes)?;
        let key = self.key.as_ref().context("no Desktop update trust key")?;
        Ok(manifest.validate(key, &self.current)?.then_some(manifest))
    }

    async fn download_and_install(&self, origin: &Url, manifest: &Manifest) -> Result<()> {
        let home = onex_core::ipc::default_home().map_err(anyhow::Error::msg)?;
        let cache = home.join("desktop-update-download");
        tokio::fs::create_dir_all(&cache).await?;
        let lock = File::options().write(true).create(true).truncate(false).open(cache.join("download.lock"))?;
        lock.try_lock().context("could not lock the Desktop update download")?;
        ensure!(self.current_release(origin).await?.as_ref() == Some(manifest), "update is no longer current");
        let partial = update_partial(&cache, origin, manifest).await?;
        download_artifact(&self.client, origin, manifest, &partial, |bytes| {
            if let Some(view) = &mut self.state.lock().unwrap().view {
                view.downloaded_bytes = bytes;
            }
        })
        .await?;
        ensure!(self.current_release(origin).await?.as_ref() == Some(manifest), "update is no longer current");
        let directory = tempfile::Builder::new().prefix("install-").tempdir_in(cache)?;
        let artifact =
            directory.path().join(if cfg!(target_os = "macos") { "OneX Desktop.pkg" } else { "windows.onex-update" });
        tokio::fs::rename(&partial, &artifact).await?;
        if let Some(view) = &mut self.state.lock().unwrap().view {
            view.phase = Phase::Installing;
        }
        #[cfg(windows)]
        stage_windows_bundle(&artifact, manifest).await?;
        update_platform::install(&artifact, &self.current.to_string(), &manifest.version)?;
        let _ = directory.keep();
        Ok(())
    }

    pub(crate) fn component_phase(&self, phase: Option<Phase>) {
        *self.pending_components.lock().unwrap() = phase.map(|phase| UpdateView {
            version: self.current.to_string(),
            phase,
            downloaded_bytes: 0,
            total_bytes: 0,
        });
    }

    #[cfg(windows)]
    pub(crate) async fn resume_windows_components(&self, home: &std::path::Path) -> Result<()> {
        let version = self.current.to_string();
        let directory = home.join("windows-edge-updates").join(&version);
        let manifest_path = directory.join("manifest.json");
        let mut manifest_file = match tokio::fs::File::open(&manifest_path).await {
            Ok(file) => file.take(MAX_MANIFEST_BYTES as u64 + 1),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        let mut encoded = Vec::new();
        manifest_file.read_to_end(&mut encoded).await?;
        ensure!(encoded.len() <= MAX_MANIFEST_BYTES, "pending update manifest is too large");
        let manifest: Manifest = serde_json::from_slice(&encoded)?;
        let key = self.key.as_ref().context("no Desktop update trust key")?;
        ensure!(manifest.version == version, "pending components belong to a different Desktop version");
        manifest.validate(key, &self.current)?;
        let artifact = directory.join("windows.onex-update");
        ensure!(valid_artifact(&artifact, &manifest).await?, "pending Windows update bytes changed");
        let scratch = tempfile::Builder::new().prefix("onex-components-").tempdir()?;
        let (cli, daemon) = crate::windows_update_bundle::sidecars(&artifact, scratch.path())?;
        loop {
            self.component_phase(Some(Phase::UpdatingComponents));
            match update_platform::apply_windows_sidecars(&cli, &daemon, home, &version).await {
                Ok(status) if status.success() => {
                    self.component_phase(None);
                    // The helper has released its files; the signed staged package can now be removed.
                    let _ = tokio::fs::remove_dir_all(&directory).await;
                    return Ok(());
                }
                Ok(status) if status.code() == Some(3) => {
                    self.component_phase(Some(Phase::WaitingForAgents));
                    tokio::time::sleep(Duration::from_secs(15)).await;
                }
                result => {
                    self.component_phase(Some(Phase::ComponentsFailed));
                    anyhow::bail!("Windows component update did not complete: {result:?}");
                }
            }
        }
    }
}

async fn update_partial(cache: &Path, origin: &Url, manifest: &Manifest) -> Result<PathBuf> {
    let key = Sha256::digest(format!("{origin}\n{}\n{}\n{}", manifest.id, manifest.sha256, manifest.size));
    let partial = cache.join(format!("{key:x}.part"));
    // The caller holds the cache lock. Keep at most one signed candidate's partial bytes.
    let mut entries = tokio::fs::read_dir(cache).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path != partial && path.extension().is_some_and(|ext| ext == "part") && entry.file_type().await?.is_file() {
            tokio::fs::remove_file(path).await?;
        }
    }
    Ok(partial)
}

async fn download_artifact(
    client: &Client,
    origin: &Url,
    manifest: &Manifest,
    partial: &Path,
    progress: impl Fn(u64),
) -> Result<()> {
    let mut offset = match tokio::fs::symlink_metadata(partial).await {
        Ok(metadata) => {
            ensure!(metadata.is_file(), "update partial is not a regular file");
            metadata.len()
        }
        Err(error) if error.kind() == ErrorKind::NotFound => 0,
        Err(error) => return Err(error).context("inspect update partial"),
    };
    if offset >= manifest.size {
        if offset == manifest.size && valid_artifact(partial, manifest).await? {
            progress(offset);
            return Ok(());
        }
        tokio::fs::remove_file(partial).await?;
        offset = 0;
    }
    progress(offset);
    let url = origin.join(&format!("/v1/desktop-releases/{}/update-download", manifest.id))?;
    let request = || client.get(url.clone()).timeout(Duration::from_secs(300)).header(ACCEPT_ENCODING, "identity");
    let (mut response, start) = if offset > 0 {
        let response = request().header(RANGE, format!("bytes={offset}-")).send().await?;
        let size = manifest.size;
        let expected_range = format!("bytes {offset}-{}/{size}", size - 1);
        match response.status() {
            StatusCode::PARTIAL_CONTENT
                if response.headers().get(CONTENT_RANGE).is_some_and(|range| range == expected_range.as_str())
                    && response.content_length().is_none_or(|bytes| bytes == size - offset) =>
            {
                (response, offset)
            }
            StatusCode::PARTIAL_CONTENT | StatusCode::RANGE_NOT_SATISFIABLE => {
                drop(response);
                (request().send().await?, 0)
            }
            _ => (response, 0),
        }
    } else {
        (request().send().await?, 0)
    };
    let expected_status = if start == 0 { StatusCode::OK } else { StatusCode::PARTIAL_CONTENT };
    ensure!(response.status() == expected_status, "update download failed: HTTP {}", response.status());
    ensure!(
        response.headers().get(CONTENT_ENCODING).is_none_or(|value| value.as_bytes().eq_ignore_ascii_case(b"identity")),
        "unexpected content encoding for update"
    );
    ensure!(response.content_length().is_none_or(|bytes| bytes == manifest.size - start), "update byte count changed");
    if start != offset {
        progress(start);
    }
    let mut options = tokio::fs::OpenOptions::new();
    options.create(true).write(true).truncate(start == 0).append(start > 0);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(partial).await?;
    let mut written = start;
    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(error) => {
                file.flush().await?;
                return Err(error).context("read update download");
            }
        };
        written += chunk.len() as u64;
        if written > manifest.size {
            drop(file);
            tokio::fs::remove_file(partial).await?;
            anyhow::bail!("update is bigger than the signed manifest");
        }
        file.write_all(&chunk).await?;
        progress(written);
    }
    file.sync_all().await?;
    drop(file);
    ensure!(written == manifest.size, "update was interrupted before the signed size was reached");
    if !valid_artifact(partial, manifest).await? {
        tokio::fs::remove_file(partial).await?;
        anyhow::bail!("update hash or size mismatch");
    }
    Ok(())
}

#[cfg(windows)]
async fn stage_windows_bundle(artifact: &std::path::Path, manifest: &Manifest) -> Result<()> {
    let home = onex_core::ipc::default_home().map_err(anyhow::Error::msg)?;
    let root = home.join("windows-edge-updates");
    tokio::fs::create_dir_all(&root).await?;
    let directory = root.join(&manifest.version);
    if directory.exists() {
        let existing: Manifest = serde_json::from_slice(&tokio::fs::read(directory.join("manifest.json")).await?)?;
        ensure!(
            &existing == manifest && valid_artifact(&directory.join("windows.onex-update"), manifest).await?,
            "a different Windows bundle is already staged for this version"
        );
        return Ok(());
    }
    let temp = tempfile::Builder::new().prefix("staging-").tempdir_in(&root)?;
    tokio::fs::copy(artifact, temp.path().join("windows.onex-update")).await?;
    tokio::fs::write(temp.path().join("manifest.json"), serde_json::to_vec(manifest)?).await?;
    tokio::fs::rename(temp.path(), &directory).await?;
    Ok(())
}

async fn valid_artifact(path: &Path, manifest: &Manifest) -> Result<bool> {
    let mut file = tokio::fs::File::open(path).await?;
    if file.metadata().await?.len() != manifest.size {
        return Ok(false);
    }
    let mut buffer = vec![0_u8; 128 * 1024];
    let mut reader = (&mut file).take(manifest.size + 1);
    let mut sha = Sha256::new();
    let mut size = 0;
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        size += read as u64;
        sha.update(&buffer[..read]);
    }
    Ok(size == manifest.size && format!("{:x}", sha.finalize()) == manifest.sha256)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    fn artifact_manifest(bytes: &[u8]) -> Manifest {
        Manifest {
            id: "dsk_01M88NV5GP9AGYN38CD2GG8WBK".into(),
            version: "0.1.0-rc22".into(),
            os: PLATFORM.0.into(),
            arch: PLATFORM.1.into(),
            kind: update_platform::ARTIFACT_KIND.into(),
            size: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
            signature: String::new(),
        }
    }

    async fn artifact_server(replies: &'static [(Option<&str>, &str, &str)]) -> (Url, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let task = tokio::spawn(async move {
            for (range, headers, bytes) in replies {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(socket.read_u8().await.unwrap());
                }
                let request = String::from_utf8(request).unwrap().to_ascii_lowercase();
                assert_eq!(request.lines().find_map(|line| line.strip_prefix("range: ")), *range);
                assert!(request.contains("\r\naccept-encoding: identity\r\n"));
                socket.write_all(headers.as_bytes()).await.unwrap();
                socket.write_all(bytes.as_bytes()).await.unwrap();
                socket.shutdown().await.unwrap();
            }
        });
        (url, task)
    }

    #[test]
    fn update_verifies_target_and_rejects_tampering_or_downgrade() {
        let key = Ed25519KeyPair::from_seed_unchecked(&[42; 32]).unwrap();
        let (os, arch) = PLATFORM;
        let mut update = Manifest {
            id: "dsk_01M88NV5GP9AGYN38CD2GG8WBK".into(),
            version: "0.1.0-rc22".into(),
            os: os.into(),
            arch: arch.into(),
            kind: update_platform::ARTIFACT_KIND.into(),
            size: 12,
            sha256: "a".repeat(64),
            signature: String::new(),
        };
        let signed = format!(
            "onex-desktop-update-v1\n{}\n0.1.0-rc22\n{os}\n{arch}\n{}\n12\n{}\n",
            update.id, update.kind, update.sha256
        );
        update.signature = URL_SAFE_NO_PAD.encode(key.sign(signed.as_bytes()).as_ref());
        let public_key = key.public_key().as_ref().try_into().unwrap();
        assert!(update.validate(public_key, &Version::parse("0.1.0-rc21").unwrap()).unwrap());
        assert!(!update.validate(public_key, &Version::parse("0.1.0").unwrap()).unwrap());
        assert!(!update.validate(public_key, &Version::parse("0.1.0-rc22+metadata").unwrap()).unwrap());
        update.sha256 = "b".repeat(64);
        assert!(update.validate(public_key, &Version::parse("0.1.0-rc21").unwrap()).is_err());
    }

    #[tokio::test]
    async fn interrupted_update_retains_prefix_and_resumes_on_retry() {
        let manifest = artifact_manifest(b"0123456789");
        let cache = tempfile::tempdir().unwrap();
        let (origin, server) = artifact_server(&[
            (None, "HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\n", "0123"),
            (
                Some("bytes=4-"),
                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 4-9/10\r\nContent-Length: 6\r\nConnection: close\r\n\r\n",
                "456789",
            ),
        ])
        .await;
        let partial = update_partial(cache.path(), &origin, &manifest).await.unwrap();
        let client = Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        assert!(download_artifact(&client, &origin, &manifest, &partial, |_| {}).await.is_err());
        assert_eq!(tokio::fs::read(&partial).await.unwrap(), b"0123");

        let progress = Mutex::new(Vec::new());
        download_artifact(&client, &origin, &manifest, &partial, |bytes| progress.lock().unwrap().push(bytes))
            .await
            .unwrap();
        assert_eq!(tokio::fs::read(&partial).await.unwrap(), b"0123456789");
        let progress = progress.into_inner().unwrap();
        assert_eq!((progress.first(), progress.last()), (Some(&4), Some(&10)));
        tokio::time::timeout(Duration::from_secs(5), server).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn invalid_update_range_is_discarded_and_tampered_replacement_is_rejected() {
        let manifest = artifact_manifest(b"0123456789");
        let cache = tempfile::tempdir().unwrap();
        let (origin, server) = artifact_server(&[
            (
                Some("bytes=4-"),
                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 5-9/10\r\nContent-Length: 5\r\nConnection: close\r\n\r\n",
                "56789",
            ),
            (None, "HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\n", "012345678!"),
        ])
        .await;
        let partial = update_partial(cache.path(), &origin, &manifest).await.unwrap();
        tokio::fs::write(&partial, b"0123").await.unwrap();
        let client = Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        let error = download_artifact(&client, &origin, &manifest, &partial, |_| {}).await.unwrap_err();
        assert!(error.to_string().contains("hash or size mismatch"));
        assert!(!partial.exists());
        tokio::time::timeout(Duration::from_secs(5), server).await.unwrap().unwrap();
    }
}
