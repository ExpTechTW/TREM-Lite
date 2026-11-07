//! System notifications. A failure costs only the notification.

/// macOS attributes a notification to an installed app: this one when it runs from its
/// bundle, Terminal otherwise, as Tauri's plugin does in development.
#[cfg(target_os = "macos")]
fn attribute_once() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let bundled = std::env::current_exe()
            .is_ok_and(|exe| exe.to_string_lossy().contains(".app/Contents/MacOS/"));
        let id = if bundled {
            "com.exptech.trem-lite.native"
        } else {
            "com.apple.Terminal"
        };
        if let Err(err) = notify_rust::set_application(id) {
            log::debug!(target: "notify", "通知的來源設定失敗：{err}");
        }
    });
}

pub fn send(title: &str, body: &str) {
    #[cfg(target_os = "macos")]
    attribute_once();
    let result = notify_rust::Notification::new()
        .summary(title)
        .body(body)
        .show();
    if let Err(err) = result {
        log::warn!(target: "notify", "系統通知送不出去（{title}）：{err}");
    }
}
