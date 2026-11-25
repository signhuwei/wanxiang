//! Each managed DeepSeek GUI owns an isolated process group containing its native Host.

use std::io;
use std::mem::MaybeUninit;
use std::time::Duration;

use tokio::process::Child;
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;

pub(crate) async fn wait(child: &mut Child, stop: &CancellationToken) -> io::Result<()> {
    let leader = child
        .id()
        .and_then(|id| libc::pid_t::try_from(id).ok())
        .filter(|&id| id > 1)
        .ok_or_else(|| io::Error::other("missing macOS DeepSeek process group leader"))?;
    tokio::select! {
        result = wait_for_exit(leader) => {
            result?;
            // The Host handles the vendor IPC disconnect. Give it time to flush its journal.
            sleep(Duration::from_millis(500)).await;
        }
        _ = stop.cancelled() => {}
    }
    signal_group(leader, libc::SIGTERM)?;
    sleep(Duration::from_secs(1)).await;
    signal_group(leader, libc::SIGKILL)?;
    child.wait().await?;
    Ok(())
}

async fn wait_for_exit(leader: libc::pid_t) -> io::Result<()> {
    while !has_exited(leader)? {
        sleep(Duration::from_millis(100)).await;
    }
    Ok(())
}

fn has_exited(leader: libc::pid_t) -> io::Result<bool> {
    let mut info = MaybeUninit::<libc::siginfo_t>::zeroed();
    // Keep the exited child unreaped until the signals are sent so its PID/PGID cannot be reused.
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            leader as libc::id_t,
            info.as_mut_ptr(),
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result == 0 {
        return Ok(unsafe { info.assume_init().si_pid() } == leader);
    }
    let error = io::Error::last_os_error();
    match error.kind() {
        io::ErrorKind::Interrupted => Ok(false),
        _ => Err(error),
    }
}

fn signal_group(leader: libc::pid_t, signal: libc::c_int) -> io::Result<()> {
    // The GUI started in a new group and its Child has not been reaped.
    if unsafe { libc::killpg(leader, signal) } < 0 {
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ESRCH) => return Ok(()),
            // Darwin can return EPERM when the group has only its zombie leader.
            Some(libc::EPERM) if only_exited_leader_remains(leader)? => return Ok(()),
            _ => return Err(error),
        }
    }
    Ok(())
}

fn only_exited_leader_remains(leader: libc::pid_t) -> io::Result<bool> {
    const PROC_PGRP_ONLY: u32 = 2; // <sys/proc_info.h>
    let mut members = [0 as libc::pid_t; 2];
    // A leader plus any other group member needs at least two slots.
    let bytes = unsafe {
        libc::proc_listpids(PROC_PGRP_ONLY, leader as u32, members.as_mut_ptr().cast(), size_of_val(&members) as i32)
    };
    Ok(bytes == size_of::<libc::pid_t>() as i32 && members[0] == leader && has_exited(leader)?)
}

#[cfg(test)]
#[tokio::test]
async fn cleanup_signals_the_exited_guis_host_without_touching_other_groups() -> io::Result<()> {
    use tokio::process::Command;

    let directory = tempfile::tempdir()?;
    let ready = directory.path().join("ready");
    let terminated = directory.path().join("terminated");
    let mut unrelated = Command::new("/bin/sleep").arg("30").process_group(0).kill_on_drop(true).spawn()?;
    let mut window = Command::new("/bin/sh")
        .args([
            "-c",
            r#"
                (trap ': > "$1"; exit' TERM; : > "$2"; while :; do /bin/sleep 1; done) &
                while [ ! -f "$2" ]; do /bin/sleep 0.01; done
            "#,
            "fake-deepseek",
        ])
        .arg(&terminated)
        .arg(&ready)
        .process_group(0)
        .kill_on_drop(true)
        .spawn()?;
    tokio::time::timeout(Duration::from_secs(5), wait(&mut window, &CancellationToken::new())).await??;
    assert!(terminated.is_file());
    assert!(unrelated.try_wait()?.is_none());
    unrelated.kill().await?;
    Ok(())
}
