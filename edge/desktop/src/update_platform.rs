//! The downloaded and authenticated update is handed to a helper that outlives Desktop.
//! Helpers preserve the daemon during the GUI restart and switch sidecars only after the daemon's idle check.

use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::{Context, Result, ensure};

#[cfg(target_os = "macos")]
pub(crate) const ARTIFACT_KIND: &str = "macos-pkg-keep-daemon";
#[cfg(windows)]
pub(crate) const ARTIFACT_KIND: &str = "windows-edge-bundle";

#[cfg(target_os = "macos")]
pub(crate) fn install(artifact: &Path, current: &str, target: &str) -> Result<()> {
    use std::os::unix::process::CommandExt;

    const BUNDLE: &str = "/Applications/OneX Desktop.app";
    const EXECUTABLE: &str = "/Applications/OneX Desktop.app/Contents/MacOS/onex-desktop";
    const INSTALLER: &str = "/System/Library/CoreServices/Installer.app";
    ensure!(
        std::env::current_exe()?.canonicalize()? == Path::new(EXECUTABLE).canonicalize()?,
        "Desktop is not installed"
    );
    ensure!(artifact.extension().is_some_and(|ext| ext == "pkg") && artifact.is_file(), "Missing update package");
    ensure!(Path::new(INSTALLER).is_dir(), "macOS Installer is unavailable");
    let installed_version = Command::new("/usr/libexec/PlistBuddy")
        .args(["-c", "Print CFBundleShortVersionString"])
        .arg(Path::new(BUNDLE).join("Contents/Info.plist"))
        .output()
        .context("Reading the installed Desktop version")?;
    ensure!(
        installed_version.status.success() && String::from_utf8_lossy(&installed_version.stdout).trim() == current,
        "Installed Desktop version changed"
    );
    ensure!(current != target, "Desktop already has this version");
    verify_mac_package(artifact, target)?;
    Command::new("/bin/sh")
        .args(["-c", include_str!("../../../deploy/mac/install-desktop-update.sh"), "onex-desktop-update"])
        .arg(artifact)
        .arg(std::process::id().to_string())
        .arg(BUNDLE)
        .arg(INSTALLER)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("Starting macOS Desktop update helper")?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn verify_mac_package(artifact: &Path, target: &str) -> Result<()> {
    const LAUNCH_AGENT: &str = "/Library/LaunchAgents/com.onex.desktop.edge.plist";
    let scratch = tempfile::tempdir()?;
    let expanded = scratch.path().join("package");
    let status = Command::new("/usr/sbin/pkgutil")
        .arg("--expand")
        .arg(artifact)
        .arg(&expanded)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context("Validating the macOS update package")?;
    ensure!(status.success(), "Invalid macOS update package");
    // A normal installer restarts the launchd job. A signed update still needs the
    // packaging marker that selects the runtime-preserving branch in its script.
    ensure!(expanded.join("Scripts/preserve-daemon").is_file(), "Update package does not preserve the Edge daemon");
    let info = std::fs::read_to_string(expanded.join("PackageInfo"))?;
    let identity = info.lines().find(|line| line.starts_with("<pkg-info ")).unwrap_or_default();
    let bundle =
        info.lines().find(|line| line.contains(" path=\"./Applications/OneX Desktop.app\"")).unwrap_or_default();
    ensure!(
        identity.contains(" identifier=\"com.onex.desktop\"")
            && identity.contains(&format!(" version=\"{target}\""))
            && bundle.contains(" id=\"com.onex.desktop\"")
            && bundle.contains(&format!(" CFBundleShortVersionString=\"{target}\"")),
        "Incorrect Desktop update package version"
    );
    let stamp = Command::new("/usr/bin/tar")
        .arg("-xOf")
        .arg(expanded.join("Payload"))
        .arg("./Applications/OneX Desktop.app/Contents/Resources/onex/daemon-version")
        .output()?;
    ensure!(
        stamp.status.success() && std::str::from_utf8(&stamp.stdout)?.trim() == target,
        "The update does not declare the bundled daemon version"
    );
    let next_agent = Command::new("/usr/bin/tar")
        .arg("-xOf")
        .arg(expanded.join("Payload"))
        .arg(format!(".{LAUNCH_AGENT}"))
        .output()?;
    ensure!(next_agent.status.success(), "The update does not include the OneX LaunchAgent");
    let next_plist = scratch.path().join("launch-agent.plist");
    std::fs::write(&next_plist, next_agent.stdout)?;
    let server_origin = |path: &Path| -> Result<Vec<u8>> {
        let output = Command::new("/usr/bin/plutil")
            .args(["-extract", "EnvironmentVariables.ONEX_SERVER", "raw", "-o", "-"])
            .arg(path)
            .output()?;
        ensure!(output.status.success() && !output.stdout.is_empty(), "The OneX LaunchAgent has no Server setting");
        Ok(output.stdout)
    };
    ensure!(
        server_origin(Path::new(LAUNCH_AGENT))? == server_origin(&next_plist)?,
        "The update would change the Server used by the Edge daemon"
    );
    Ok(())
}

#[cfg(windows)]
pub(crate) fn install(artifact: &Path, current: &str, target: &str) -> Result<()> {
    let installed = std::env::current_exe()?;
    let install_dir = installed.parent().context("Missing Desktop installation directory")?;
    ensure!(
        install_dir.join("onexd.exe").is_file() && install_dir.join("onex.exe").is_file(),
        "Desktop is not installed"
    );
    ensure!(current != target, "Desktop already has this version");
    let directory = artifact.parent().context("Missing private staging directory")?;
    let desktop = crate::windows_update_bundle::desktop(artifact, directory)?;
    std::fs::remove_file(artifact)?;
    windows_helper()?
        .env("ONEX_DESKTOP_UPDATE_MODE", "desktop")
        .env("ONEX_DESKTOP_UPDATE_ARTIFACT", desktop)
        .env("ONEX_DESKTOP_UPDATE_EXE", installed)
        .env("ONEX_DESKTOP_UPDATE_PID", std::process::id().to_string())
        .spawn()
        .context("Starting Windows Desktop update helper")?;
    Ok(())
}

#[cfg(windows)]
pub(crate) async fn apply_windows_sidecars(
    cli: &Path,
    daemon: &Path,
    home: &Path,
    version: &str,
) -> Result<std::process::ExitStatus> {
    let mut helper = windows_helper()?;
    helper
        .env("ONEX_DESKTOP_UPDATE_MODE", "sidecars")
        .env("ONEX_DESKTOP_UPDATE_EXE", std::env::current_exe()?)
        .env("ONEX_DESKTOP_UPDATE_CLI", cli)
        .env("ONEX_DESKTOP_UPDATE_DAEMON", daemon)
        .env("ONEX_DESKTOP_UPDATE_VERSION", version)
        .env("ONEX_HOME", home);
    Ok(tokio::process::Command::from(helper).status().await?)
}

#[cfg(windows)]
fn windows_helper() -> Result<Command> {
    use std::os::windows::process::CommandExt;

    use base64::Engine;
    let script = include_str!("../../../deploy/windows/install-desktop-update.ps1");
    let encoded = base64::engine::general_purpose::STANDARD
        .encode(script.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>());
    let shell = system_directory()?.join("WindowsPowerShell/v1.0/powershell.exe");
    let mut command = Command::new(shell);
    command
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"])
        .arg(encoded)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    Ok(command)
}

#[cfg(windows)]
fn system_directory() -> Result<std::path::PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }
    let mut path = vec![0_u16; 32768];
    // The buffer is writable for its declared capacity; the API returns the UTF-16 length.
    let len = unsafe { GetSystemDirectoryW(path.as_mut_ptr(), path.len() as u32) } as usize;
    ensure!(len > 0 && len < path.len(), "Windows system directory is unavailable");
    Ok(OsString::from_wide(&path[..len]).into())
}
