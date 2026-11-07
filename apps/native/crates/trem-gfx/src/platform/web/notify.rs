//! The page's notifications, once the person has allowed them.

use web_sys::{Notification, NotificationOptions, NotificationPermission};

pub fn send(_bundle_id: &str, title: &str, body: &str) {
    match Notification::permission() {
        NotificationPermission::Granted => {
            let options = NotificationOptions::new();
            options.set_body(body);
            if let Err(err) = Notification::new_with_options(title, &options) {
                log::warn!(target: "notify", "通知送不出去（{title}）：{err:?}");
            }
        }
        NotificationPermission::Default => {
            // Asked once; this notification is lost either way.
            let _ = Notification::request_permission();
            log::info!(target: "notify", "瀏覽器尚未允許通知：已詢問，這則（{title}）不顯示");
        }
        _ => log::info!(target: "notify", "瀏覽器不允許通知：{title}"),
    }
}
