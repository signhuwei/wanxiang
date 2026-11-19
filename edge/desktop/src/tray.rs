//! macOS 菜单栏入口。

use tauri::AppHandle;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;

const OPEN_ID: &str = "onex-open";

pub(super) fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, OPEN_ID, "打开 OneX Desktop", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = PredefinedMenuItem::quit(app, Some("退出 OneX Desktop"))?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;

    TrayIconBuilder::new()
        .icon(
            app.default_window_icon().cloned().ok_or(tauri::Error::InvalidIcon(std::io::Error::other(
                "no default window icon available for the tray",
            )))?,
        )
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            if event.id.as_ref() == OPEN_ID {
                super::show_main(app);
            }
        })
        .build(app)?;
    Ok(())
}
