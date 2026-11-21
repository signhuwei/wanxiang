//! onexd：OneX Edge 后台 daemon。
//!
//! 环境变量：
//! - `ONEX_HOME`：数据目录，默认 macOS `~/Library/Application Support/OneX`，
//!   Windows `%LOCALAPPDATA%\OneX`
//! - `ONEX_SERVER`：Server 的 WS 地址，例如 `wss://onex.example.com/v1/edge/ws`。Windows 发行版
//!   没设这个变量时回退到编译期写死的 `ONEX_WINDOWS_DEFAULT_SERVER`，见 `windows_server_default()`
//! - `ONEX_ROUTER_PORT`：本机 router 端口，默认 0（随机）
//! - `RUST_LOG`：日志级别，默认 `info`

// Windows 默认子系统是控制台（会弹出一个黑窗口），这是后台 daemon 不需要的；release 构建切成
// windows 子系统彻底不带控制台窗口。debug 构建保留控制台，开发时能直接看到 stdout/stderr，
// 和 desktop/src/main.rs 的同一处理方式一致。非 Windows 目标上这个属性不生效，没有影响。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Write;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use onex_core::ipc::SOCKET_NAME;
use onexd::credentials::{self, CredentialStore, KeychainStore};
use onexd::ipc::{self, Ipc};
use onexd::lease::{LeaseOptions, Ledger};
use onexd::outbox::{Kind, Outbox};
use onexd::router::{self, Router, UsageRecord};
use onexd::secret::DeviceKey;
use onexd::state::State;
use onexd::{id, ws};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let operation = args.next();
    if operation.as_deref() == Some(std::ffi::OsStr::new("workbuddy-hook")) {
        let policy = args.next().map(PathBuf::from).context("missing WorkBuddy hook policy")?;
        anyhow::ensure!(args.next().is_none(), "unexpected WorkBuddy hook arguments");
        if onexd::workbuddy_hook::notify(&policy).await.is_err() {
            eprintln!("OneX could not verify the native WorkBuddy turn");
            std::process::exit(2);
        }
        return Ok(());
    }
    if operation.as_deref() == Some(std::ffi::OsStr::new("codex-desktop-app-server")) {
        let code = match onexd::codex_desktop::app_server(args.collect()).await {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("OneX Codex Desktop bridge: {error}");
                1
            }
        };
        // Tokio's stdin reader may be waiting on the GUI after the signed child exits.
        std::process::exit(code);
    }
    let home = home_dir()?;
    create_private_dir(&home)?;
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

    // `ONEX_SERVER` 环境变量始终优先；没设置时，Windows 打包构建回退到编译期写死的默认地址
    // （由打包脚本通过 `ONEX_WINDOWS_DEFAULT_SERVER` 在构建时注入，等价于 mac LaunchAgent plist
    // 的 `EnvironmentVariables`：NSIS 的 HKCU Run 自启动项不像 launchd 那样能带每进程环境变量，
    // 需要在二进制里固化一份）。非 Windows 构建没有这个回退，行为和此前一致。
    let server = std::env::var("ONEX_SERVER").ok().or_else(windows_server_default);
    let server_url = server.as_deref().and_then(onex_core::ipc::http_base).as_deref().and_then(ipc::normalize_origin);
    let creds_store: Option<Arc<dyn CredentialStore>> = if cfg!(any(target_os = "macos", windows)) {
        Some(Arc::new(KeychainStore::new(credentials::service_name(&home))))
    } else {
        None
    };
    let restored = restore_identity(creds_store.as_deref(), server_url.as_deref());
    // Use the same device directory on first login and every restart of that identity.
    let (device_key, token, expected_device_id) = match restored {
        Some((key, token, id)) => (key, Some(token), Some(id)),
        None => (DeviceKey::generate(), None, None),
    };
    let data_dir = home.join("devices").join(credentials::fingerprint(&device_key.public_b64()));
    create_private_dir(&data_dir)?;
    let outbox = Arc::new(Outbox::open(&data_dir.join("outbox.sqlite"))?);
    let lease = Arc::new(Ledger::open(data_dir.join("lease.json"), LeaseOptions::default(), &outbox)?);
    let state = Arc::new(State {
        lease: lease.clone(),
        device_key,
        token: watch::Sender::new(token),
        expected_device_id: expected_device_id.into(),
        ..Default::default()
    });
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
    onexd::launch::clean_stale(&data_dir);
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

    // 下载受管制品走正常代理设置（CDN 在公网，不是本机 loopback 上游），但不跟跳转、限制总时长：
    // 服务端把我们重定向到哪我们就信哪，等于绕过了对发行记录 URL 的信任边界。
    let download_http = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let ipc = Arc::new(Ipc {
        state: state.clone(),
        outbox: outbox.clone(),
        router_addr: Some(router_addr.to_string()),
        server_url: server_url.clone(),
        launch: Some(ipc::LaunchCtx::new(data_dir, download_http)),
        credentials: creds_store,
        identity_transition: Default::default(),
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
        _ = interrupt_signal() => { info!("received interrupt signal"); shutdown.cancel(); }
        _ = terminate_signal() => { info!("received terminate signal"); shutdown.cancel(); }
    }
    if let Some(t) = ws_task {
        let _ = t.await;
    }
    let _ = ipc_task.await;
    router_task.await??;
    info!("onexd stopped");
    Ok(())
}

/// 从 Keychain 取回上次登录的设备身份。要求存的 Server 和这次启动配置的 `ONEX_SERVER` 规范化后一致
/// 才恢复；配置换了 Server（或这次没配 `ONEX_SERVER`）就当作没有可恢复的身份，不强行套用旧身份连错地方。
/// 读取失败（Keychain 本身出错，不是没有记录）只记日志，按未登录处理，不阻塞 daemon 启动。
fn restore_identity(
    store: Option<&dyn CredentialStore>,
    current_server: Option<&str>,
) -> Option<(DeviceKey, String, String)> {
    let store = store?;
    let creds = match store.load() {
        Ok(Some(c)) => c,
        Ok(None) => return None,
        Err(e) => {
            warn!(error = %format!("{e:#}"), "could not read device credentials from keychain; starting unauthenticated");
            return None;
        }
    };
    let Some(current) = current_server else {
        info!("ONEX_SERVER not set; not restoring persisted device identity");
        return None;
    };
    if creds.server != current {
        info!(stored = %creds.server, configured = %current, "ONEX_SERVER changed; not restoring persisted device identity");
        return None;
    }
    info!(device_id = %creds.device_id, "restored device identity from keychain");
    Some((DeviceKey::from_bytes(creds.device_key), creds.device_token, creds.device_id))
}

async fn interrupt_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        warn!(%error, "unable to register an interrupt signal listener");
        std::future::pending::<()>().await;
    }
}

/// Unix 的 SIGTERM；Windows 没有这个信号，等效的"外部要求退出"换成 Ctrl+C 之外的关闭事件
/// （控制台窗口关闭、系统关机广播），见 `terminate_signal`。
#[cfg(unix)]
async fn terminate_signal() {
    let mut s = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("sigterm handler");
    s.recv().await;
}

/// Windows：控制台窗口被关闭或系统正在关机，等效于 Unix 下的 SIGTERM——都是"外部要求尽快退出"，
/// 不是用户主动 Ctrl+C。两个事件都等，谁先来就走谁。
#[cfg(windows)]
async fn terminate_signal() {
    let (Ok(mut close), Ok(mut shutdown)) =
        (tokio::signal::windows::ctrl_close(), tokio::signal::windows::ctrl_shutdown())
    else {
        // An installed daemon may run without a console and still shuts down via IPC.
        std::future::pending::<()>().await;
        return;
    };
    tokio::select! {
        _ = close.recv() => {}
        _ = shutdown.recv() => {}
    }
}

fn home_dir() -> Result<PathBuf> {
    onex_core::ipc::default_home().map_err(anyhow::Error::msg)
}

/// 编译期写死的 Windows 默认 Server 地址：`deploy/windows` 的打包脚本构建发行用的 onexd 时设置
/// `ONEX_WINDOWS_DEFAULT_SERVER` 环境变量，`option_env!` 在编译期把它内联进二进制；本机手工调试
/// 构建（没设这个变量）时 `option_env!` 返回 `None`，和此前"没有 ONEX_SERVER 就不连接"的行为
/// 完全一致，不会给开发构建意外塞一个地址。非 Windows 目标上这个常量总是 `None`，调用方的
/// `.or_else(windows_server_default)` 相当于空操作。
fn windows_server_default() -> Option<String> {
    option_env!("ONEX_WINDOWS_DEFAULT_SERVER").map(str::to_string)
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

#[cfg(unix)]
fn write_private(path: &std::path::Path, content: &str) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let _ = std::fs::remove_file(path);
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;
    f.write_all(content.as_bytes())?;
    Ok(())
}

/// Windows 没有 Unix 权限位；文件天然继承所在目录的 ACL（`home` 目录由 `create_private_dir`
/// 创建时已经限定到当前用户），这里只保证"换新文件"，不额外设权限。
#[cfg(windows)]
fn write_private(path: &std::path::Path, content: &str) -> Result<()> {
    let _ = std::fs::remove_file(path);
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    f.write_all(content.as_bytes())?;
    Ok(())
}

/// 建一个只有当前用户能访问的私有目录。Unix 靠 0700 权限位；Windows 没有等价调用，
/// 这里只建目录本身，依赖用户数据根目录（`%LOCALAPPDATA%`）本来就是当前用户私有、
/// 子目录默认继承同一份 ACL，不额外开权限给其它账户。
#[cfg(unix)]
fn create_private_dir(dir: &std::path::Path) -> Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().mode(0o700).recursive(true).create(dir)?;
    Ok(())
}

#[cfg(windows)]
fn create_private_dir(dir: &std::path::Path) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    Ok(())
}
