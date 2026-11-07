//! The lucide icons this app uses, rasterized when first needed at the size they appear:
//! crisp at any scale, and only what is shown takes memory. Stroke width 2 on a 24 box,
//! round caps and joins, as lucide's SVGs are.

use std::collections::HashMap;

use super::{Color, ImageId, Rect, Ui};
use crate::render::Gpu;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Icon {
    Settings,
    Crosshair,
    ChevronLeft,
    ChevronRight,
    ChevronDown,
    X,
    Minus,
    Play,
    Copy,
    FolderOpen,
    ExternalLink,
    SlidersHorizontal,
    BellRing,
    Volume2,
    Info,
    WifiOff,
    TriangleAlert,
}

/// Each icon's shapes, as SVG path data.
fn paths(icon: Icon) -> &'static [&'static str] {
    match icon {
        Icon::Settings => &["M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915", "M9 12A3 3 0 1 1 15 12A3 3 0 1 1 9 12"],
        Icon::Crosshair => &["M2 12A10 10 0 1 1 22 12A10 10 0 1 1 2 12", "M22 12L18 12", "M6 12L2 12", "M12 6L12 2", "M12 22L12 18"],
        Icon::ChevronLeft => &["m15 18-6-6 6-6"],
        Icon::ChevronRight => &["m9 18 6-6-6-6"],
        Icon::ChevronDown => &["m6 9 6 6 6-6"],
        Icon::X => &["M18 6 6 18", "m6 6 12 12"],
        Icon::Minus => &["M5 12h14"],
        Icon::Play => &["M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"],
        Icon::Copy => &["M10 8H20A2 2 0 0 1 22 10V20A2 2 0 0 1 20 22H10A2 2 0 0 1 8 20V10A2 2 0 0 1 10 8Z", "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"],
        Icon::FolderOpen => &["m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"],
        Icon::ExternalLink => &["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
        Icon::SlidersHorizontal => &["M10 5H3", "M12 19H3", "M14 3v4", "M16 17v4", "M21 12h-9", "M21 19h-5", "M21 5h-7", "M8 10v4", "M8 12H3"],
        Icon::BellRing => &["M10.268 21a2 2 0 0 0 3.464 0", "M22 8c0-2.3-.8-4.3-2-6", "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326", "M4 2C2.8 3.7 2 5.7 2 8"],
        Icon::Volume2 => &["M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z", "M16 9a5 5 0 0 1 0 6", "M19.364 18.364a9 9 0 0 0 0-12.728"],
        Icon::Info => &["M2 12A10 10 0 1 1 22 12A10 10 0 1 1 2 12", "M12 16v-4", "M12 8h.01"],
        Icon::WifiOff => &["M12 20h.01", "M8.5 16.429a5 5 0 0 1 7 0", "M5 12.859a10 10 0 0 1 5.17-2.69", "M19 12.859a10 10 0 0 0-2.007-1.523", "M2 8.82a15 15 0 0 1 4.177-2.643", "M22 8.82a15 15 0 0 0-11.288-3.764", "m2 2 20 20"],
        Icon::TriangleAlert => &["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"],
    }
}

#[derive(Default)]
pub struct IconCache {
    images: HashMap<(Icon, u32), ImageId>,
}

impl IconCache {
    /// Draw an icon of `size` logical pixels at (x, y).
    pub fn draw(&mut self, ui: &mut Ui, gpu: &Gpu, icon: Icon, rect: Rect, color: Color) {
        let px = (rect.w.max(rect.h) * ui.scale()).ceil().clamp(1.0, 256.0) as u32;
        let id = match self.images.get(&(icon, px)) {
            Some(id) => *id,
            None => {
                let rgba = rasterize(icon, px);
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

fn rasterize(icon: Icon, px: u32) -> Vec<u8> {
    let scale = px as f32 / 24.0;
    let half = scale; // half the stroke width of 2
    let filled = icon == Icon::Play;
    let mut coverage = vec![0f32; (px * px) as usize];
    for d in paths(icon) {
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
        let rgba = rasterize(Icon::X, 24);
        assert!(rgba[(12 * 24 + 12) * 4 + 3] > 200);
        assert_eq!(rgba[3], 0);
    }

    #[test]
    fn play_is_filled() {
        let rgba = rasterize(Icon::Play, 24);
        assert!(rgba[(12 * 24 + 10) * 4 + 3] > 200);
    }
}
