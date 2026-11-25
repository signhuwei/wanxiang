//! OneX Desktop 原生桥：Tauri 2 应用的业务逻辑，独立于 `tauri::Builder` 便于测试。
pub mod bridge;
mod profile;
mod tray;
mod update_platform;
mod updater;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tauri::{Manager, State, WebviewWindow, WebviewWindowBuilder};

use bridge::{Bridge, Op};

/// 唯一对外暴露的命令：封闭的 op 列表，拒绝未知字段（`Op` 用 `#[serde(tag = "op")]`，多余字段默认即拒）。
/// 返回类型固定 `Ok`：前端始终按 `{ok, state|error}` 这一种成功的 IPC 外形解析，区分「本次操作被拒绝
/// （ok:false）」和「IPC 本身失败（Tauri reject）」没有意义，也避免 reject 路径携带原始错误文本。
#[tauri::command]
async fn desktop_call(
    window: WebviewWindow,
    bridge: State<'_, Bridge>,
    updates: State<'_, Arc<updater::Updater>>,
    request: Value,
) -> Result<Value, ()> {
    if window.label() != "main" || !window.url().is_ok_and(|url| local_page(&url)) {
        return Ok(reply_err("forbidden", "没有权限执行此操作"));
    }
    let op = match serde_json::from_value::<Op>(request) {
        Ok(op) => op,
        Err(_) => return Ok(reply_err("invalid", "请检查输入内容")),
    };
    let (op, requested_update) =
        if let Op::InstallUpdate { version } = op { (Op::State, Some(version)) } else { (op, None) };
    Ok(match bridge.call(op).await {
        Ok(state) => {
            let origin = &state.settings.server_origin;
            let update = if let Some(version) = requested_update {
                let Some(update) = updates.install(&version, origin, window.app_handle().clone()) else {
                    return Ok(reply_err("update_unavailable", "更新已变更或暂不可用"));
                };
                Some(update)
            } else {
                updates.observe(origin)
            };
            let mut state = serde_json::json!(state);
            if let Some(update) = update {
                state["desktop_update"] = serde_json::json!(update);
            }
            serde_json::json!({"ok": true, "state": state})
        }
        Err(e) => reply_err(&e.code, &e.message),
    })
}

/// 本地主窗口的 origin 判定，这是 `desktop_call` 唯一的访问控制点，必须精确匹配到具体平台：
/// macOS（WKWebView）把本地内容放在自定义 scheme `tauri://localhost` 下；Windows（WebView2，
/// Chromium 内核不支持把任意自定义 scheme 当顶层文档 origin）用虚拟主机 `http://tauri.localhost`
/// 代替，这不是降级成明文 HTTP 的安全性——`tauri.localhost` 不是真实可路由的域名，WebView2 的
/// virtual host 机制保证它只能由本进程自己的资源协议处理器应答，不会被同机其它进程或真实网络
/// 上的 `tauri.localhost` 冒充。两个平台各自固定一种 scheme，不写成"scheme 是 tauri 或 http
/// 都算"这种宽松判断，避免某一平台意外接受了另一平台的 origin 形状。
#[cfg(target_os = "macos")]
fn local_page(url: &tauri::Url) -> bool {
    url.scheme() == "tauri" && url.host_str() == Some("localhost")
}

#[cfg(windows)]
fn local_page(url: &tauri::Url) -> bool {
    url.scheme() == "http" && url.host_str() == Some("tauri.localhost")
}

fn reply_err(code: &str, message: &str) -> Value {
    serde_json::json!({"ok": false, "error": {"code": code, "message": message}})
}

fn socket_path() -> PathBuf {
    let home = onex_core::ipc::default_home().expect("ONEX_HOME could not be determined");
    home.join(onex_core::ipc::SOCKET_NAME)
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Windows：macOS 靠独立的 LaunchAgent（`KeepAlive: true`）常驻 `onexd`，daemon 退出后 launchd
/// 几秒内自动拉起一个新的；Windows 的 HKCU Run 项只在登录时拉起一次 `OneX Desktop.exe`，没有等价
/// 的"进程退出就重启"机制，所以这个职责落到 Desktop 自己身上，两个时机都要调用：
/// 1. 冷启动（`run()` 的 `setup`），daemon 可能从来没启动过；
/// 2. `Logout` 之后（`bridge.rs::logout`），`onexd` 收到 `Logout` 请求会把自己整个关掉（和 macOS
///    行为一致，见 `onexd/src/ipc.rs::logout`），同一个 Desktop 进程要能马上再登录，不能让用户去
///    手动重启 Desktop 才能找回一个活的 daemon。
///
/// `onexd.exe` 是 Tauri externalBin sidecar，和 Desktop 的可执行文件装在同一个目录（见
/// `tauri.conf.json` 的 `bundle.externalBin`），按同目录解析路径，不接受外部配置的路径。
/// 用 DeviceInfo 确认 daemon 可以应答。注销后等待新设备密钥，旧 daemon 在退出前仍可能应答。
/// 如果新进程因旧管道尚未关闭而退出，在有界等待期间重试。
#[cfg(windows)]
pub(crate) async fn ensure_onexd_running(socket: &std::path::Path, retired_key: Option<&str>) {
    if onex_core::daemon::wait_for_device_info(socket, retired_key).await.is_none() {
        tracing::warn!("onexd sidecar did not become ready");
    }
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let sock = socket_path();
            #[cfg(windows)]
            tauri::async_runtime::block_on(ensure_onexd_running(&sock, None));
            let version = app.package_info().version.to_string();
            let initial_version = serde_json::to_string(&version)?;
            app.manage(updater::Updater::new(app.package_info().version.clone()));
            #[cfg(target_os = "macos")]
            tauri::async_runtime::spawn(updater::activate_daemon_update(sock.clone(), version.clone()));
            let bridge = Bridge::with_version(sock, version);
            app.manage(bridge);
            let config = &app.config().app.windows[0];
            WebviewWindowBuilder::from_config(app, config)?
                .on_navigation(local_page)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .initialization_script(format!("window.__ONEX_DESKTOP_VERSION__ = {initial_version};"))
                .build()?;
            if let Err(e) = tray::build(app.handle()) {
                tracing::warn!(error = %e, "failed to create the tray icon");
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let bridge = handle.state::<Bridge>();
                bridge.restore_session().await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![desktop_call])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && window.state::<Bridge>().hide_on_close()
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main(app);
            }
        });
}
