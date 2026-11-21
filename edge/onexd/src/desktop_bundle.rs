//! Install a pinned macOS Desktop bundle inside the OneX cache. The vendor
//! bundle and its signature are kept intact; profiles live outside the app.

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use std::path::Path;
use std::path::PathBuf;

use anyhow::{Result, bail};
use onex_core::ws::AgentRelease;

#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub(crate) struct Bundle {
    pub version: &'static str,
    agent: &'static str,
    os: &'static str,
    arch: &'static str,
    qualified: bool,
    size: u64,
    sha256: &'static str,
    #[serde(flatten)]
    vendor: VendorBundle,
    pub(crate) runtime: Option<RuntimeBundle>,
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub(crate) struct RuntimeBundle {
    pub version: &'static str,
    #[serde(rename = "size")]
    pub bytes: u64,
    #[serde(rename = "sha256")]
    pub digest: &'static str,
    #[serde(flatten)]
    vendor: VendorBundle,
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub(crate) struct VendorBundle {
    pub name: &'static str,
    pub executable: &'static str,
    pub identifier: &'static str,
    pub team: &'static str,
    pub cdhash: &'static str,
}

impl std::ops::Deref for Bundle {
    type Target = VendorBundle;
    fn deref(&self) -> &Self::Target {
        &self.vendor
    }
}

impl std::ops::Deref for RuntimeBundle {
    type Target = VendorBundle;
    fn deref(&self) -> &Self::Target {
        &self.vendor
    }
}

impl Bundle {
    pub(crate) fn for_release(release: &AgentRelease) -> Option<Self> {
        Self::candidate(release)
            .filter(|build| build.qualified && (build.agent != "claude-desktop" || build.runtime.is_some()))
    }

    fn builds() -> &'static [Bundle] {
        static BUILDS: std::sync::OnceLock<Vec<Bundle>> = std::sync::OnceLock::new();
        BUILDS.get_or_init(|| {
            serde_json::from_str(include_str!("../../../server/src/desktop-qualifications.json"))
                .expect("invalid desktop qualification manifest")
        })
    }

    pub(crate) fn manages(agent: &str) -> bool {
        Self::builds().iter().any(|build| build.agent == agent)
    }

    fn candidate(release: &AgentRelease) -> Option<Self> {
        Self::builds().iter().copied().find(|build| {
            build.agent == release.agent
                && build.os == release.os
                && build.arch == release.arch
                && build.version == release.version
                && build.size == release.size
                && build.sha256 == release.sha256
        })
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    pub(crate) async fn install(self, image: PathBuf) -> Result<PathBuf> {
        tokio::task::spawn_blocking(move || self.install_sync(&image)).await?
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn install_sync(self, image: &Path) -> Result<PathBuf> {
        use std::fs;
        use std::process::{Command, Stdio};

        let cache = image.parent().ok_or_else(|| anyhow::anyhow!("invalid image cache path"))?;
        let installed = cache.join(self.name);
        if installed.symlink_metadata().is_ok() {
            return self.verify(&installed);
        }

        let temporary = cache.join(format!(".install-{}", crate::id::new("app")));
        let mount = temporary.join("volume");
        let staging = temporary.join(self.name);
        crate::launch::private_dir(&temporary)?;
        let result = (|| {
            crate::launch::private_dir(&mount)?;
            let attached = Command::new("/usr/bin/hdiutil")
                .args(["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint"])
                .arg(&mount)
                .arg(image)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()?;
            if !attached.success() {
                bail!("could not mount the approved desktop disk image");
            }

            let copy = (|| {
                self.verify(&mount.join(self.name))?;
                let copied = Command::new("/usr/bin/ditto")
                    .arg(mount.join(self.name))
                    .arg(&staging)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()?;
                if !copied.success() {
                    bail!("could not copy the signed desktop bundle");
                }
                self.verify(&staging)?;
                Ok(())
            })();
            let detach = Command::new("/usr/bin/hdiutil")
                .arg("detach")
                .arg(&mount)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            if !detach.is_ok_and(|status| status.success()) {
                bail!("could not detach the desktop disk image");
            }
            copy?;
            fs::rename(&staging, &installed)?;
            Ok(installed.join(self.executable))
        })();
        // Never recursively clean a volume that remains mounted.
        let _ = fs::remove_dir(&mount);
        let _ = fs::remove_dir_all(&staging);
        let _ = fs::remove_dir(&temporary);
        result
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    pub(super) fn verify(self, app: &Path) -> Result<PathBuf> {
        self.vendor.verify(app)
    }
}

impl VendorBundle {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    pub(crate) fn verify(&self, app: &Path) -> Result<PathBuf> {
        use std::process::{Command, Stdio};

        let executable = app.join(self.executable);
        if !app.symlink_metadata().is_ok_and(|meta| meta.is_dir())
            || !executable.symlink_metadata().is_ok_and(|meta| meta.is_file())
        {
            bail!("the approved desktop bundle has an unexpected layout");
        }
        let requirement = format!(
            "=anchor apple generic and identifier \"{}\" and certificate leaf[subject.OU] = \"{}\"",
            self.identifier, self.team,
        );
        let verified = Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict", "-R"])
            .arg(requirement)
            .arg(app)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        if !verified.success() {
            bail!("the desktop bundle does not match the vendor's signature");
        }
        let identity = Command::new("/usr/bin/codesign").args(["-d", "--verbose=4"]).arg(app).output()?;
        let cdhash = String::from_utf8_lossy(&identity.stderr);
        if !identity.status.success() || !cdhash.lines().any(|line| line.strip_prefix("CDHash=") == Some(self.cdhash)) {
            bail!("the desktop bundle differs from the approved build");
        }
        Ok(executable)
    }
}

pub(crate) async fn executable(release: &AgentRelease, image: PathBuf) -> Result<PathBuf> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        let bundle = Bundle::for_release(release).ok_or_else(|| anyhow::anyhow!("desktop release not approved"))?;
        bundle.install(image).await
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        let _ = (release, image);
        bail!("native desktop bundles are currently available for Apple Silicon");
    }
}

#[cfg(test)]
#[path = "desktop_qualification.rs"]
mod qualification;
