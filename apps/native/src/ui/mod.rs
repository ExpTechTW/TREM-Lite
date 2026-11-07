//! The app's views, on trem_gfx's immediate-mode UI: the main window's overlays, PiP and
//! the settings window, and the icons and pieces they share.

pub mod icons;
pub mod main_view;
pub mod pip;
pub mod settings;
pub mod widgets;

pub use trem_gfx::ui::*;

/// The page's background, `#1f2025`.
pub const BACKGROUND: Color = Color {
    r: 31.0 / 255.0,
    g: 32.0 / 255.0,
    b: 37.0 / 255.0,
    a: 1.0,
};

pub fn clear_color() -> wgpu::Color {
    wgpu::Color {
        r: BACKGROUND.r as f64,
        g: BACKGROUND.g as f64,
        b: BACKGROUND.b as f64,
        a: 1.0,
    }
}
