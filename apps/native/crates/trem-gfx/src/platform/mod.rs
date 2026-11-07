//! What differs per operating system: app lifecycle, and with their features the tray,
//! notifications, speech and staying at full speed in the background. A browser has its
//! own version of each, under `web/`, with the same names.

#[cfg(not(target_arch = "wasm32"))]
pub mod lifecycle;
#[cfg(all(feature = "notify", not(target_arch = "wasm32")))]
pub mod notify;
#[cfg(all(feature = "speech", not(target_arch = "wasm32")))]
pub mod speech;
#[cfg(all(feature = "tray", not(target_arch = "wasm32")))]
pub mod tray;

#[cfg(target_arch = "wasm32")]
#[path = "web/lifecycle.rs"]
pub mod lifecycle;
#[cfg(all(feature = "notify", target_arch = "wasm32"))]
#[path = "web/notify.rs"]
pub mod notify;
#[cfg(all(feature = "speech", target_arch = "wasm32"))]
#[path = "web/speech.rs"]
pub mod speech;
#[cfg(all(feature = "tray", target_arch = "wasm32"))]
#[path = "web/tray.rs"]
pub mod tray;

/// A browser tab has nothing to keep awake.
#[cfg(all(feature = "awake", not(target_arch = "wasm32")))]
pub mod awake;
