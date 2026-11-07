//! System notifications. A failure costs only the notification.

/// This build's bundle, which macOS shows the notifications as from.
const BUNDLE_ID: &str = "com.exptech.trem-lite.native";

pub fn send(title: &str, body: &str) {
    trem_gfx::platform::notify::send(BUNDLE_ID, title, body);
}
