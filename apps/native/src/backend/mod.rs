//! What the Tauri app's Rust side did, without Tauri: settings, logs, sound, the
//! intensity model. The window and network parts live in `platform` and `net`.

#[cfg(not(target_arch = "wasm32"))]
pub mod audio;
#[cfg(target_arch = "wasm32")]
#[path = "audio_web.rs"]
pub mod audio;
#[cfg(not(target_arch = "wasm32"))]
pub mod awake;
pub mod config;
pub mod logging;
pub mod ml_intensity;
pub mod sound;
