//! System notifications. A failure costs only the notification.

pub fn send(title: &str, body: &str) {
    let result = notify_rust::Notification::new()
        .summary(title)
        .body(body)
        .show();
    if let Err(err) = result {
        log::warn!(target: "notify", "系統通知送不出去（{title}）：{err}");
    }
}
