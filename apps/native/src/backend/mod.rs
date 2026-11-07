//! What the Tauri app's Rust side did, without Tauri: settings, logs, sound, the
//! intensity model. The window and network parts live in `platform` and `net`.

pub mod audio;
pub mod awake;
pub mod config;
pub mod logging;
pub mod math;
pub mod ml_intensity;
pub mod version;
