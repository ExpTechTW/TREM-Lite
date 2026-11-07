//! Small pieces shared by the views: the CSS tokens, text placed as a browser places it,
//! the intensity badge, an easing clock.

use std::time::Instant;

use super::{Color, QuadStyle, Rect, Ui};
use crate::domain::constants::{intensity_color, intensity_text, INTENSITY_LIST};
use crate::render::{HAlign, TextStyle, VAlign};

pub const LIGHT: Color = Color::rgba_u8(0xf4, 0xf4, 0xf5, 0xff);
pub const PANEL_BG: Color = Color::rgba_u8(0x50, 0x50, 0x50, 0xc7);
pub const PANEL_BORDER: Color = Color::rgba_u8(0x51, 0x51, 0x51, 0xff);
pub const WARNING: Color = Color::rgba_u8(0xff, 0xca, 0x00, 0xff);

/// Manrope's ascent and descent per em. Han characters fall back to Noto but share
/// Manrope's baseline.
const ASCENT: f32 = 1.066;
const DESCENT: f32 = 0.3;
/// The ascent of `line-height: normal` on a line with Han, in em.
const NORMAL_ASCENT_HAN: f32 = 1.16;
/// And the height of such a line.
pub const NORMAL_LINE_HAN: f32 = 1.46;

pub fn style(size: f32, weight: u16) -> TextStyle {
    TextStyle {
        size,
        weight,
        v_align: VAlign::Baseline,
        tabular: true,
        ..TextStyle::default()
    }
}

pub fn centered(mut s: TextStyle) -> TextStyle {
    s.h_align = HAlign::Center;
    s
}

pub fn right(mut s: TextStyle) -> TextStyle {
    s.h_align = HAlign::Right;
    s
}

/// Where a line box puts its baseline: Blink rounds the font's ascent and descent, and
/// shares what is left of the line above and below them.
fn baseline(top: f32, line: f32, size: f32) -> f32 {
    let ascent = (ASCENT * size).round();
    let descent = (DESCENT * size).round();
    top + (line - ascent - descent) / 2.0 + ascent
}

/// Text in a line box starting at `top`, `line` high.
pub fn text_in(ui: &mut Ui, text: &str, x: f32, top: f32, line: f32, color: Color, s: &TextStyle) {
    ui.text(text, x, baseline(top, line, s.size), color, s);
}

/// 𝖬: the symbol fonts have no bold of it, and a browser synthesizes one. Returns its width.
pub fn magnitude_mark(ui: &mut Ui, x: f32, baseline_y: f32, color: Color, s: &TextStyle) -> f32 {
    ui.text("𝖬", x, baseline_y, color, s);
    ui.text("𝖬", x + 0.5, baseline_y, color, s);
    ui.measure("𝖬", s)
}

/// The baseline [`text_in`] would use.
pub fn line_baseline(top: f32, line: f32, size: f32) -> f32 {
    baseline(top, line, size)
}

/// Like [`text_in`], cut to `max` with an ellipsis.
#[allow(clippy::too_many_arguments)]
pub fn text_cut(
    ui: &mut Ui,
    text: &str,
    x: f32,
    top: f32,
    line: f32,
    max: f32,
    color: Color,
    s: &TextStyle,
) {
    ui.text_truncated(text, x, baseline(top, line, s.size), max, color, s);
}

/// Text with `line-height: normal`, on a line with Han. Returns the line's height.
pub fn text_normal(ui: &mut Ui, text: &str, x: f32, top: f32, color: Color, s: &TextStyle) -> f32 {
    ui.text(text, x, top + NORMAL_ASCENT_HAN * s.size, color, s);
    NORMAL_LINE_HAN * s.size
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

/// CSS `cubic-bezier`, for x in 0..1.
pub fn cubic_bezier(x1: f32, y1: f32, x2: f32, y2: f32, x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    let curve = |a: f32, b: f32, t: f32| {
        let u = 1.0 - t;
        3.0 * u * u * t * a + 3.0 * u * t * t * b + t * t * t
    };
    let (mut lo, mut hi) = (0.0_f32, 1.0_f32);
    for _ in 0..20 {
        let mid = (lo + hi) / 2.0;
        if curve(x1, x2, mid) < x {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    curve(y1, y2, (lo + hi) / 2.0)
}

/// A value easing between two ends, for a transition.
#[derive(Clone, Copy, Debug)]
pub struct Transition {
    from: f32,
    to: f32,
    started: Option<Instant>,
    seconds: f32,
    curve: (f32, f32, f32, f32),
}

impl Transition {
    pub fn new(value: f32, seconds: f32, curve: (f32, f32, f32, f32)) -> Self {
        Self {
            from: value,
            to: value,
            started: None,
            seconds,
            curve,
        }
    }

    pub fn set(&mut self, to: f32) {
        if (self.to - to).abs() < f32::EPSILON {
            return;
        }
        self.from = self.value();
        self.to = to;
        self.started = Some(Instant::now());
    }

    pub fn value(&self) -> f32 {
        let Some(started) = self.started else {
            return self.to;
        };
        let t = started.elapsed().as_secs_f32() / self.seconds;
        if t >= 1.0 {
            return self.to;
        }
        let (a, b, c, d) = self.curve;
        self.from + (self.to - self.from) * cubic_bezier(a, b, c, d, t)
    }

    pub fn running(&self) -> bool {
        self.started
            .is_some_and(|s| s.elapsed().as_secs_f32() < self.seconds)
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_curve_hits_its_ends_and_rises() {
        let ease = |x| cubic_bezier(0.25, 0.1, 0.25, 1.0, x);
        assert!(ease(0.0).abs() < 1e-3);
        assert!((ease(1.0) - 1.0).abs() < 1e-3);
        assert!(ease(0.5) > 0.5);
    }
}
