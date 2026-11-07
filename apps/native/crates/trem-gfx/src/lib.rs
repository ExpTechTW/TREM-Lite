//! What a TREM app draws with and runs in: one GPU device for every window and offscreen
//! picture, text shaped with the app's own fonts, an immediate-mode UI on an instanced
//! batch, the vector map with the app's overlays on it, its windows, and the system
//! around them (single instance, tray, notifications, speech). The same code runs in a
//! browser (wasm32, WebGPU), where the system parts have a browser's version.
//!
//! Features: `dem` (the map's hillshade), `tray`, `autostart`, `notify`, `speech`,
//! `awake`, and `testing` for an app's tests.
//!
//! The app and this crate must agree on wgpu and winit, so the app takes them from here.

pub mod map;
pub mod platform;
pub mod render;
#[cfg(all(feature = "testing", not(target_arch = "wasm32")))]
pub mod testing;
pub mod ui;
pub mod window;

pub use wgpu;
pub use winit;
