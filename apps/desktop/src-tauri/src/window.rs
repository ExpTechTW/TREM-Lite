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
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
pub fn window_focus(app: tauri::AppHandle) {
    focus_main(&app);
}

/// Flash the taskbar / bounce the dock to grab attention.
#[tauri::command]
pub fn window_request_attention(app: tauri::AppHandle, critical: bool) {
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
    if let Some(w) = window(&app, &label) {
        let _ = w.hide();
    }
}

#[tauri::command]
pub fn window_show(app: tauri::AppHandle, label: String) {
    if let Some(w) = window(&app, &label) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Show the always-on-top picture-in-picture window.
#[tauri::command]
pub fn pip_show(app: tauri::AppHandle) {
    if let Some(w) = window(&app, "pip") {
        let _ = w.show();
    }
}

#[tauri::command]
pub fn pip_hide(app: tauri::AppHandle) {
    if let Some(w) = window(&app, "pip") {
        let _ = w.hide();
    }
}
