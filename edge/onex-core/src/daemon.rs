use std::path::Path;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::ipc::Request;

pub async fn exchange(path: &Path, request: &Request) -> std::io::Result<Value> {
    let (reader, mut writer) = crate::transport::connect(path).await?.into_split();
    let mut line = serde_json::to_vec(request)?;
    line.push(b'\n');
    writer.write_all(&line).await?;
    let mut reply = String::new();
    BufReader::new(reader).read_line(&mut reply).await?;
    Ok(serde_json::from_str(&reply)?)
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
fn start_windows_sidecar(path: &Path) -> std::io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
    const DETACHED_PROCESS: u32 = 0x00000008;
    let exe = std::env::current_exe()?.with_file_name("onexd.exe");
    let home = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
    std::process::Command::new(exe)
        .env("ONEX_HOME", home)
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
}
