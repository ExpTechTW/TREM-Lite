//! Small pieces shared by the views: trem_gfx's text placement and easing clock, and this
//! app's CSS tokens, intensity badge and tooltip.

pub use trem_gfx::ui::widgets::*;

use super::{Color, QuadStyle, Rect, Ui};
use crate::domain::constants::{intensity_color, intensity_text, INTENSITY_LIST};
use crate::render::{TextStyle, METRICS};

pub const LIGHT: Color = Color::rgba_u8(0xf4, 0xf4, 0xf5, 0xff);
pub const PANEL_BG: Color = Color::rgba_u8(0x50, 0x50, 0x50, 0xc7);
pub const PANEL_BORDER: Color = Color::rgba_u8(0x51, 0x51, 0x51, 0xff);
pub const WARNING: Color = Color::rgba_u8(0xff, 0xca, 0x00, 0xff);

/// The height of a `line-height: normal` line with Han, in em.
pub const NORMAL_LINE_HAN: f32 = METRICS.normal_line;

/// 𝖬: the symbol fonts have no bold of it, and a browser synthesizes one. Returns its width.
pub fn magnitude_mark(ui: &mut Ui, x: f32, baseline_y: f32, color: Color, s: &TextStyle) -> f32 {
    ui.text("𝖬", x, baseline_y, color, s);
    ui.text("𝖬", x + 0.5, baseline_y, color, s);
    ui.measure("𝖬", s)
}

/// The baseline [`text_in`] would use.
pub fn line_baseline(top: f32, line: f32, size: f32) -> f32 {
    METRICS.baseline(top, line, size)
}

pub fn level_label(i: i32) -> &'static str {
    INTENSITY_LIST[i.clamp(0, 9) as usize]
}

/// components/IntensityBadge: a rounded box with the level, centred.
pub fn badge(ui: &mut Ui, rect: Rect, i: i32, radius: f32, size: f32, blank_at_zero: bool) {
    let level = i.clamp(0, 9) as u8;
    ui.quad(
        rect,
        &QuadStyle::solid(intensity_color(level)).radius(radius),
    );
    if blank_at_zero && level == 0 {
        return;
    }
    let s = centered(style(size, 700));
    // `leading-none`: the line box is the em, centred in the box.
    text_in(
        ui,
        level_label(i),
        rect.x + rect.w / 2.0,
        rect.y + (rect.h - size) / 2.0,
        size,
        intensity_text(level),
        &s,
    );
}

/// A tooltip beside the pointer, in place of a `title` attribute.
pub fn draw_tooltip(ui: &mut Ui) {
    let Some(text) = ui.tooltip().map(str::to_string) else {
        return;
    };
    let s = style(12.0, 500);
    let width = ui.measure(&text, &s) + 12.0;
    let (px, py) = ui.pointer();
    let x = (px + 10.0).min(ui.width() - width - 4.0).max(4.0);
    let mut y = py - 28.0;
    if y < 4.0 {
        y = py + 18.0;
    }
    ui.quad(
        Rect::new(x, y, width, 22.0),
        &QuadStyle::solid(Color::rgba_u8(0x26, 0x27, 0x2e, 0xf2))
            .radius(4.0)
            .border(1.0, Color::rgba_u8(255, 255, 255, 40)),
    );
    text_in(ui, &text, x + 6.0, y + 2.0, 18.0, LIGHT, &s);
}
