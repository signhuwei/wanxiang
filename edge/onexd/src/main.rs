//! onexd：OneX Edge 后台 daemon。
//!
//! 环境变量：
//! - `ONEX_HOME`：数据目录，默认 `~/Library/Application Support/OneX`
//! - `ONEX_SERVER`：Server 的 WS 地址，例如 `wss://onex.example.com/v1/edge/ws`
//! - `ONEX_ROUTER_PORT`：本机 router 端口，默认 0（随机）
//! - `RUST_LOG`：日志级别，默认 `info`

use std::io::Write;
use std::net::{Ipv4Addr, SocketAddr};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use onex_core::ipc::SOCKET_NAME;
use onexd::ipc::{self, Ipc};
use onexd::lease::{LeaseOptions, Ledger};
use onexd::outbox::{Kind, Outbox};
use onexd::router::{self, Router, UsageRecord};
use onexd::state::State;
use onexd::{id, ws};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    let home = home_dir()?;
    std::fs::create_dir_all(&home)?;
    let started_at = time::OffsetDateTime::now_utc();
    let _log_guard = init_logging(&home)?;
    if let Err(e) = run(home, started_at).await {
        error!(error = %format!("{e:#}"), "onexd exited with error");
        return Err(e);
    }
    Ok(())
}

async fn run(home: PathBuf, started_at: time::OffsetDateTime) -> Result<()> {
    info!(version = env!("CARGO_PKG_VERSION"), home = %home.display(), "onexd starting");
    let shutdown = CancellationToken::new();
    let outbox = Arc::new(Outbox::open(&home.join("outbox.sqlite"))?);
    let lease = Arc::new(Ledger::open(home.join("lease.json"), LeaseOptions::default(), &outbox)?);
    let state = Arc::new(State { lease: lease.clone(), ..Default::default() });
    tokio::spawn(lease.run(shutdown.clone()));

    let sock_path = home.join(SOCKET_NAME);
    let listener = ipc::bind(&sock_path).await?;

    // 本机令牌每次启动重新生成，写到 0600 文件里，供 Agent 启动器读取。
    let local_token = id::token();
    write_private(&home.join("router.token"), &local_token)?;
    let port: u16 = std::env::var("ONEX_ROUTER_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(0);
    let tcp =
        tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).await.context("bind router")?;
    let router_addr = tcp.local_addr()?;
    std::fs::write(home.join("router.addr"), router_addr.to_string())?;
    info!(%router_addr, "router listening");

    let (usage_tx, mut usage_rx) = mpsc::unbounded_channel::<UsageRecord>();
    // 默认客户端遵从 HTTPS_PROXY / NO_PROXY。
    let http = router::client_builder().build()?;
    let app = Router::new(state.clone(), local_token.clone(), http, usage_tx).app();
    onexd::launch::clean_stale(&home);
    let sd = shutdown.clone();
    let router_task =
        tokio::spawn(
            async move { axum::serve(tcp, app).with_graceful_shutdown(async move { sd.cancelled().await }).await },
        );
    let ob = outbox.clone();
    tokio::spawn(async move {
        while let Some(rec) = usage_rx.recv().await {
            let ob = ob.clone();
            let r = tokio::task::spawn_blocking(move || ob.append(Kind::Usage, rec.to_item())).await;
            if let Ok(Err(e)) | Err(e) = r.map_err(anyhow::Error::from) {
                error!(error = %format!("{e:#}"), "write usage to outbox");
            }
        }
    });

    let server = std::env::var("ONEX_SERVER").ok();
    let ipc = Arc::new(Ipc {
        state: state.clone(),
        outbox: outbox.clone(),
        router_addr: Some(router_addr.to_string()),
        server_url: server.as_deref().and_then(onex_core::ipc::http_base),
        launch: Some(ipc::LaunchCtx::new(home.clone(), local_token)),
        shutdown: shutdown.clone(),
    });
    let ipc_task = tokio::spawn(ipc::serve(listener, sock_path, ipc));

    let ws_task = match server {
        Some(url) => {
            let options = ws::WsOptions::new(url).with_diagnostic_logs(home.join("logs"), started_at);
            Some(tokio::spawn(ws::run(options, state, outbox, shutdown.clone())))
        }
        None => {
            info!("ONEX_SERVER not set; running without server connection");
            None
        }
    };

    tokio::select! {
        _ = shutdown.cancelled() => {}
        _ = tokio::signal::ctrl_c() => { info!("SIGINT"); shutdown.cancel(); }
        _ = sigterm() => { info!("SIGTERM"); shutdown.cancel(); }
    }
    if let Some(t) = ws_task {
        let _ = t.await;
    }
    let _ = ipc_task.await;
    router_task.await??;
    info!("onexd stopped");
    Ok(())
}

async fn sigterm() {
    let mut s = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("sigterm handler");
    s.recv().await;
}

fn home_dir() -> Result<PathBuf> {
    if let Some(h) = std::env::var_os("ONEX_HOME") {
        return Ok(PathBuf::from(h));
    }
    let home = std::env::var_os("HOME").context("HOME not set")?;
    Ok(PathBuf::from(home).join("Library/Application Support/OneX"))
}

fn init_logging(home: &std::path::Path) -> Result<tracing_appender::non_blocking::WorkerGuard> {
    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("onexd")
        .filename_suffix("log")
        .max_log_files(14)
        .build(home.join("logs"))?;
    let (writer, guard) = tracing_appender::non_blocking(appender);
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with_writer(writer)
        .with_ansi(false)
        .init();
    Ok(guard)
}

fn write_private(path: &std::path::Path, content: &str) -> Result<()> {
    let _ = std::fs::remove_file(path);
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;
    f.write_all(content.as_bytes())?;
    Ok(())
}
