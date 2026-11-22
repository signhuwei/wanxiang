//! Loopback-only Windows DeepSeek packaging trial. No publisher installer or global install runs.

use std::ffi::OsString;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, ensure};
use onex_core::ws::AgentRelease;
use sha2::{Digest, Sha256};

const ARCHIVE_SHA: &str = "1e3876baaa20c3f26371dba7b6873bb70c3ef9b91403f6d3f87d2b27d4fd1e3a";
const EXECUTABLE_SHA: &str = "fd7d298f4ba03ee9bab1719a892afeaef5c09bf50c574a592a64c85f64574c0c";
const ASAR_SHA: &str = "04b32e3a872826ba15cfb2081c6a929a8d4ecaa65e09a2543e5a6b30e2eff1f0";

pub(super) fn matches(release: &AgentRelease) -> bool {
    release.agent == "deepseek-desktop"
        && release.os == "win32"
        && release.arch == "x64"
        && release.version == "0.2.1-rc.3"
        && release.size == 289_415_960
        && release.sha256 == ARCHIVE_SHA
}

pub(super) fn loopback(server: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(server) else { return false };
    matches!(url.scheme(), "http" | "https" | "ws" | "wss")
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some_and(|host| matches!(host, "127.0.0.1" | "[::1]"))
}

pub(super) fn extractor_path() -> Option<PathBuf> {
    let file = PathBuf::from(std::env::var_os("ONEX_WINDOWS_DEEPSEEK_QA_7ZIP")?);
    (file.is_absolute() && file.is_file() && file.file_name()? == "7z.exe").then_some(file)
}

fn verify_file(path: &Path, expected: &str) -> Result<()> {
    let mut file = std::fs::File::open(path).with_context(|| format!("could not read {}", path.display()))?;
    let mut hash = Sha256::new();
    std::io::copy(&mut file, &mut hash)?;
    ensure!(crate::capture::hex(&hash.finalize()) == expected, "wrong SHA-256 for {}", path.display());
    Ok(())
}

fn entry(bundle: &Path) -> Result<PathBuf> {
    let exe = bundle.join("DeepSeek Harness.exe");
    verify_file(&exe, EXECUTABLE_SHA)?;
    verify_file(&bundle.join("resources/app.asar"), ASAR_SHA)?;
    ensure!(bundle.join("resources/runtime/primary-runtime").is_dir(), "missing vendor runtime");
    Ok(exe)
}

fn unpack(extractor: &Path, method: &str, source: &Path, output: &Path, member: Option<&str>) -> Result<()> {
    let mut destination = OsString::from("-o");
    destination.push(output);
    let mut command = Command::new(extractor);
    command
        .arg(method)
        .arg(destination)
        .args(["-y", "-bso0", "-bsp0"])
        .arg(source)
        .args(member)
        .stdin(Stdio::null())
        .creation_flags(0x08000000);
    let result = command.output()?;
    ensure!(result.status.success(), "vendor archive extraction failed: {}", String::from_utf8_lossy(&result.stderr));
    Ok(())
}

pub(super) fn install(archive: &Path) -> Result<PathBuf> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().map_err(|_| anyhow::anyhow!("Windows QA cache lock was poisoned"))?;
    let extractor = extractor_path().context("Windows QA needs the approved 7-Zip extractor")?;
    verify_file(&extractor, "dc0493429fe28136fcb177a0e77c9875cbb3b0bff5f2f8eeba4df302e98cef76")?;
    verify_file(
        &extractor.with_file_name("7z.dll"),
        "500db9eb17f3c21b729ba41dd02ecfe1823da05028c7e4ba129084cc74cc364e",
    )?;
    verify_file(archive, ARCHIVE_SHA)?;
    let cache = archive.parent().context("missing Windows QA cache directory")?;
    let installed = cache.join("app-win64");
    if installed.symlink_metadata().is_ok() {
        return entry(&installed);
    }
    let temp = tempfile::Builder::new().prefix(".unpack-").tempdir_in(cache)?;
    unpack(&extractor, "e", archive, temp.path(), Some(r"$PLUGINSDIR\app-64.7z"))?;
    let stage = temp.path().join("app");
    unpack(&extractor, "x", &temp.path().join("app-64.7z"), &stage, None)?;
    entry(&stage)?;
    std::fs::rename(&stage, &installed)?;
    entry(&installed)
}
