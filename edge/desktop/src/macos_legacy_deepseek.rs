//! RC22–RC24 can leave the signed DeepSeek Host in onexd's group after its window has exited.

use std::ffi::{CStr, OsStr};
use std::mem::MaybeUninit;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use tokio::process::Command;

// The only macOS DeepSeek bundle qualified in these onexd releases.
const RELEASE: &str = "0c2217c2c9110d0b5104af8eb4df55f214239405d079d0a83e30080ce1cbd1e1";
const APP: &str = "DeepSeek Harness.app";
const EXECUTABLE: &str = "Contents/MacOS/DeepSeek Harness";
const DSH_RUNTIME: &str = "Contents/Resources/app.asar/dsh";
const HOST: &str = "Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js";
const SIGNATURE: &str = concat!(
    "=anchor apple generic and identifier \"com.deepseek.dsh\" and certificate leaf[subject.OU] = \"NAN929V4UM\"",
    " and cdhash H\"a10a6fe24b2073a4de469d57e4c45348740f083a\""
);
const PROC_PGRP_ONLY: u32 = 2; // <sys/proc_info.h>

#[derive(Debug, PartialEq, Eq, Clone)]
pub(crate) struct Host {
    pid: libc::pid_t,
    started: (u64, u64),
    app: PathBuf,
}

pub(crate) fn daemon_is_idle(status: &Value) -> bool {
    status["ok"] == true
        && matches!(status["version"].as_str(), Some("0.1.0-rc22" | "0.1.0-rc23" | "0.1.0-rc24"))
        && status["upstream"]["inflight"].as_u64() == Some(0)
        && status["managed_agents"].as_array().is_some_and(|agents| {
            agents.iter().any(|agent| agent["id"] == "deepseek-desktop" && agent["status"] == "cached")
                && agents.iter().all(|agent| {
                    agent["instance_count"].as_u64() == Some(0)
                        && agent["progress"].is_null()
                        && matches!(agent["status"].as_str(), Some("available" | "cached" | "download_failed"))
                })
        })
}

fn expected_app(devices: &Path, executable: &Path) -> Option<PathBuf> {
    let relative = executable.strip_prefix(devices).ok()?;
    let device = relative.iter().next()?.to_str()?;
    if device.len() != 32 || !device.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let app = devices.join(device).join("agents/deepseek-desktop/releases").join(RELEASE).join(APP);
    (executable == app.join(EXECUTABLE)).then_some(app)
}

fn expected_profile(app: &Path, project: &[u8]) -> bool {
    let Some(agent) = app.ancestors().nth(3) else { return false };
    let root = agent.join("profiles");
    let Ok(profile) = Path::new(OsStr::from_bytes(project)).strip_prefix(&root) else { return false };
    let mut parts = profile.components();
    for _ in 0..2 {
        let hash = parts.next().and_then(|part| part.as_os_str().to_str());
        if !hash.is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())) {
            return false;
        }
    }
    parts.as_path() == Path::new("dsh/profiles/desktop")
}

fn group_members(group: u32) -> Option<Vec<libc::pid_t>> {
    let estimate = unsafe { libc::proc_listpids(PROC_PGRP_ONLY, group, std::ptr::null_mut(), 0) };
    if estimate <= 0 {
        return None;
    }
    let word = size_of::<libc::pid_t>();
    let mut pids = vec![0; estimate as usize / word + 16];
    let capacity = i32::try_from(size_of_val(pids.as_slice())).ok()?;
    let bytes = unsafe { libc::proc_listpids(PROC_PGRP_ONLY, group, pids.as_mut_ptr().cast(), capacity) };
    if bytes <= 0 || bytes >= capacity || bytes as usize % word != 0 {
        return None;
    }
    pids.truncate(bytes as usize / word);
    pids.sort_unstable();
    Some(pids)
}

fn process_info(pid: libc::pid_t) -> Option<libc::proc_bsdinfo> {
    let mut info = MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let size = size_of::<libc::proc_bsdinfo>() as i32;
    let bytes = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), size) };
    (bytes == size).then(|| unsafe { info.assume_init() })
}

fn process_path(pid: libc::pid_t) -> Option<PathBuf> {
    let mut buffer = [0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let bytes = unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if bytes <= 0 {
        return None;
    }
    let path = CStr::from_bytes_until_nul(&buffer).ok()?;
    Some(PathBuf::from(OsStr::from_bytes(path.to_bytes())))
}

fn host_command(bytes: &[u8], app: &Path) -> bool {
    let Some(argc) = bytes.get(..size_of::<i32>()).and_then(|value| value.try_into().ok()).map(i32::from_ne_bytes)
    else {
        return false;
    };
    if argc < 5 {
        return false;
    }
    let data = &bytes[size_of::<i32>()..];
    let Some(end_of_path) = data.iter().position(|&byte| byte == 0) else { return false };
    let Some(start_of_argv) = data[end_of_path..].iter().position(|&byte| byte != 0) else { return false };
    // KERN_PROCARGS2 stores argc arguments before the environment. A substring in any other
    // argument, or an environment variable, is not evidence this process is the vendor Host.
    let mut argv = data[end_of_path + start_of_argv..].splitn(6, |&byte| byte == 0);
    argv.next() == Some(app.join(EXECUTABLE).as_os_str().as_bytes())
        && argv.next() == Some(b"--expose-internals")
        && argv.next() == Some(app.join(HOST).as_os_str().as_bytes())
        && argv.next() == Some(app.join(DSH_RUNTIME).as_os_str().as_bytes())
        && argv.next().is_some_and(|project| expected_profile(app, project))
        && argv.next().is_some()
}

fn read_host_command(pid: libc::pid_t, app: &Path) -> bool {
    let bound = unsafe { libc::sysconf(libc::_SC_ARG_MAX) };
    let Ok(bound) = usize::try_from(bound) else { return false };
    let mut data = vec![0; bound];
    let mut bytes = data.len();
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let result = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as libc::c_uint,
            data.as_mut_ptr().cast(),
            &mut bytes,
            std::ptr::null_mut(),
            0,
        )
    };
    result == 0 && data.get(..bytes).is_some_and(|data| host_command(data, app))
}

fn host(devices: &Path, daemon: u32, info: &libc::proc_bsdinfo) -> Option<Host> {
    let uid = unsafe { libc::geteuid() };
    let pid = libc::pid_t::try_from(info.pbi_pid).ok()?;
    if pid <= 1 || info.pbi_ppid != 1 || info.pbi_pgid != daemon || info.pbi_ruid != uid || info.pbi_uid != uid {
        return None;
    }
    let app = expected_app(devices, &process_path(pid)?)?;
    read_host_command(pid, &app).then_some(Host { pid, started: (info.pbi_start_tvsec, info.pbi_start_tvusec), app })
}

pub(crate) fn detached_hosts(devices: &Path, daemon: u32) -> Option<Vec<Host>> {
    let devices = devices.canonicalize().ok()?;
    let members = group_members(daemon)?;
    let parent = libc::pid_t::try_from(daemon).ok()?;
    if !members.contains(&parent) {
        return None;
    }
    let mut hosts = Vec::new();
    for pid in members.into_iter().filter(|&pid| pid != parent) {
        let info = process_info(pid)?;
        if info.pbi_status != libc::SZOMB {
            // An unknown or live window in the same group leaves the daemon alone.
            hosts.push(host(&devices, daemon, &info)?);
        }
    }
    (!hosts.is_empty()).then_some(hosts)
}

pub(crate) async fn verify_bundles(hosts: &[Host]) -> bool {
    let apps: std::collections::BTreeSet<&Path> = hosts.iter().map(|host| host.app.as_path()).collect();
    for app in apps {
        let status = Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict", "-R", SIGNATURE])
            .arg(app)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .status();
        if !matches!(tokio::time::timeout(Duration::from_secs(10), status).await, Ok(Ok(status)) if status.success()) {
            return false;
        }
    }
    true
}

pub(crate) fn terminate(devices: &Path, daemon: u32, hosts: &[Host]) -> usize {
    if detached_hosts(devices, daemon).as_deref() != Some(hosts) {
        return 0;
    }
    let Ok(devices) = devices.canonicalize() else { return 0 };
    let mut terminated = 0;
    for target in hosts {
        // Compare the kernel birth time and all ownership evidence again before signaling
        // each PID. A process group is never signaled.
        if process_info(target.pid).and_then(|info| host(&devices, daemon, &info)).as_ref() == Some(target)
            && unsafe { libc::kill(target.pid, libc::SIGTERM) } == 0
        {
            terminated += 1;
        }
    }
    terminated
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn app() -> PathBuf {
        Path::new("/devices")
            .join("000000000000000000000000000000ff/agents/deepseek-desktop/releases")
            .join(RELEASE)
            .join(APP)
    }

    #[test]
    fn only_the_pinned_managed_executable_can_be_a_legacy_host() {
        let app = app();
        let devices = Path::new("/devices");
        let executable = app.join(EXECUTABLE);
        assert_eq!(expected_app(devices, &executable), Some(app.clone()));
        assert_eq!(expected_app(devices, &app.join("Contents/MacOS/other")), None);
        assert_eq!(expected_app(devices, &PathBuf::from(executable.to_str().unwrap().replace(RELEASE, "fake"))), None);
        assert_eq!(expected_app(Path::new("/different-devices"), &executable), None);
    }

    #[test]
    fn requires_the_host_script_at_its_exact_argv_position() {
        let app = app();
        let script = app.join(HOST);
        let bin = app.join(EXECUTABLE);
        let runtime = app.join(DSH_RUNTIME);
        let project = app
            .ancestors()
            .nth(3)
            .unwrap()
            .join("profiles")
            .join("a".repeat(64))
            .join("f".repeat(64))
            .join("dsh/profiles/desktop");
        let build_buffer = |argc: i32, arguments: &[&[u8]]| {
            let mut bytes = argc.to_ne_bytes().to_vec();
            bytes.extend_from_slice(b"/actual/executable\0\0\0");
            for argument in arguments {
                bytes.extend_from_slice(argument);
                bytes.push(0);
            }
            bytes
        };
        let script = script.as_os_str().as_bytes();
        let bin = bin.as_os_str().as_bytes();
        let runtime = runtime.as_os_str().as_bytes();
        let project = project.as_os_str().as_bytes();
        let normal = [bin, b"--expose-internals", script, runtime, project];
        assert!(host_command(&build_buffer(5, &normal), &app));
        assert!(!host_command(&build_buffer(4, &normal), &app));
        for (position, wrong) in [
            (0, b"/other/exe".as_slice()),
            (1, b"--other"),
            (2, b"/fake.js"),
            (3, b"/other/app.asar/dsh"),
            (4, b"/other/dsh/profiles/desktop"),
        ] {
            let mut bad = normal;
            bad[position] = wrong;
            assert!(!host_command(&build_buffer(6, &bad), &app));
        }
    }

    #[test]
    fn cleanup_requires_known_legacy_version_and_verified_idle_state() {
        let status = json!({
            "ok": true, "version": "0.1.0-rc24", "upstream": {"inflight": 0},
            "managed_agents": [{"id": "deepseek-desktop", "status": "cached", "instance_count": 0}]
        });
        assert!(daemon_is_idle(&status));
        for (pointer, value) in [
            ("/ok", json!(false)),
            ("/version", json!("0.1.0-rc25")),
            ("/upstream/inflight", json!(1)),
            ("/upstream/inflight", Value::Null),
            ("/managed_agents/0/instance_count", json!(1)),
            ("/managed_agents/0/status", json!("preparing")),
            ("/managed_agents/0/status", json!("downloading")),
        ] {
            let mut blocked = status.clone();
            *blocked.pointer_mut(pointer).unwrap() = value;
            assert!(!daemon_is_idle(&blocked), "unguarded condition: {pointer}");
        }
    }
}
