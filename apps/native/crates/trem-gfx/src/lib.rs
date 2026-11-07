//! What a TREM app draws with: one GPU device for every window and offscreen picture,
//! text shaped with the app's own fonts, an immediate-mode UI on an instanced batch, and
//! the vector map with the app's overlays on it. The same code runs in a browser (wasm32,
//! WebGPU).
//!
//! The app and this crate must agree on wgpu and winit, so the app takes them from here.

pub mod map;
pub mod render;
pub mod ui;

pub use wgpu;
pub use winit;
