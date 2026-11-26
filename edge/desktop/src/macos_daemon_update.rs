use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::{Duration, Instant};

use onex_core::daemon::{
    exchange, macos_managed_processes_alive, macos_shutdown, macos_shutdown_when_idle, macos_status_for_pid,
};
use onex_core::ipc::Request;
use serde_json::Value;
use tokio::process::Command;

use crate::bridge::{ErrorBody, reconnect_busy, reconnect_failed};
use crate::macos_legacy_deepseek;
use crate::updater::{Phase, Updater};

const DESKTOP: &str = "/Applications/OneX Desktop.app/Contents/MacOS/onex-desktop";
const RESOURCES: &str = "/Applications/OneX Desktop.app/Contents/Resources/onex";
const DAEMON: &str = "/Applications/OneX Desktop.app/Contents/Resources/onex/bin/onexd";
const LAUNCH_AGENT: &str = "com.onex.desktop.edge";
const LAUNCH_AGENT_PLIST: &str = "/Library/LaunchAgents/com.onex.desktop.edge.plist";
const LAUNCHCTL: &str = "/bin/launchctl";
const LAUNCHCTL_SERVICE_NOT_FOUND: i32 = 113;
const UNREGISTER_TIMEOUT: Duration = Duration::from_secs(10);
const POLL_BUSY: Duration = Duration::from_secs(10);
const POLL_STARTING: Duration = Duration::from_secs(1);
const START_TIMEOUT: Duration = Duration::from_secs(120);
const MANUAL_TIMEOUT: Duration = Duration::from_secs(35);

/// An installed bundle has a version stamp checked against both binaries at packaging time.
/// Development builds and Desktop processes still mapped from the previous bundle never act on a job.
pub(crate) fn installed_target(version: &str) -> Option<PathBuf> {
    if std::env::current_exe().ok()?.canonicalize().ok()? != Path::new(DESKTOP).canonicalize().ok()? {
        return None;
    }
    let root = Path::new(RESOURCES);
    let stamp = root.join("daemon-version");
    if std::fs::read_to_string(&stamp).ok()?.trim() == version && Path::new(DAEMON).is_file() {
        Some(stamp)
    } else {
        None
    }
}

async fn command_output(program: &str, args: &[&str]) -> Option<Output> {
    let mut command = Command::new(program);
    command.args(args).kill_on_drop(true);
    tokio::time::timeout(Duration::from_secs(3), command.output()).await.ok()?.ok()
}

async fn output(program: &str, args: &[&str]) -> Option<String> {
    let result = command_output(program, args).await?;
    result.status.success().then(|| String::from_utf8_lossy(&result.stdout).into_owned())
}

fn job_property<'a>(job: &'a str, name: &str) -> Option<&'a str> {
    job.lines().find_map(|line| line.strip_prefix('\t')?.strip_prefix(name))
}

fn installed_daemon_job(service: &str, job: &str) -> bool {
    job.lines().next().and_then(|line| line.strip_suffix(" = {")) == Some(service)
        && job_property(job, "path = ") == Some(LAUNCH_AGENT_PLIST)
        && job_property(job, "program = ") == Some(DAEMON)
}

fn installed_daemon_pid(service: &str, job: &str) -> Option<u32> {
    if !installed_daemon_job(service, job) {
        return None;
    }
    job_property(job, "pid = ")?.parse::<u32>().ok().filter(|pid| *pid > 0)
}

fn needs_reregistration(service: &str, job: &str) -> bool {
    installed_daemon_job(service, job)
        && job_property(job, "state = ") == Some("spawn scheduled")
        && job_property(job, "pid = ").is_none()
        && job_property(job, "last exit code = ") == Some("78: EX_CONFIG")
}

fn matches_installed_plist(plist: &Value) -> bool {
    plist["Label"] == LAUNCH_AGENT
        && plist.get("Program").is_none_or(|program| program == DAEMON)
        && plist["ProgramArguments"].as_array().is_some_and(|arguments| arguments.len() == 1 && arguments[0] == DAEMON)
}

async fn verify_installed_plist() -> bool {
    if !std::fs::symlink_metadata(LAUNCH_AGENT_PLIST)
        .is_ok_and(|file| file.is_file() && file.uid() == 0 && file.mode() & 0o022 == 0)
    {
        return false;
    }
    output("/usr/bin/plutil", &["-convert", "json", "-o", "-", LAUNCH_AGENT_PLIST])
        .await
        .and_then(|plist| serde_json::from_str(&plist).ok())
        .is_some_and(|plist| matches_installed_plist(&plist))
}

async fn failed_registered_daemon(service: &str) -> bool {
    output(LAUNCHCTL, &["print", service]).await.is_some_and(|job| needs_reregistration(service, &job))
}

async fn wait_until_unregistered(launchctl: &str, service: &str) -> Result<(), &'static str> {
    loop {
        let result = command_output(launchctl, &["print", service]).await.ok_or("print")?;
        match result.status.code() {
            Some(LAUNCHCTL_SERVICE_NOT_FOUND) => return Ok(()),
            Some(0) => tokio::time::sleep(Duration::from_millis(100)).await,
            _ => return Err("print"),
        }
    }
}

async fn reregister_daemon(
    launchctl: &str,
    domain: &str,
    service: &str,
    unregister_timeout: Duration,
) -> Result<(), &'static str> {
    output(launchctl, &["bootout", service]).await.ok_or("bootout")?;
    // bootout can return before launchd frees the service label.
    tokio::time::timeout(unregister_timeout, wait_until_unregistered(launchctl, service))
        .await
        .map_err(|_| "waiting for service removal")??;
    output(launchctl, &["bootstrap", domain, LAUNCH_AGENT_PLIST]).await.ok_or("bootstrap")?;
    Ok(())
}

async fn ipc(socket: &Path, request: Request) -> Option<Value> {
    tokio::time::timeout(Duration::from_secs(3), exchange(socket, &request)).await.ok()?.ok()
}

async fn installed_service() -> Option<(String, String)> {
    let uid = output("/usr/bin/id", &["-u"]).await?;
    let uid = uid.trim();
    uid.parse::<u32>().ok().filter(|id| *id != 0)?;
    let domain = format!("gui/{uid}");
    let service = format!("{domain}/{LAUNCH_AGENT}");
    Some((domain, service))
}

async fn service_pid(service: &str) -> Option<u32> {
    installed_daemon_pid(service, &output(LAUNCHCTL, &["print", service]).await?)
}

fn restored_device(status: &Value, device: Option<&str>) -> bool {
    status["ok"] == true
        && device.is_none_or(|id| {
            status["logged_in"] == true && status["device_id"] == id && status["ws"] != "unauthenticated"
        })
}

pub(crate) async fn restart(socket: &Path, version: &str, device: Option<&str>, force: bool) -> Result<(), ErrorBody> {
    installed_target(version).ok_or_else(reconnect_failed)?;
    let (domain, service) = installed_service().await.ok_or_else(reconnect_failed)?;
    let previous_pid = service_pid(&service).await;
    if let Some(pid) = previous_pid {
        let status = tokio::time::timeout(Duration::from_secs(3), macos_status_for_pid(socket, pid))
            .await
            .ok()
            .and_then(Result::ok)
            .filter(|status| restored_device(status, device))
            .ok_or_else(reconnect_failed)?;
        if installed_target(version).is_none() {
            return Err(reconnect_failed());
        }
        let reply = tokio::time::timeout(Duration::from_secs(3), async {
            if force { macos_shutdown(socket, pid).await } else { macos_shutdown_when_idle(socket, pid).await }
        })
        .await
        .map_err(|_| reconnect_failed())?
        .map_err(|_| reconnect_failed())?;
        if reply["ok"] != true {
            return Err(if reply["error"]["code"] == "agents_running" { reconnect_busy() } else { reconnect_failed() });
        }
        tracing::info!(pid, force, version = status["version"].as_str(), "requested manual onexd restart");
    }

    let mut repair_attempted = false;
    tokio::time::timeout(MANUAL_TIMEOUT, async {
        loop {
            installed_target(version).ok_or_else(reconnect_failed)?;
            if let Some(pid) = service_pid(&service).await {
                if Some(pid) != previous_pid
                    && matches!(
                        tokio::time::timeout(Duration::from_secs(3), macos_status_for_pid(socket, pid)).await,
                        Ok(Ok(status)) if status["version"] == version && restored_device(&status, device)
                    )
                {
                    return Ok(());
                }
            } else if !repair_attempted && failed_registered_daemon(&service).await && verify_installed_plist().await {
                repair_attempted = true;
                reregister_daemon(LAUNCHCTL, &domain, &service, UNREGISTER_TIMEOUT).await.map_err(|stage| {
                    tracing::warn!(stage, "could not re-register onexd during manual restart");
                    reconnect_failed()
                })?;
            }
            tokio::time::sleep(POLL_STARTING).await;
        }
    })
    .await
    .map_err(|_| reconnect_failed())?
}

pub(crate) async fn reconcile(socket: &Path, version: &str, updater: &Updater, transition: &tokio::sync::Mutex<()>) {
    let Some(stamp) = installed_target(version) else { return };
    let Some(home) = socket.parent() else { return };
    let Some((domain, service)) = installed_service().await else { return };
    let devices = home.join("devices");
    let mut handoff: Option<(Instant, Option<String>)> = None;
    let mut no_status_since = Instant::now();
    let mut reregistration_attempted = false;
    let mut previous_hosts = None;
    let mut attempted_hosts = None;
    let mut delay = Duration::ZERO;

    loop {
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        let _transition = transition.lock().await;
        delay = POLL_STARTING;
        if !tokio::fs::read_to_string(&stamp).await.is_ok_and(|installed| installed.trim() == version) {
            updater.component_phase(None);
            return;
        }
        let status = ipc(socket, Request::Status).await;
        let running_version = status.as_ref().filter(|reply| reply["ok"] == true).and_then(|s| s["version"].as_str());
        // launchd may retain the previous daemon's executable registration after the bundle is replaced.
        // A live PID, a responding socket, or another managed process must finish on its own.
        if status.is_none()
            && !reregistration_attempted
            && failed_registered_daemon(&service).await
            && verify_installed_plist().await
            && matches!(macos_managed_processes_alive(&devices), Ok(false))
            && installed_target(version).is_some()
            && ipc(socket, Request::Status).await.is_none()
            && failed_registered_daemon(&service).await
        {
            reregistration_attempted = true;
            if let Err(stage) = reregister_daemon(LAUNCHCTL, &domain, &service, UNREGISTER_TIMEOUT).await {
                tracing::warn!(stage, "could not re-register the installed macOS Edge daemon");
                updater.component_phase(Some(Phase::ComponentsFailed));
                return;
            }
            let deadline = Instant::now() + START_TIMEOUT;
            match &mut handoff {
                Some((previous_deadline, _)) => *previous_deadline = deadline,
                None => handoff = Some((deadline, None)),
            }
            updater.component_phase(Some(Phase::RestartingDaemon));
            continue;
        }
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
            continue;
        }
        let Some(running_version) = running_version else {
            // A newly bootstrapped LaunchAgent can be waiting for the local Keychain.
            if no_status_since.elapsed() >= START_TIMEOUT {
                return;
            }
            continue;
        };
        no_status_since = Instant::now();
        if running_version == version {
            updater.component_phase(None);
            return;
        }
        let Some(pid) = service_pid(&service).await else {
            updater.component_phase(Some(Phase::DaemonRestartRequired));
            return;
        };
        match macos_managed_processes_alive(&devices) {
            Ok(false) => {}
            Ok(true) => {
                updater.component_phase(Some(Phase::WaitingForAgents));
                let hosts = status
                    .as_ref()
                    .filter(|status| macos_legacy_deepseek::daemon_is_idle(status))
                    .and_then(|_| macos_legacy_deepseek::detached_hosts(&devices, pid));
                if let Some(current) = hosts.as_ref().filter(|_| hosts == previous_hosts && hosts != attempted_hosts) {
                    // Wait for the same already detached processes on two consecutive polls, then try once.
                    attempted_hosts = hosts.clone();
                    let signed = macos_legacy_deepseek::verify_bundles(current);
                    if matches!(tokio::time::timeout(Duration::from_secs(10), signed).await, Ok(true))
                        && installed_target(version).is_some()
                        && service_pid(&service).await == Some(pid)
                        && matches!(
                            tokio::time::timeout(Duration::from_secs(3), macos_status_for_pid(socket, pid)).await,
                            Ok(Ok(ref status))
                                if status["version"] == running_version && macos_legacy_deepseek::daemon_is_idle(status)
                        )
                    {
                        let count = macos_legacy_deepseek::terminate(&devices, pid, current);
                        if count > 0 {
                            tracing::info!(count, "retired detached DeepSeek Hosts from the previous onexd");
                            continue;
                        }
                    }
                }
                previous_hosts = hosts;
                delay = POLL_BUSY;
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
            }
            Some(reply) if reply["error"]["code"] == "agents_running" => {
                updater.component_phase(Some(Phase::WaitingForAgents));
                delay = POLL_BUSY;
            }
            None => {}
            Some(reply) if reply["error"]["code"] == "conflict" => {}
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
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::time::Duration;

    use serde_json::json;

    use super::{
        DAEMON, LAUNCH_AGENT, LAUNCH_AGENT_PLIST, installed_daemon_pid, matches_installed_plist, needs_reregistration,
        reregister_daemon, restored_device,
    };

    const DOMAIN: &str = "gui/501";
    const SERVICE: &str = "gui/501/com.onex.desktop.edge";

    fn job(fields: &str) -> String {
        format!("{SERVICE} = {{\n\tpath = {LAUNCH_AGENT_PLIST}\n\tprogram = {DAEMON}\n{fields}\n}}")
    }

    #[test]
    fn only_targets_the_installed_launch_agent_process() {
        let running = job("\tstate = running\n\tpid = 1234\n\t\tpid = 12");
        assert_eq!(installed_daemon_pid(SERVICE, &running), Some(1234));
        assert_eq!(installed_daemon_pid(SERVICE, &running.replace("/Applications", "/tmp")), None);
        assert_eq!(installed_daemon_pid(SERVICE, &running.replace("/Library", "/tmp")), None);
        assert_eq!(installed_daemon_pid(SERVICE, &running.replace(SERVICE, "gui/501/com.other.agent")), None);
        assert_eq!(installed_daemon_pid(SERVICE, &running.replace("\tpid = 1234\n", "")), None);
        assert_eq!(installed_daemon_pid(SERVICE, &running.replace("1234", "0")), None);
    }

    #[test]
    fn reconnect_waits_for_the_original_device() {
        let mut status = json!({"ok": true, "logged_in": true, "device_id": "device-a", "ws": "connecting"});
        assert!(restored_device(&status, Some("device-a")));
        assert!(!restored_device(&status, Some("device-b")));
        status["ws"] = json!("unauthenticated");
        assert!(!restored_device(&status, Some("device-a")));
        assert!(restored_device(&status, None));
    }

    #[test]
    fn only_reregisters_the_failed_job_without_a_live_pid() {
        let failed = job("\tstate = spawn scheduled\n\tlast exit code = 78: EX_CONFIG\n\t\tpid = 12");
        assert!(needs_reregistration(SERVICE, &failed));
        assert!(!needs_reregistration(SERVICE, &failed.replace("\t\tpid", "\tpid")));
        assert!(!needs_reregistration(SERVICE, &failed.replace("spawn scheduled", "running")));
        assert!(!needs_reregistration(SERVICE, &failed.replace("78: EX_CONFIG", "75: EX_TEMPFAIL")));
        assert!(!needs_reregistration(SERVICE, &failed.replace("\tlast exit code", "\t\tlast exit code")));
        assert!(!needs_reregistration(SERVICE, &failed.replace("/Applications", "/tmp")));
        assert!(!needs_reregistration(SERVICE, &failed.replace("/Library", "/tmp")));
        assert!(!needs_reregistration(SERVICE, &failed.replace(SERVICE, "gui/500/com.onex.desktop.edge")));
    }

    #[test]
    fn verifies_label_and_executable_in_the_plist_before_reregistering() {
        let plist = json!({"Label":LAUNCH_AGENT,"ProgramArguments":[DAEMON]});
        assert!(matches_installed_plist(&plist));
        assert!(!matches_installed_plist(&json!({"Label":"com.other.edge","ProgramArguments":[DAEMON]})));
        assert!(!matches_installed_plist(&json!({"Label":LAUNCH_AGENT,"ProgramArguments":["/tmp/onexd"]})));
        assert!(!matches_installed_plist(&json!({"Label":LAUNCH_AGENT,"ProgramArguments":[DAEMON,"--other"]})));
        assert!(!matches_installed_plist(
            &json!({"Label":LAUNCH_AGENT,"Program":"/tmp/onexd","ProgramArguments":[DAEMON]})
        ));
    }

    #[tokio::test]
    async fn reregisters_only_the_exact_service_and_reports_command_failure() -> std::io::Result<()> {
        for (bootout, bootstrap, print, result) in [
            (0, 0, "gone", Ok(())),
            (12, 0, "gone", Err("bootout")),
            (0, 5, "gone", Err("bootstrap")),
            (0, 0, "delayed", Ok(())),
            (0, 0, "error", Err("print")),
            (0, 0, "present", Err("waiting for service removal")),
        ] {
            let temp = tempfile::tempdir()?;
            let launchctl = temp.path().join("launchctl");
            let calls = temp.path().join("launchctl.calls");
            fs::write(
                &launchctl,
                format!(
                    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$0.calls\"\ncase \"$1\" in\n\
                     bootout) exit {bootout} ;;\nbootstrap) exit {bootstrap} ;;\n\
                     print)\n case {print} in\n\
                     gone) exit 113 ;;\n\
                     delayed) if test -e \"$0.probe\"; then exit 113; fi; touch \"$0.probe\"; exit 0 ;;\n\
                     error) exit 1 ;;\npresent) exit 0 ;;\n\
                     esac ;;\n*) exit 2 ;;\nesac\n"
                ),
            )?;
            fs::set_permissions(&launchctl, fs::Permissions::from_mode(0o700))?;
            let timeout = if print == "present" { Duration::from_millis(350) } else { Duration::from_secs(5) };
            assert_eq!(reregister_daemon(launchctl.to_str().unwrap(), DOMAIN, SERVICE, timeout).await, result);
            let recorded = fs::read_to_string(calls)?;
            let mut recorded = recorded.lines();
            assert_eq!(recorded.next(), Some(format!("bootout {SERVICE}").as_str()));
            if bootout != 0 {
                assert_eq!(recorded.next(), None);
                continue;
            }
            assert_eq!(recorded.next(), Some(format!("print {SERVICE}").as_str()));
            if print == "delayed" {
                assert_eq!(recorded.next(), Some(format!("print {SERVICE}").as_str()));
            }
            if print == "present" {
                assert!(recorded.all(|command| command == format!("print {SERVICE}")));
                continue;
            }
            if print != "error" {
                assert_eq!(recorded.next(), Some(format!("bootstrap {DOMAIN} {LAUNCH_AGENT_PLIST}").as_str()));
            }
            assert_eq!(recorded.next(), None);
        }
        Ok(())
    }
}
