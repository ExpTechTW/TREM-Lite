//! What a TREM app draws with: one GPU device for every window and offscreen picture,
//! text shaped with the app's own fonts, and the UI's instanced batch. The same code runs
//! in a browser (wasm32, WebGPU).
//!
//! The app and this crate must agree on wgpu and winit, so the app takes them from here.

pub mod render;

pub use wgpu;
pub use winit;
