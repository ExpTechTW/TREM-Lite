//! Small pieces views share: text placed as a browser places it, an easing clock.

use web_time::Instant;

use super::{Color, Ui};
use crate::render::{HAlign, TextStyle, VAlign};

/// Text on its baseline, with tabular figures.
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

/// Text in a line box starting at `top`, `line` high.
pub fn text_in(ui: &mut Ui, text: &str, x: f32, top: f32, line: f32, color: Color, s: &TextStyle) {
    let baseline = ui.metrics().baseline(top, line, s.size);
    ui.text(text, x, baseline, color, s);
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
    let baseline = ui.metrics().baseline(top, line, s.size);
    ui.text_truncated(text, x, baseline, max, color, s);
}

/// Text with `line-height: normal`, on a line with fallback glyphs (Han). Returns the
/// line's height.
pub fn text_normal(ui: &mut Ui, text: &str, x: f32, top: f32, color: Color, s: &TextStyle) -> f32 {
    let metrics = *ui.metrics();
    ui.text(text, x, top + metrics.normal_ascent * s.size, color, s);
    metrics.normal_line * s.size
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
