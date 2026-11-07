//! Drawing: trem_gfx's GPU device, text and UI batch, with this app's fonts; the map's
//! pass is the app's own.

mod fonts;
pub mod map_pass;

pub use fonts::FONTS;
pub use trem_gfx::render::*;
