//! Window control — replaces `src/js/index/core/window.js` (which used
//! `@electron/remote` BrowserWindow flashFrame/setAlwaysOnTop/show/restore) and
//! the PiP show/hide IPC.

use tauri::{Manager, WebviewWindow};

fn window(app: &tauri::AppHandle, label: &str) -> Option<WebviewWindow> {
    app.get_webview_window(label)
}

/// macOS: the Dock icon follows the main window. It is there while the window
/// is open — on screen, behind other windows or minimised — and a click on it
/// brings the window to the front (lib.rs, `RunEvent::Reopen`). Closed to the
/// tray, the window has no Dock icon: the tray is the way back.
///
/// The activation policy rather than tao's `set_dock_visibility`: that one
/// ignores a hide within a second of a show, which left the icon behind when
/// the window was closed right after being brought back.
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub fn set_dock(app: &tauri::AppHandle, visible: bool) {
    #[cfg(target_os = "macos")]
    {
        let policy = if visible {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        };
        match app.set_activation_policy(policy) {
            Ok(()) => log::debug!("Dock 圖示{}", if visible { "顯示" } else { "隱藏" }),
            Err(e) => log::warn!("Dock 圖示切換失敗：{e}"),
        }
    }
}

/// Close the main window to the tray: hidden, and on macOS out of the Dock.
pub fn hide_main(app: &tauri::AppHandle) {
    if let Some(w) = window(app, "main") {
        let _ = w.hide();
    }
    set_dock(app, false);
}

/// Bring the main window to the foreground (unminimize + show + focus).
/// Shared by the `window_focus` command and the single-instance handler.
pub fn focus_main(app: &tauri::AppHandle) {
    set_dock(app, true);
    if let Some(w) = window(app, "main") {
        log::debug!(
            "主視窗還原、顯示並聚焦（原本{}，{}）",
            if w.is_visible().unwrap_or(false) { "顯示中" } else { "隱藏" },
            if w.is_minimized().unwrap_or(false) { "最小化" } else { "未最小化" }
        );
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
pub fn window_focus(app: tauri::AppHandle) {
    log::info!("前端要求叫出主視窗");
    focus_main(&app);
}

/// Whether a window is visible, and whether it is minimised, in one call: the
/// main window polls this every 500 ms (features/window/window.ts), which as
/// two JS API calls cost two round trips to the main thread each time.
#[tauri::command]
pub fn window_state(app: tauri::AppHandle, label: String) -> (bool, bool) {
    window(&app, &label).map_or((false, false), |w| {
        (
            w.is_visible().unwrap_or(false),
            w.is_minimized().unwrap_or(false),
        )
    })
}

/// Flash the taskbar / bounce the dock to grab attention.
#[tauri::command]
pub fn window_request_attention(app: tauri::AppHandle, critical: bool) {
    log::info!(
        "要求使用者注意（{}）：工作列閃爍／Dock 跳動",
        if critical { "緊急" } else { "一般" }
    );
    if let Some(w) = window(&app, "main") {
        let kind = Some(if critical {
            tauri::UserAttentionType::Critical
        } else {
            tauri::UserAttentionType::Informational
        });
        let _ = w.request_user_attention(kind);
    }
}

#[tauri::command]
pub fn window_hide(app: tauri::AppHandle, label: String) {
    log::info!("隱藏視窗 {label}");
    if label == "main" {
        return hide_main(&app);
    }
    if let Some(w) = window(&app, &label) {
        let _ = w.hide();
    }
}

#[tauri::command]
pub fn window_show(app: tauri::AppHandle, label: String) {
    log::info!("顯示並聚焦視窗 {label}");
    if label == "main" {
        set_dock(&app, true);
    }
    if let Some(w) = window(&app, &label) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Show the always-on-top picture-in-picture window.
#[tauri::command]
pub fn pip_show(app: tauri::AppHandle) {
    log::info!("顯示 PiP 小視窗");
    if let Some(w) = window(&app, "pip") {
        let _ = w.show();
    }
}

#[tauri::command]
pub fn pip_hide(app: tauri::AppHandle) {
    log::info!("隱藏 PiP 小視窗");
    if let Some(w) = window(&app, "pip") {
        let _ = w.hide();
    }
}
