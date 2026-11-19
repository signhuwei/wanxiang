//! OneX Desktop 原生桥：Tauri 2 应用的业务逻辑，独立于 `tauri::Builder` 便于测试。
pub mod bridge;
mod profile;
mod tray;

use std::path::PathBuf;

use serde_json::Value;
use tauri::{Manager, State, WebviewWindow, WebviewWindowBuilder};

use bridge::{Bridge, Op};

/// 唯一对外暴露的命令：封闭的 op 列表，拒绝未知字段（`Op` 用 `#[serde(tag = "op")]`，多余字段默认即拒）。
/// 返回类型固定 `Ok`：前端始终按 `{ok, state|error}` 这一种成功的 IPC 外形解析，区分「本次操作被拒绝
/// （ok:false）」和「IPC 本身失败（Tauri reject）」没有意义，也避免 reject 路径携带原始错误文本。
#[tauri::command]
async fn desktop_call(window: WebviewWindow, bridge: State<'_, Bridge>, request: Value) -> Result<Value, ()> {
    if window.label() != "main" || !window.url().is_ok_and(|url| local_page(&url)) {
        return Ok(reply_err("forbidden", "没有权限执行此操作"));
    }
    let op = match serde_json::from_value::<Op>(request) {
        Ok(op) => op,
        Err(_) => return Ok(reply_err("invalid", "请检查输入内容")),
    };
    Ok(match bridge.call(op).await {
        Ok(state) => serde_json::json!({"ok": true, "state": state}),
        Err(e) => reply_err(&e.code, &e.message),
    })
}

fn local_page(url: &tauri::Url) -> bool {
    url.scheme() == "tauri" && url.host_str() == Some("localhost")
}

fn reply_err(code: &str, message: &str) -> Value {
    serde_json::json!({"ok": false, "error": {"code": code, "message": message}})
}

fn socket_path() -> PathBuf {
    if let Some(h) = std::env::var_os("ONEX_HOME") {
        return PathBuf::from(h).join(onex_core::ipc::SOCKET_NAME);
    }
    let home = std::env::var_os("HOME").expect("HOME not set");
    PathBuf::from(home).join("Library/Application Support/OneX").join(onex_core::ipc::SOCKET_NAME)
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let bridge = Bridge::new(socket_path());
            app.manage(bridge);
            let config = &app.config().app.windows[0];
            WebviewWindowBuilder::from_config(app, config)?
                .on_navigation(local_page)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
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
