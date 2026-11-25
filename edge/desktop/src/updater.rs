use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, ensure};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use reqwest::{Client, StatusCode, Url};
use ring::signature::{ED25519, UnparsedPublicKey};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::update_platform;

const MAX_ARTIFACT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 4096;
const POLL_INTERVAL: Duration = Duration::from_secs(60);
const PLATFORM: (&str, &str) = if cfg!(target_os = "macos") { ("darwin", "arm64") } else { ("windows", "x64") };

#[cfg(target_os = "macos")]
const DAEMON_UPDATE_MARKER: &str = "daemon-update-pending";

#[cfg(target_os = "macos")]
pub(crate) async fn activate_daemon_update(socket: std::path::PathBuf, version: String) {
    use onex_core::{daemon::exchange, ipc::Request};

    let Some(home) = socket.parent() else { return };
    let marker = home.join(DAEMON_UPDATE_MARKER);
    while tokio::fs::read_to_string(&marker).await.as_deref().ok() == Some(&version) {
        if let Ok(Ok(reply)) =
            tokio::time::timeout(Duration::from_secs(3), exchange(&socket, &Request::ShutdownWhenIdle)).await
        {
            if reply["ok"] == true {
                let _ = tokio::fs::remove_file(&marker).await;
                return;
            }
            if reply["error"]["code"] == "invalid" {
                // Older daemons adopt the installed binary at their next normal restart.
                return;
            }
        }
        tokio::time::sleep(Duration::from_secs(15)).await;
    }
}

#[cfg(target_os = "macos")]
fn stage_daemon_update(version: &str) -> Result<()> {
    use std::io::Write;
    let home = onex_core::ipc::default_home().map_err(anyhow::Error::msg)?;
    let mut marker = tempfile::NamedTempFile::new_in(&home)?;
    marker.write_all(version.as_bytes())?;
    marker.persist(home.join(DAEMON_UPDATE_MARKER))?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
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
enum Phase {
    Available,
    Downloading,
    Installing,
    Failed,
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
        })
    }

    pub(crate) fn observe(self: &Arc<Self>, origin: &str) -> Option<UpdateView> {
        self.key?;
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
        ensure!(self.current_release(origin).await?.as_ref() == Some(manifest), "update is no longer current");
        let directory = tempfile::Builder::new().prefix("onex-desktop-update-").tempdir()?;
        let artifact =
            directory.path().join(if cfg!(target_os = "macos") { "OneX Desktop.pkg" } else { "onex-desktop.exe" });
        let url = origin.join(&format!("/v1/desktop-releases/{}/update-download", manifest.id))?;
        let mut response = self.client.get(url).timeout(Duration::from_secs(300)).send().await?.error_for_status()?;
        ensure!(response.content_length().is_none_or(|size| size == manifest.size), "update byte count changed");
        let mut bytes = 0u64;
        let mut sha = Sha256::new();
        let mut file = tokio::fs::File::create_new(&artifact).await?;
        while let Some(chunk) = response.chunk().await? {
            bytes += chunk.len() as u64;
            ensure!(bytes <= manifest.size, "update is bigger than the signed manifest");
            sha.update(&chunk);
            file.write_all(&chunk).await?;
            if let Some(view) = &mut self.state.lock().unwrap().view {
                view.downloaded_bytes = bytes;
            }
        }
        ensure!(
            bytes == manifest.size && format!("{:x}", sha.finalize()) == manifest.sha256,
            "update hash or size mismatch"
        );
        file.sync_all().await?;
        drop(file);
        ensure!(self.current_release(origin).await?.as_ref() == Some(manifest), "update is no longer current");
        if let Some(view) = &mut self.state.lock().unwrap().view {
            view.phase = Phase::Installing;
        }
        update_platform::install(&artifact, &self.current.to_string(), &manifest.version)?;
        #[cfg(target_os = "macos")]
        if let Err(error) = stage_daemon_update(&manifest.version) {
            tracing::warn!(%error, "could not schedule background daemon replacement");
        }
        let _ = directory.keep();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

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
}
