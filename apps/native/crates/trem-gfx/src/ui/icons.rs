//! Line icons drawn as lucide's are, rasterized when first needed at the size they
//! appear: crisp at any scale, and only what is shown takes memory. Stroke width 2 on a
//! 24 box, round caps and joins, as lucide's SVGs are. Which icons there are, and their
//! shapes, is the app's.

use std::collections::HashMap;
use std::hash::Hash;

use super::{Color, ImageId, Rect, Ui};
use crate::render::Gpu;

/// An icon: its shapes, as SVG path data on lucide's 24 box.
pub trait IconShape: Copy + Eq + Hash {
    fn paths(self) -> &'static [&'static str];
    /// Filled as well as stroked.
    fn filled(self) -> bool {
        false
    }
}

/// The icons drawn so far, by icon and size in pixels.
pub struct IconCache<K> {
    images: HashMap<(K, u32), ImageId>,
}

impl<K> Default for IconCache<K> {
    fn default() -> Self {
        Self {
            images: HashMap::new(),
        }
    }
}

impl<K: IconShape> IconCache<K> {
    /// Draw an icon of `size` logical pixels at (x, y).
    pub fn draw(&mut self, ui: &mut Ui, gpu: &Gpu, icon: K, rect: Rect, color: Color) {
        let px = (rect.w.max(rect.h) * ui.scale()).ceil().clamp(1.0, 256.0) as u32;
        let id = match self.images.get(&(icon, px)) {
            Some(id) => *id,
            None => {
                let rgba = rasterize(icon.paths(), icon.filled(), px);
                let Some(id) = ui.upload_image(gpu, &rgba, px, px) else {
                    return;
                };
                self.images.insert((icon, px), id);
                id
            }
        };
        ui.image(id, rect, color);
    }
}

/// White, with the shapes' coverage as alpha, `px` square.
pub fn rasterize(paths: &[&str], filled: bool, px: u32) -> Vec<u8> {
    let scale = px as f32 / 24.0;
    let half = scale; // half the stroke width of 2
    let mut coverage = vec![0f32; (px * px) as usize];
    for d in paths {
        for line in flatten(d) {
            let points: Vec<(f32, f32)> =
                line.iter().map(|(x, y)| (x * scale, y * scale)).collect();
            stroke(&points, half, px, &mut coverage);
            if filled {
                fill(&points, px, &mut coverage);
            }
        }
    }
    let mut rgba = Vec::with_capacity((px * px * 4) as usize);
    for a in coverage {
        let v = (a.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        // White with coverage as alpha: the tint gives the colour.
        rgba.extend_from_slice(&[255, 255, 255, v]);
    }
    rgba
}

fn stroke(points: &[(f32, f32)], half: f32, px: u32, out: &mut [f32]) {
    for pair in points.windows(2) {
        let ((ax, ay), (bx, by)) = (pair[0], pair[1]);
        let pad = half + 1.0;
        let x0 = (ax.min(bx) - pad).floor().max(0.0) as u32;
        let x1 = ((ax.max(bx) + pad).ceil() as u32).min(px);
        let y0 = (ay.min(by) - pad).floor().max(0.0) as u32;
        let y1 = ((ay.max(by) + pad).ceil() as u32).min(px);
        let (dx, dy) = (bx - ax, by - ay);
        let len2 = (dx * dx + dy * dy).max(1e-6);
        for y in y0..y1 {
            for x in x0..x1 {
                let (cx, cy) = (x as f32 + 0.5, y as f32 + 0.5);
                let t = (((cx - ax) * dx + (cy - ay) * dy) / len2).clamp(0.0, 1.0);
                let d = (cx - ax - t * dx).hypot(cy - ay - t * dy);
                let a = (half + 0.5 - d).clamp(0.0, 1.0);
                let slot = &mut out[(y * px + x) as usize];
                if a > *slot {
                    *slot = a;
                }
            }
        }
    }
}

/// Even-odd, sampled four times a pixel along y.
fn fill(points: &[(f32, f32)], px: u32, out: &mut [f32]) {
    for y in 0..px {
        for x in 0..px {
            let mut inside = 0;
            for (sx, sy) in [(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)] {
                let (cx, cy) = (x as f32 + sx, y as f32 + sy);
                let mut hit = false;
                let mut j = points.len().wrapping_sub(1);
                for i in 0..points.len() {
                    let (xi, yi) = points[i];
                    let (xj, yj) = points[j];
                    if (yi > cy) != (yj > cy) && cx < (xj - xi) * (cy - yi) / (yj - yi) + xi {
                        hit = !hit;
                    }
                    j = i;
                }
                if hit {
                    inside += 1;
                }
            }
            let a = inside as f32 / 4.0;
            let slot = &mut out[(y * px + x) as usize];
            if a > *slot {
                *slot = a;
            }
        }
    }
}

/// SVG path data as polylines: M L H V C A Z, absolute and relative.
fn flatten(d: &str) -> Vec<Vec<(f32, f32)>> {
    let tokens = tokenize(d);
    let mut lines = Vec::new();
    let mut line: Vec<(f32, f32)> = Vec::new();
    let (mut x, mut y) = (0.0_f32, 0.0_f32);
    let (mut sx, mut sy) = (0.0, 0.0);
    let mut i = 0;
    let mut cmd = ' ';
    while i < tokens.len() {
        if let Token::Cmd(c) = tokens[i] {
            cmd = c;
            i += 1;
        }
        let rel = cmd.is_ascii_lowercase();
        let num = |i: &mut usize| -> f32 {
            let v = match tokens.get(*i) {
                Some(Token::Num(v)) => *v,
                _ => 0.0,
            };
            *i += 1;
            v
        };
        match cmd.to_ascii_uppercase() {
            'M' => {
                let (nx, ny) = (num(&mut i), num(&mut i));
                x = if rel { x + nx } else { nx };
                y = if rel { y + ny } else { ny };
                if line.len() > 1 {
                    lines.push(std::mem::take(&mut line));
                } else {
                    line.clear();
                }
                line.push((x, y));
                (sx, sy) = (x, y);
                // Further pairs are lines.
                cmd = if rel { 'l' } else { 'L' };
            }
            'L' => {
                let (nx, ny) = (num(&mut i), num(&mut i));
                x = if rel { x + nx } else { nx };
                y = if rel { y + ny } else { ny };
                line.push((x, y));
            }
            'H' => {
                let nx = num(&mut i);
                x = if rel { x + nx } else { nx };
                line.push((x, y));
            }
            'V' => {
                let ny = num(&mut i);
                y = if rel { y + ny } else { ny };
                line.push((x, y));
            }
            'C' => {
                let v: Vec<f32> = (0..6).map(|_| num(&mut i)).collect();
                let (bx, by) = if rel { (x, y) } else { (0.0, 0.0) };
                let p = [
                    (x, y),
                    (v[0] + bx, v[1] + by),
                    (v[2] + bx, v[3] + by),
                    (v[4] + bx, v[5] + by),
                ];
                for n in 1..=16 {
                    let t = n as f32 / 16.0;
                    let u = 1.0 - t;
                    let (a, b, c, e) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
                    line.push((
                        a * p[0].0 + b * p[1].0 + c * p[2].0 + e * p[3].0,
                        a * p[0].1 + b * p[1].1 + c * p[2].1 + e * p[3].1,
                    ));
                }
                (x, y) = p[3];
            }
            'A' => {
                let v: Vec<f32> = (0..7).map(|_| num(&mut i)).collect();
                let (ex, ey) = if rel {
                    (x + v[5], y + v[6])
                } else {
                    (v[5], v[6])
                };
                arc(x, y, v[0], v[3] != 0.0, v[4] != 0.0, ex, ey, &mut line);
                (x, y) = (ex, ey);
            }
            'Z' => {
                line.push((sx, sy));
                (x, y) = (sx, sy);
            }
            _ => i += 1,
        }
    }
    if line.len() == 1 {
        // A dot: `M12 8h.01` and the like draw a round cap.
        let p = line[0];
        line.push(p);
    }
    if line.len() > 1 {
        lines.push(line);
    }
    lines
}

/// A circular arc, by SVG's endpoint parameterization. Lucide's arcs are all circular.
#[allow(clippy::too_many_arguments)]
fn arc(
    x0: f32,
    y0: f32,
    r: f32,
    large: bool,
    sweep: bool,
    x1: f32,
    y1: f32,
    out: &mut Vec<(f32, f32)>,
) {
    let (dx, dy) = ((x0 - x1) / 2.0, (y0 - y1) / 2.0);
    let d2 = dx * dx + dy * dy;
    if d2 < 1e-9 || r <= 0.0 {
        out.push((x1, y1));
        return;
    }
    let r = r.max(d2.sqrt());
    let factor = ((r * r - d2) / d2).max(0.0).sqrt() * if large == sweep { -1.0 } else { 1.0 };
    let (cxp, cyp) = (factor * dy, -factor * dx);
    let (cx, cy) = (cxp + (x0 + x1) / 2.0, cyp + (y0 + y1) / 2.0);
    let a0 = (y0 - cy).atan2(x0 - cx);
    let mut delta = (y1 - cy).atan2(x1 - cx) - a0;
    let tau = std::f32::consts::TAU;
    if sweep && delta < 0.0 {
        delta += tau;
    } else if !sweep && delta > 0.0 {
        delta -= tau;
    }
    let steps = ((delta.abs() * r * 4.0).ceil() as usize).clamp(4, 64);
    for n in 1..=steps {
        let a = a0 + delta * n as f32 / steps as f32;
        out.push((cx + r * a.cos(), cy + r * a.sin()));
    }
}

enum Token {
    Cmd(char),
    Num(f32),
}

fn tokenize(d: &str) -> Vec<Token> {
    let bytes = d.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b.is_ascii_alphabetic() {
            out.push(Token::Cmd(b as char));
            i += 1;
        } else if b == b'-' || b == b'.' || b.is_ascii_digit() {
            let start = i;
            i += 1;
            let mut dot = b == b'.';
            while i < bytes.len() {
                let c = bytes[i];
                if c.is_ascii_digit() {
                    i += 1;
                } else if c == b'.' && !dot {
                    dot = true;
                    i += 1;
                } else {
                    break;
                }
            }
            if let Ok(v) = d[start..i].parse() {
                out.push(Token::Num(v));
            }
        } else {
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_parse_with_their_compact_flags_and_numbers() {
        let lines = flatten("m15 18-6-6 6-6");
        assert_eq!(lines[0], vec![(15.0, 18.0), (9.0, 12.0), (15.0, 6.0)]);
        let dot = flatten("M12 8h.01");
        assert_eq!(dot[0].len(), 2);
    }

    #[test]
    fn a_circle_stays_on_its_radius() {
        let lines = flatten("M2 12A10 10 0 1 1 22 12A10 10 0 1 1 2 12");
        for (x, y) in &lines[0] {
            assert!(((x - 12.0).hypot(y - 12.0) - 10.0).abs() < 0.01);
        }
    }

    #[test]
    fn a_cross_covers_its_centre_not_its_corner() {
        // lucide's `x`.
        let rgba = rasterize(&["M18 6 6 18", "m6 6 12 12"], false, 24);
        assert!(rgba[(12 * 24 + 12) * 4 + 3] > 200);
        assert_eq!(rgba[3], 0);
    }

    #[test]
    fn play_is_filled() {
        // lucide's `play`.
        let play =
            "M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z";
        let rgba = rasterize(&[play], true, 24);
        assert!(rgba[(12 * 24 + 10) * 4 + 3] > 200);
    }
}
