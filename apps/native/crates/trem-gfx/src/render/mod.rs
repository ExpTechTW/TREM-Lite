//! The GPU device and what draws with it: the UI's batch, shaped text and its glyph
//! atlas, the map's pipelines, offscreen pictures.

mod gpu;
pub mod map_pass;
// A browser cannot wait for a readback.
#[cfg(not(target_arch = "wasm32"))]
mod screenshot;
mod text;
mod ui_pass;

#[cfg(not(target_arch = "wasm32"))]
pub use gpu::OFFSCREEN_FORMAT;
pub use gpu::{device_lost, Gpu, GpuSurface};
#[cfg(not(target_arch = "wasm32"))]
pub use screenshot::{capture, render_rgba};
#[cfg(not(target_arch = "wasm32"))]
pub use text::prefetch_system_fonts;
pub use text::{
    append_glyph_quads, FontConfig, FontFamily, FontMetrics, GlyphDraw, GlyphQuad, HAlign,
    TextEngine, TextLayout, TextStyle, VAlign,
};
pub use ui_pass::{ClipPx, QuadDesc, UiPass};
