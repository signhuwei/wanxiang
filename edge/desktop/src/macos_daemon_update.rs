use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use onex_core::daemon::{exchange, macos_managed_processes_alive, macos_shutdown_when_idle};
use onex_core::ipc::Request;
use serde_json::Value;
use tokio::process::Command;

use crate::updater::{Phase, Updater};

const DESKTOP: &str = "/Applications/OneX Desktop.app/Contents/MacOS/onex-desktop";
const RESOURCES: &str = "/Applications/OneX Desktop.app/Contents/Resources/onex";
const LAUNCH_AGENT: &str = "com.onex.desktop.edge";
const POLL_BUSY: Duration = Duration::from_secs(10);
const POLL_STARTING: Duration = Duration::from_secs(1);
const START_TIMEOUT: Duration = Duration::from_secs(120);

/// An installed bundle has a version stamp checked against both binaries at packaging time.
/// Development builds and Desktop processes still mapped from the previous bundle never act on a job.
fn installed_target(version: &str) -> Option<PathBuf> {
    if std::env::current_exe().ok()?.canonicalize().ok()? != Path::new(DESKTOP).canonicalize().ok()? {
        return None;
    }
    let root = Path::new(RESOURCES);
    let stamp = root.join("daemon-version");
    if std::fs::read_to_string(&stamp).ok()?.trim() == version && root.join("bin/onexd").is_file() {
        Some(stamp)
    } else {
        None
    }
}

async fn output(program: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command.args(args).kill_on_drop(true);
    let result = tokio::time::timeout(Duration::from_secs(3), command.output()).await.ok()?.ok()?;
    result.status.success().then(|| String::from_utf8_lossy(&result.stdout).into_owned())
}

fn installed_daemon_pid(job: &str) -> Option<u32> {
    let property = |name: &str| job.lines().find_map(|line| line.strip_prefix('\t')?.strip_prefix(name));
    let program = Path::new(property("program = ")?);
    if program != Path::new(RESOURCES).join("bin/onexd") {
        return None;
    }
    property("pid = ")?.parse::<u32>().ok().filter(|pid| *pid > 0)
}

async fn ipc(socket: &Path, request: Request) -> Option<Value> {
    tokio::time::timeout(Duration::from_secs(3), exchange(socket, &request)).await.ok()?.ok()
}

pub(crate) async fn reconcile(socket: &Path, version: &str, updater: &Updater) {
    let Some(stamp) = installed_target(version) else { return };
    let Some(home) = socket.parent() else { return };
    let Some(uid) = output("/usr/bin/id", &["-u"]).await else { return };
    let uid = uid.trim();
    if uid.parse::<u32>().ok().is_none_or(|id| id == 0) {
        return;
    }
    let job = format!("gui/{uid}/{LAUNCH_AGENT}");
    let devices = home.join("devices");
    let mut handoff: Option<(Instant, Option<String>)> = None;
    let mut no_status_since = Instant::now();

    loop {
        if !tokio::fs::read_to_string(&stamp).await.is_ok_and(|installed| installed.trim() == version) {
            updater.component_phase(None);
            return;
        }
        let status = ipc(socket, Request::Status).await;
        let running_version = status.as_ref().filter(|reply| reply["ok"] == true).and_then(|s| s["version"].as_str());
        if let Some((deadline, device)) = &handoff {
            let identity_restored = device.as_ref().is_none_or(|id| {
                status.as_ref().is_some_and(|s| s["logged_in"] == true && s["device_id"].as_str() == Some(id))
            });
            if running_version == Some(version) && identity_restored {
                updater.component_phase(None);
                return;
            }
            if Instant::now() >= *deadline {
                updater.component_phase(Some(Phase::ComponentsFailed));
                return;
            }
            tokio::time::sleep(POLL_STARTING).await;
            continue;
        }
        let Some(running_version) = running_version else {
            // A newly bootstrapped LaunchAgent can be waiting for the local Keychain.
            if no_status_since.elapsed() >= START_TIMEOUT {
                return;
            }
            tokio::time::sleep(POLL_STARTING).await;
            continue;
        };
        no_status_since = Instant::now();
        if running_version == version {
            updater.component_phase(None);
            return;
        }
        let Some(pid) = output("/bin/launchctl", &["print", &job]).await.as_deref().and_then(installed_daemon_pid)
        else {
            updater.component_phase(Some(Phase::DaemonRestartRequired));
            return;
        };
        match macos_managed_processes_alive(&devices) {
            Ok(false) => {}
            Ok(true) => {
                updater.component_phase(Some(Phase::WaitingForAgents));
                tokio::time::sleep(POLL_BUSY).await;
                continue;
            }
            Err(error) => {
                tracing::warn!(%error, "could not determine whether macOS managed processes are still running");
                updater.component_phase(Some(Phase::DaemonRestartRequired));
                return;
            }
        }
        let reply = match tokio::time::timeout(Duration::from_secs(3), macos_shutdown_when_idle(socket, pid)).await {
            Ok(Ok(reply)) => Some(reply),
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                updater.component_phase(Some(Phase::DaemonRestartRequired));
                return;
            }
            _ => None,
        };
        match reply.as_ref() {
            Some(reply) if reply["ok"] == true => {
                let device = status.as_ref().filter(|s| s["logged_in"] == true).and_then(|s| s["device_id"].as_str());
                handoff = Some((Instant::now() + START_TIMEOUT, device.map(str::to_owned)));
                updater.component_phase(Some(Phase::RestartingDaemon));
                tokio::time::sleep(POLL_STARTING).await;
            }
            Some(reply) if reply["error"]["code"] == "agents_running" => {
                updater.component_phase(Some(Phase::WaitingForAgents));
                tokio::time::sleep(POLL_BUSY).await;
            }
            None => tokio::time::sleep(POLL_STARTING).await,
            Some(reply) if reply["error"]["code"] == "conflict" => tokio::time::sleep(POLL_STARTING).await,
            Some(_) => {
                // Releases predating the idle-guard protocol cannot be stopped safely by Desktop.
                updater.component_phase(Some(Phase::DaemonRestartRequired));
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::installed_daemon_pid;

    #[test]
    fn only_targets_the_installed_launch_agent_process() {
        let job = "\tprogram = /Applications/OneX Desktop.app/Contents/Resources/onex/bin/onexd\n\tpid = 1234\n\t\tpid = 12\n";
        assert_eq!(installed_daemon_pid(job), Some(1234));
        assert_eq!(installed_daemon_pid(&job.replace("/Applications", "/tmp")), None);
        assert_eq!(installed_daemon_pid(&job.replace("\tpid = 1234\n", "")), None);
        assert_eq!(installed_daemon_pid(&job.replace("1234", "0")), None);
    }
}
