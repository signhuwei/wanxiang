use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use onex_core::ipc::{Request, SOCKET_NAME};
use onex_core::transport::{self, Listener, WriteHalf};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

const TIMEOUT: Duration = Duration::from_secs(10);

struct TestHome(PathBuf);

impl TestHome {
    fn new() -> Self {
        static NEXT_HOME: AtomicUsize = AtomicUsize::new(0);
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let serial = NEXT_HOME.fetch_add(1, Ordering::Relaxed);
        let location = std::env::temp_dir().join(format!("onex-cli-{}-{stamp}-{serial}", std::process::id()));
        std::fs::create_dir(&location).unwrap();
        Self(location)
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_onex"));
        command.env("ONEX_HOME", &self.0).current_dir(&self.0).kill_on_drop(true);
        command
    }
}

impl Drop for TestHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn request(listener: &Listener) -> (Request, WriteHalf) {
    let (reader, writer) = tokio::time::timeout(TIMEOUT, listener.accept()).await.unwrap().unwrap().into_split();
    let mut line = String::new();
    tokio::time::timeout(TIMEOUT, BufReader::new(reader).read_line(&mut line)).await.unwrap().unwrap();
    (serde_json::from_str(&line).unwrap(), writer)
}

async fn reply(writer: &mut WriteHalf, body: Value) {
    writer.write_all(format!("{body}\n").as_bytes()).await.unwrap();
}

#[tokio::test]
async fn release_version_is_available_without_a_daemon() {
    let home = TestHome::new();
    let output = home.command().arg("--version").output().await.unwrap();
    assert!(output.status.success());
    let expected = option_env!("ONEX_EDGE_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"));
    assert_eq!(std::str::from_utf8(&output.stdout).unwrap().trim(), format!("onex {expected}"));
}

#[tokio::test]
async fn update_guard_uses_expected_pid_and_preserves_exit_contract() {
    let home = TestHome::new();
    let listener = transport::bind(&home.0.join(SOCKET_NAME)).await.unwrap();
    for (response, code) in [
        (json!({"ok":false,"error":{"code":"agents_running"}}), 3),
        (json!({"ok":false,"error":{"code":"conflict"}}), 1),
        (json!({"ok":true}), 0),
    ] {
        let child = home.command().args(["shutdown-when-idle", "4242"]).stdout(Stdio::piped()).spawn().unwrap();
        let (request, mut writer) = request(&listener).await;
        assert_eq!(request, Request::ShutdownWhenIdle { expected_pid: Some(4242) });
        reply(&mut writer, response.clone()).await;
        let output = tokio::time::timeout(TIMEOUT, child.wait_with_output()).await.unwrap().unwrap();
        assert_eq!(output.status.code(), Some(code));
        assert_eq!(serde_json::from_slice::<Value>(&output.stdout).unwrap(), response);
    }
}

#[test]
fn agent_process_fixture() {
    if std::env::var_os("ONEX_CLI_TEST_AGENT").is_none() {
        return;
    }
    std::fs::write("started", b"ready").unwrap();
    let deadline = Instant::now() + TIMEOUT;
    while !Path::new("continue").is_file() {
        assert!(Instant::now() < deadline, "test Agent did not receive its release signal");
        std::thread::sleep(Duration::from_millis(20));
    }
    std::process::exit(7);
}

#[tokio::test]
async fn managed_terminal_executes_the_daemon_plan_and_tracks_the_child() {
    for agent in ["claude-code", "codex", "kimi-code"] {
        let home = TestHome::new();
        let run_dir = home.0.join("run");
        std::fs::create_dir(&run_dir).unwrap();
        let listener = transport::bind(&home.0.join(SOCKET_NAME)).await.unwrap();
        let child = home
            .command()
            .args(["run", agent, "--managed", "--model", "fixture-model"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let (launch, mut writer) = request(&listener).await;
        let Request::Launch { agent: requested_agent, program, cwd, model, .. } = launch else {
            panic!("expected the real CLI to send a launch request");
        };
        assert_eq!(requested_agent, agent);
        assert_eq!(Path::new(&cwd).canonicalize().unwrap(), home.0.canonicalize().unwrap());
        assert!(program.is_none(), "managed CLI must let the daemon select the executable");
        assert_eq!(model.as_deref(), Some("fixture-model"));

        let mut child_env = json!({"ONEX_CLI_TEST_AGENT":"1"});
        if let Ok(system_root) = std::env::var("SystemRoot") {
            child_env["SystemRoot"] = json!(system_root);
        }
        reply(
            &mut writer,
            json!({
                "ok":true, "launch_id":"test-launch", "session_id":"test-session", "model":"fixture-model",
                "program":std::env::current_exe().unwrap(), "cwd":cwd, "run_dir":run_dir,
                "args":["--exact","agent_process_fixture"], "env":child_env,
            }),
        )
        .await;
        let deadline = Instant::now() + TIMEOUT;
        while !home.0.join("started").is_file() {
            assert!(Instant::now() < deadline, "{agent} was not launched");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(onex_core::run_lock::is_active(&run_dir), "daemon must see the live terminal Agent");
        std::fs::write(home.0.join("continue"), b"").unwrap();
        let (finished, mut writer) = request(&listener).await;
        assert_eq!(finished, Request::LaunchDone { launch_id: "test-launch".into(), exit_code: Some(7) });
        assert!(!onex_core::run_lock::is_active(&run_dir));
        reply(&mut writer, json!({"ok":true})).await;
        let output = tokio::time::timeout(TIMEOUT, child.wait_with_output()).await.unwrap().unwrap();
        assert_eq!(output.status.code(), Some(7));
    }
}
