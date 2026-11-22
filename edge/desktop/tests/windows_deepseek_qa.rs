#![cfg(all(windows, target_arch = "x86_64", debug_assertions))]

use std::{path::PathBuf, time::Duration};

use onex_desktop::bridge::{Agent, Bridge, Op};
use serde::Deserialize;

const AGENT: &str = "deepseek-desktop";

#[derive(Deserialize)]
struct Credentials {
    employee: Employee,
}

#[derive(Deserialize)]
struct Employee {
    username: String,
    password: String,
}

async fn agent_when(bridge: &Bridge, mut check: impl FnMut(&Agent) -> bool) -> anyhow::Result<Agent> {
    tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            let state = bridge.call(Op::State).await.map_err(|error| anyhow::anyhow!("{}", error.code))?;
            if let Some(agent) = state.agents.into_iter().find(|agent| agent.id == AGENT && check(agent)) {
                return Ok(agent);
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await?
}

#[tokio::test]
#[ignore = "requires the isolated Windows QA daemon and protocol-backup wrapper"]
async fn windows_workbench_downloads_and_launches_deepseek() -> anyhow::Result<()> {
    anyhow::ensure!(std::env::var("ONEX_DEEPSEEK_QA_PROTOCOL_BACKED_UP").as_deref() == Ok("1"));
    let home = PathBuf::from(std::env::var("ONEX_HOME")?);
    let devices = home.join("devices");
    if devices.is_dir() {
        for device in std::fs::read_dir(devices)? {
            let cached = device?.path().join("agents").join(AGENT).join("releases");
            anyhow::ensure!(!cached.exists(), "expected an empty DeepSeek release cache");
        }
    }
    let file = std::env::var("ONEX_WINDOWS_DEEPSEEK_QA_CREDENTIALS")?;
    let Credentials { employee } = serde_json::from_slice(&std::fs::read(file)?)?;
    let bridge = Bridge::new(home.join(onex_core::ipc::SOCKET_NAME));
    let before = bridge.call(Op::State).await.map_err(|error| anyhow::anyhow!("{}", error.code))?;
    anyhow::ensure!(before.settings.server_origin == "http://127.0.0.1:18743", "wrong QA Server");
    let state = bridge
        .call(Op::PasswordLogin {
            tenant: "DeepSeek-QA".into(),
            username: employee.username,
            password: employee.password,
        })
        .await
        .map_err(|error| anyhow::anyhow!("password login returned {}", error.code))?;
    anyhow::ensure!(state.phase == "ready", "password login did not enter the workbench");
    let ready = agent_when(&bridge, |agent| agent.actions.iter().any(|action| action == "download")).await?;
    println!("signed DeepSeek release in workbench: {} {}", ready.version, ready.status);
    bridge
        .call(Op::Download { agent_id: AGENT.into() })
        .await
        .map_err(|error| anyhow::anyhow!("download returned {}", error.code))?;
    let mut progress_seen = false;
    let cached = agent_when(&bridge, |agent| {
        if let Some(progress) = agent.progress.filter(|p| p.total_bytes == 289_415_960 && p.downloaded_bytes > 0) {
            if !progress_seen {
                println!("native workbench download: {} / {} bytes", progress.downloaded_bytes, progress.total_bytes);
            }
            progress_seen = true;
        }
        if agent.status == "download_failed" {
            return true;
        }
        agent.actions.iter().any(|action| action == "launch")
    })
    .await?;
    anyhow::ensure!(cached.status != "download_failed" && progress_seen, "workbench download or progress missing");
    println!("native workbench cached and enabled launch: {}", cached.version);
    bridge
        .call(Op::Launch { agent_id: AGENT.into() })
        .await
        .map_err(|error| anyhow::anyhow!("managed GUI launch returned {}", error.code))?;
    let launched = agent_when(&bridge, |agent| agent.status == "running" && agent.instance_count == 1).await?;
    println!("managed GUI running: {} (instances={})", launched.version, launched.instance_count);
    Ok(())
}
