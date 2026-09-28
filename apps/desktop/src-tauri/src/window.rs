//! Window control — replaces `src/js/index/core/window.js` (which used
//! `@electron/remote` BrowserWindow flashFrame/setAlwaysOnTop/show/restore) and
//! the PiP show/hide IPC.

use tauri::{Manager, WebviewWindow};

fn window(app: &tauri::AppHandle, label: &str) -> Option<WebviewWindow> {
    app.get_webview_window(label)
}

/// Bring the main window to the foreground (unminimize + show + focus).
/// Shared by the `window_focus` command and the single-instance handler.
pub fn focus_main(app: &tauri::AppHandle) {
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
    if let Some(w) = window(&app, &label) {
        let _ = w.hide();
    }
}

#[tauri::command]
pub fn window_show(app: tauri::AppHandle, label: String) {
    log::info!("顯示並聚焦視窗 {label}");
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
