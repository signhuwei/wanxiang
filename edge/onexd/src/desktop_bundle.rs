//! Install a pinned Desktop bundle inside the OneX cache. The vendor
//! bundle and its signature are kept intact; profiles live outside the app.

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use std::path::Path;
use std::path::PathBuf;

use anyhow::Result;
#[cfg(not(all(windows, target_arch = "x86_64")))]
use anyhow::bail;
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
    payload: DesktopPayload,
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

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(untagged)]
#[serde(bound(deserialize = "'de: 'static"))]
enum DesktopPayload {
    Windows { windows: WindowsBundle },
    Apple(VendorBundle),
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
struct WindowsBundle {
    executable: &'static str,
    executable_sha256: &'static str,
    asar_sha256: &'static str,
    payload_sha256: &'static str,
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

    #[cfg(all(windows, target_arch = "x86_64"))]
    fn windows_deepseek(self) -> Option<WindowsBundle> {
        match self.payload {
            DesktopPayload::Windows { windows }
                if self.agent == "deepseek-desktop" && self.os == "win32" && self.arch == "x64" =>
            {
                Some(windows)
            }
            _ => None,
        }
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    pub(crate) async fn install(self, image: PathBuf) -> Result<PathBuf> {
        tokio::task::spawn_blocking(move || self.install_sync(&image)).await?
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn install_sync(self, image: &Path) -> Result<PathBuf> {
        use std::fs;
        use std::process::{Command, Stdio};

        let vendor = self.apple()?;
        let cache = image.parent().ok_or_else(|| anyhow::anyhow!("invalid image cache path"))?;
        let installed = cache.join(vendor.name);
        if installed.symlink_metadata().is_ok() {
            return self.verify(&installed);
        }

        let temporary = cache.join(format!(".install-{}", crate::id::new("app")));
        let mount = temporary.join("volume");
        let staging = temporary.join(vendor.name);
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
                self.verify(&mount.join(vendor.name))?;
                let copied = Command::new("/usr/bin/ditto")
                    .arg(mount.join(vendor.name))
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
            Ok(installed.join(vendor.executable))
        })();
        // Never recursively clean a volume that remains mounted.
        let _ = fs::remove_dir(&mount);
        let _ = fs::remove_dir_all(&staging);
        let _ = fs::remove_dir(&temporary);
        result
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    pub(super) fn verify(self, app: &Path) -> Result<PathBuf> {
        self.apple()?.verify(app)
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn apple(self) -> Result<VendorBundle> {
        match self.payload {
            DesktopPayload::Apple(vendor) => Ok(vendor),
            DesktopPayload::Windows { .. } => bail!("desktop bundle is not an Apple application"),
        }
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

pub(crate) async fn executable(release: &AgentRelease, image: PathBuf, server: Option<&str>) -> Result<PathBuf> {
    let bundle = Bundle::for_release(release).ok_or_else(|| anyhow::anyhow!("desktop release not approved"))?;
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        let vendor = bundle.windows_deepseek().ok_or_else(|| anyhow::anyhow!("unsupported Windows desktop release"))?;
        let server = server.unwrap_or_default().to_owned();
        tokio::task::spawn_blocking(move || windows::install(&image, bundle.sha256, vendor, &server)).await?
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        let _ = server;
        bundle.install(image).await
    }
    #[cfg(not(any(all(windows, target_arch = "x86_64"), all(target_os = "macos", target_arch = "aarch64"))))]
    {
        let _ = (bundle, image, server);
        bail!("native desktop bundles are unavailable on this platform");
    }
}

pub(crate) fn windows_deepseek_release(release: &AgentRelease) -> bool {
    #[cfg(all(windows, target_arch = "x86_64"))]
    return Bundle::for_release(release).and_then(Bundle::windows_deepseek).is_some();
    #[cfg(not(all(windows, target_arch = "x86_64")))]
    {
        let _ = release;
        false
    }
}

pub(crate) fn windows_deepseek_available(server: &str) -> bool {
    #[cfg(all(windows, target_arch = "x86_64"))]
    return windows::extractor(server).is_ok();
    #[cfg(not(all(windows, target_arch = "x86_64")))]
    {
        let _ = server;
        false
    }
}

#[cfg(all(windows, target_arch = "x86_64"))]
#[path = "desktop_bundle_windows.rs"]
mod windows;

#[cfg(test)]
#[path = "desktop_qualification.rs"]
mod qualification;
