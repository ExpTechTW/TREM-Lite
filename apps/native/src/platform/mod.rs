//! What differs per operating system: notifications, speech, the tray, and app lifecycle.
//! A browser has its own version of each, under `web/`.

#[cfg(not(target_arch = "wasm32"))]
pub mod lifecycle;
#[cfg(not(target_arch = "wasm32"))]
pub mod notify;
#[cfg(not(target_arch = "wasm32"))]
pub mod speech;
#[cfg(not(target_arch = "wasm32"))]
pub mod tray;

#[cfg(target_arch = "wasm32")]
#[path = "web/lifecycle.rs"]
pub mod lifecycle;
#[cfg(target_arch = "wasm32")]
#[path = "web/notify.rs"]
pub mod notify;
#[cfg(target_arch = "wasm32")]
#[path = "web/speech.rs"]
pub mod speech;
#[cfg(target_arch = "wasm32")]
#[path = "web/tray.rs"]
pub mod tray;
