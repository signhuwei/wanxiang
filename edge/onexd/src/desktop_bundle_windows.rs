//! Extract a qualified DeepSeek vendor bundle without running the vendor installer.

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
};

use super::WindowsBundle;

const EXTRACTOR_EXE_SHA: &str = "dc0493429fe28136fcb177a0e77c9875cbb3b0bff5f2f8eeba4df302e98cef76";
const EXTRACTOR_DLL_SHA: &str = "500db9eb17f3c21b729ba41dd02ecfe1823da05028c7e4ba129084cc74cc364e";

pub(super) struct Extractor {
    path: PathBuf,
    _exe: File,
    _dll: File,
}

impl Extractor {
    fn open(path: PathBuf) -> Result<Self> {
        ensure!(path.is_absolute() && path.file_name().is_some_and(|name| name == "7z.exe"), "invalid 7-Zip path");
        let directory = path.parent().context("7-Zip directory is missing")?;
        ensure_plain_directory(directory)?;
        let exe = pinned_file(&path, EXTRACTOR_EXE_SHA)?;
        let dll = pinned_file(&directory.join("7z.dll"), EXTRACTOR_DLL_SHA)?;
        Ok(Self { path, _exe: exe, _dll: dll })
    }

    fn unpack(&self, method: &str, source: &Path, output: &Path, member: Option<&str>) -> Result<()> {
        let mut destination = OsString::from("-o");
        destination.push(output);
        let mut command = Command::new(&self.path);
        command
            .arg(method)
            .arg(destination)
            .args(["-y", "-bso0", "-bsp0"])
            .arg(source)
            .args(member)
            .current_dir(output.parent().context("extraction output has no parent")?)
            .env_clear()
            .stdin(Stdio::null())
            .creation_flags(0x08000000);
        if let Some(system_root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", system_root);
        }
        let result = command.output()?;
        ensure!(
            result.status.success(),
            "vendor archive extraction failed: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        Ok(())
    }
}

pub(super) fn extractor(_server: &str) -> Result<Extractor> {
    let daemon = std::env::current_exe()?;
    let directory = daemon.parent().context("cannot locate OneX installation")?;
    let packaged = Extractor::open(directory.join("onex-tools").join("7zip").join("7z.exe"));
    #[cfg(debug_assertions)]
    if packaged.is_err()
        && loopback(_server)
        && let Some(path) = std::env::var_os("ONEX_WINDOWS_DEEPSEEK_QA_7ZIP")
    {
        return Extractor::open(path.into()).context("invalid Windows DeepSeek QA extractor");
    }
    packaged.context("the packaged Windows DeepSeek extractor did not verify")
}

#[cfg(debug_assertions)]
fn loopback(server: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(server) else { return false };
    matches!(url.scheme(), "http" | "https" | "ws" | "wss")
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some_and(|host| matches!(host, "127.0.0.1" | "[::1]"))
}

fn ensure_plain_directory(path: &Path) -> Result<()> {
    let metadata = path.symlink_metadata().with_context(|| format!("could not inspect {}", path.display()))?;
    ensure!(
        metadata.is_dir() && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0,
        "not a plain directory: {}",
        path.display()
    );
    Ok(())
}

fn open_regular(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .with_context(|| format!("could not read {}", path.display()))?;
    let info = crate::capture::windows_file_info(&file)?;
    ensure!(
        info.nNumberOfLinks == 1 && info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0,
        "not a regular file: {}",
        path.display()
    );
    Ok(file)
}

fn pinned_file(path: &Path, expected: &str) -> Result<File> {
    let mut file = open_regular(path)?;
    let mut hash = Sha256::new();
    std::io::copy(&mut file, &mut hash)?;
    ensure!(crate::capture::hex(&hash.finalize()) == expected, "wrong SHA-256 for {}", path.display());
    Ok(file)
}

fn payload_files(directory: &Path, prefix: &str, files: &mut Vec<(String, PathBuf)>) -> Result<()> {
    ensure_plain_directory(directory)?;
    for child in fs::read_dir(directory)? {
        let child = child?;
        let path = child.path();
        let name = child.file_name().into_string().map_err(|_| anyhow::anyhow!("non-Unicode vendor file name"))?;
        let relative = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        let metadata = path.symlink_metadata()?;
        ensure!(
            metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0,
            "unexpected reparse point: {}",
            path.display()
        );
        if metadata.is_dir() {
            payload_files(&path, &relative, files)?;
        } else {
            ensure!(metadata.is_file(), "not a regular file: {}", path.display());
            files.push((relative, path));
        }
    }
    Ok(())
}

fn verify_payload(bundle: &Path, vendor: WindowsBundle) -> Result<()> {
    let mut files = Vec::new();
    payload_files(bundle, "", &mut files)?;
    files.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    let mut payload = Sha256::new();
    let mut verified_executable = false;
    let mut verified_asar = false;
    for (relative, path) in files {
        let mut file = open_regular(&path)?;
        let mut hash = Sha256::new();
        let bytes = std::io::copy(&mut file, &mut hash)?;
        let digest = hash.finalize();
        // Ordinal UTF-8 paths and length-delimited hashes make this portable across extractors and machines.
        payload.update(b"file\0");
        payload.update(relative.as_bytes());
        payload.update(b"\0");
        payload.update(bytes.to_le_bytes());
        payload.update(digest);
        if relative == vendor.executable {
            verified_executable = crate::capture::hex(&digest) == vendor.executable_sha256;
        }
        if relative == "resources/app.asar" {
            verified_asar = crate::capture::hex(&digest) == vendor.asar_sha256;
        }
    }
    ensure!(verified_executable && verified_asar, "the DeepSeek executable or ASAR did not verify");
    ensure!(crate::capture::hex(&payload.finalize()) == vendor.payload_sha256, "the DeepSeek payload did not verify");
    Ok(())
}

pub(super) fn install(archive: &Path, archive_sha: &str, vendor: WindowsBundle, server: &str) -> Result<PathBuf> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().map_err(|_| anyhow::anyhow!("Windows desktop cache lock was poisoned"))?;
    let extractor = extractor(server)?;
    let cache = archive.parent().context("missing Windows desktop cache directory")?;
    ensure_plain_directory(cache)?;
    let installed = cache.join("app-win64");
    if installed.symlink_metadata().is_ok() && verify_payload(&installed, vendor).is_ok() {
        return Ok(installed.join(vendor.executable));
    }

    let _archive = pinned_file(archive, archive_sha)?;
    let temp = tempfile::Builder::new().prefix(".unpack-").tempdir_in(cache)?;
    extractor.unpack("e", archive, temp.path(), Some(r"$PLUGINSDIR\app-64.7z"))?;
    let stage = temp.path().join("app");
    extractor.unpack("x", &temp.path().join("app-64.7z"), &stage, None)?;
    verify_payload(&stage, vendor)?;

    let old = temp.path().join("previous");
    let replacing = match fs::rename(&installed, &old) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error).context("move invalid Windows desktop cache aside"),
    };
    if let Err(error) = fs::rename(&stage, &installed) {
        if replacing && fs::rename(&old, &installed).is_err() {
            let recovery = temp.keep();
            return Err(error).with_context(|| {
                format!("could not publish Windows desktop cache; previous cache retained in {}", recovery.display())
            });
        }
        return Err(error).context("could not publish Windows desktop cache");
    }
    Ok(installed.join(vendor.executable))
}
