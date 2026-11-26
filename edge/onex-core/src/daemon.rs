use std::path::Path;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use crate::ipc::Request;

pub async fn exchange(path: &Path, request: &Request) -> std::io::Result<Value> {
    exchange_on(crate::transport::connect(path).await?, request).await
}

#[cfg(target_os = "macos")]
pub async fn macos_shutdown_when_idle(path: &Path, expected_pid: u32) -> std::io::Result<Value> {
    macos_exchange_with_pid(path, expected_pid, &Request::ShutdownWhenIdle { expected_pid: Some(expected_pid) }).await
}

#[cfg(target_os = "macos")]
pub async fn macos_shutdown(path: &Path, expected_pid: u32) -> std::io::Result<Value> {
    macos_exchange_with_pid(path, expected_pid, &Request::Shutdown).await
}

#[cfg(target_os = "macos")]
pub async fn macos_status_for_pid(path: &Path, expected_pid: u32) -> std::io::Result<Value> {
    macos_exchange_with_pid(path, expected_pid, &Request::Status).await
}

#[cfg(target_os = "macos")]
async fn macos_exchange_with_pid(path: &Path, expected_pid: u32, request: &Request) -> std::io::Result<Value> {
    let connection = crate::transport::connect(path).await?;
    if connection.peer_pid()? != expected_pid {
        return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "the daemon does not own this socket"));
    }
    exchange_on(connection, request).await
}

async fn exchange_on(connection: crate::transport::Connection, request: &Request) -> std::io::Result<Value> {
    let (reader, mut writer) = connection.into_split();
    exchange_line(&mut BufReader::new(reader), &mut writer, request).await
}

async fn exchange_line(
    reader: &mut (impl AsyncBufRead + Unpin),
    writer: &mut (impl AsyncWrite + Unpin),
    request: &Request,
) -> std::io::Result<Value> {
    let mut line = serde_json::to_vec(request)?;
    line.push(b'\n');
    writer.write_all(&line).await?;
    let mut reply = String::new();
    reader.read_line(&mut reply).await?;
    Ok(serde_json::from_str(&reply)?)
}

/// An agent can leave a native backend running after its window and launcher have exited.
/// Check the actual executable paths, including processes reparented to launchd.
#[cfg(target_os = "macos")]
pub fn macos_managed_processes_alive(devices_root: &Path) -> std::io::Result<bool> {
    use std::ffi::{CStr, OsStr};
    use std::io::{self, ErrorKind};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Component;

    let devices_root = match devices_root.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    const PROC_UID_ONLY: u32 = 4; // <sys/proc_info.h>
    // This query takes no buffer and returns the estimated size in bytes.
    let uid = unsafe { libc::geteuid() };
    let estimate = unsafe { libc::proc_listpids(PROC_UID_ONLY, uid, std::ptr::null_mut(), 0) };
    if estimate <= 0 {
        return Err(io::Error::last_os_error());
    }
    let pid_bytes = size_of::<libc::pid_t>();
    let mut pids = vec![0; estimate as usize / pid_bytes + 32];
    let buffer_bytes = i32::try_from(pids.len() * pid_bytes).map_err(io::Error::other)?;
    // The allocation is writable for the entire length supplied to libproc.
    let count = unsafe { libc::proc_listpids(PROC_UID_ONLY, uid, pids.as_mut_ptr().cast(), buffer_bytes) };
    if count <= 0 || count >= buffer_bytes || count as usize % pid_bytes != 0 {
        return Err(io::Error::other("could not read a complete macOS process list"));
    }
    for &pid in &pids[..count as usize / pid_bytes] {
        let mut buffer = [0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // The kernel writes at most the supplied buffer length. A process may exit between calls.
        let length = unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
        if length <= 0 {
            let error = io::Error::last_os_error();
            if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ESRCH)) {
                continue;
            }
            return Err(error);
        }
        let path = CStr::from_bytes_until_nul(&buffer).map_err(io::Error::other)?;
        let executable = Path::new(OsStr::from_bytes(path.to_bytes()));
        let Ok(relative) = executable.strip_prefix(&devices_root) else { continue };
        let mut parts = relative.components();
        if let Some(Component::Normal(device)) = parts.next()
            && device.to_str().is_some_and(|id| id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
            && parts.next() == Some(Component::Normal(OsStr::new("agents")))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// A retained device reopens its original data directory in a fresh daemon.
pub async fn wait_for_device(path: &Path, device_id: &str) -> bool {
    wait_for(path, &Request::Status, |status| {
        status["logged_in"] == true && status["device_id"] == device_id && status["ws"] != "unauthenticated"
    })
    .await
    .is_some()
}

#[cfg(windows)]
pub async fn wait_for_device_info(path: &Path, retired_key: Option<&str>) -> Option<Value> {
    wait_for(path, &Request::DeviceInfo, |info| {
        info["ok"] == true && info["public_key"].as_str().is_some_and(|key| Some(key) != retired_key)
    })
    .await
}

async fn wait_for(path: &Path, request: &Request, accepts: impl Fn(&Value) -> bool) -> Option<Value> {
    #[cfg(windows)]
    let mut child: Option<std::process::Child> = None;
    for _ in 0..48 {
        let reply = tokio::time::timeout(Duration::from_millis(250), exchange(path, request)).await;
        if let Ok(Ok(reply)) = reply.as_ref()
            && accepts(reply)
        {
            return Some(reply.clone());
        }
        #[cfg(windows)]
        if matches!(reply, Ok(Err(ref error)) if error.kind() == std::io::ErrorKind::NotFound)
            && child.as_mut().is_none_or(|child| matches!(child.try_wait(), Ok(Some(_))))
        {
            child = start_windows_sidecar(path).ok();
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    None
}

#[cfg(windows)]
fn lock_windows_sidecar(exe: &Path) -> std::io::Result<Option<std::fs::File>> {
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;

    let lock = exe.with_file_name(".onex-engine-update.lock");
    match OpenOptions::new().read(true).write(true).create(true).truncate(false).share_mode(0).open(&lock) {
        Ok(file) => Ok(Some(file)),
        // A read-only installation supports the normal startup path but cannot stage updates.
        Err(error) if error.raw_os_error() == Some(5) && !lock.exists() => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
fn start_windows_sidecar(path: &Path) -> std::io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
    const DETACHED_PROCESS: u32 = 0x00000008;
    let exe = std::env::current_exe()?.with_file_name("onexd.exe");
    let _startup_lock = lock_windows_sidecar(&exe)?;
    let home = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
    std::process::Command::new(exe)
        .env("ONEX_HOME", home)
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
}

/// Stop the installed daemon through its existing local IPC. A missing daemon is already stopped.
/// A busy daemon returns false so that only an explicit user confirmation can bypass the idle check.
#[cfg(windows)]
pub async fn stop_windows_for_reconnect(path: &Path, device: Option<&str>, force: bool) -> std::io::Result<bool> {
    use std::io::{self, ErrorKind};
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::WaitForSingleObject;

    let exe = std::env::current_exe()?.with_file_name("onexd.exe");
    let _update_lock = lock_windows_sidecar(&exe)?;
    let connection = match crate::transport::connect(path).await {
        Ok(connection) => connection,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error),
    };
    let pid = connection.peer_pid()?;
    let process = windows_sidecar_process(pid, &exe)?;
    let (reader, mut writer) = connection.into_split();
    let mut reader = BufReader::new(reader);
    if let Some(device) = device {
        let status =
            tokio::time::timeout(Duration::from_secs(3), exchange_line(&mut reader, &mut writer, &Request::Status))
                .await??;
        if status["ok"] != true
            || status["logged_in"] != true
            || status["device_id"] != device
            || status["ws"] == "unauthenticated"
        {
            return Err(io::Error::new(ErrorKind::PermissionDenied, "the desktop device has changed"));
        }
    }
    let request = if force { Request::Shutdown } else { Request::ShutdownWhenIdle { expected_pid: Some(pid) } };
    let reply =
        tokio::time::timeout(Duration::from_secs(3), exchange_line(&mut reader, &mut writer, &request)).await??;
    // Let the old daemon release this pipe instance while the process handle remains open.
    drop((reader, writer));
    if !force && reply["error"]["code"] == "agents_running" {
        return Ok(false);
    }
    if reply["ok"] != true {
        return Err(io::Error::other("onexd declined reconnect"));
    }

    // Keep the update lock until the original process exits, so the Windows installer
    // cannot swap the executable while it is still draining. The handle pins that process.
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            // The owned process handle remains open, and a zero timeout does not block the async worker.
            match unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } {
                WAIT_OBJECT_0 => return Ok(true),
                WAIT_TIMEOUT => tokio::time::sleep(Duration::from_millis(250)).await,
                _ => return Err(io::Error::last_os_error()),
            }
        }
    })
    .await?
}

#[cfg(windows)]
fn windows_sidecar_process(pid: u32, exe: &Path) -> std::io::Result<std::os::windows::io::OwnedHandle> {
    use std::ffi::OsString;
    use std::io::{self, ErrorKind};
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, QueryFullProcessImageNameW,
    };

    // Request only the rights needed to verify the executable and wait for normal exit.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    // OpenProcess returned a valid handle, and OwnedHandle now owns it.
    let process = unsafe { OwnedHandle::from_raw_handle(handle) };
    let mut actual = vec![0_u16; 32768];
    let mut length = actual.len() as u32;
    // The destination is writable for length UTF-16 code units, with all pointers valid through the call.
    if unsafe { QueryFullProcessImageNameW(process.as_raw_handle(), 0, actual.as_mut_ptr(), &mut length) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let actual = OsString::from_wide(&actual[..length as usize]);
    if std::fs::canonicalize(actual)? != std::fs::canonicalize(exe)? {
        return Err(io::Error::new(ErrorKind::PermissionDenied, "the pipe does not belong to the installed onexd"));
    }
    Ok(process)
}
