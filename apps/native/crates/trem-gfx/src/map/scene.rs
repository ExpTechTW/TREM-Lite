//! What an app draws over the basemap, layer by layer: dots, icons, strokes, the EEW
//! rings, the towns' colours. The app keeps them in a scene of its own, one field a
//! layer of its style, and says which of them changed.

use std::collections::HashMap;

use super::camera::{merc_x, merc_y};

/// All overlay geometry is stored relative to Taiwan, as f32 Mercator units. That
/// keeps better than a hundredth of a pixel at zoom 12, where absolute coordinates
/// in f32 would shake.
pub const ORIGIN: (f64, f64) = (0.836_111, 0.442_0);

pub fn rel(lon: f64, lat: f64) -> [f32; 2] {
    [
        (merc_x(lon) - ORIGIN.0) as f32,
        (merc_y(lat) - ORIGIN.1) as f32,
    ]
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct DotInstance {
    pub pos: [f32; 2],
    pub color: [u8; 4],
}

/// An icon on the map: `I` is the app's name for the sprite's icons.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Symbol<I> {
    pub lon: f64,
    pub lat: f64,
    pub icon: I,
    /// `symbol-sort-key`: higher draws later, and places later where icons collide.
    pub sort: f32,
    pub opacity: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct OverlayLineVertex {
    pub pos: [f32; 2],
    pub nx: i8,
    pub ny: i8,
    pub side: i8,
    pub _pad: i8,
    pub color: [u8; 4],
}

/// One stroked line of a line layer, as raw lon/lat points.
#[derive(Clone, Debug, PartialEq)]
pub struct Stroke {
    pub points: Vec<[f64; 2]>,
    pub color: [u8; 4],
}

/// An EEW's P and S rings. Its layers go on top of the rest in the order they were
/// added, and removing and adding them again puts them back on top.
#[derive(Clone, Debug)]
pub struct WaveLayer {
    pub id: String,
    pub s_color: [u8; 4],
    pub p: Vec<[f64; 2]>,
    pub s: Vec<[f64; 2]>,
    pub s_fill: bool,
}

/// `{ code → colour }`: `paintTowns`.
pub type TownColors = HashMap<u32, [u8; 4]>;

/// A polyline of lon/lat points, stroked in Mercator units relative to [`ORIGIN`].
pub fn stroke_overlay(
    points: &[[f64; 2]],
    color: [u8; 4],
    out: &mut Vec<OverlayLineVertex>,
    indices: &mut Vec<u32>,
) {
    if points.len() < 2 {
        return;
    }
    let pts: Vec<[f32; 2]> = points.iter().map(|p| rel(p[0], p[1])).collect();
    let closed = pts.first() == pts.last();
    let count = if closed { pts.len() - 1 } else { pts.len() };
    if count < 2 {
        return;
    }
    let at = |i: isize| pts[i.rem_euclid(count as isize) as usize];
    let normal = |a: [f32; 2], b: [f32; 2]| -> Option<(f32, f32)> {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len = dx.hypot(dy);
        if len < 1e-12 {
            return None;
        }
        Some((-dy / len, dx / len))
    };
    let base = out.len() as u32;
    let mut pushed = 0u32;
    let vertices = if closed { count } else { pts.len() };
    for i in 0..vertices {
        let i = i as isize;
        let prev = if closed || i > 0 {
            normal(at(i - 1), at(i))
        } else {
            None
        };
        let next = if closed || (i as usize) + 1 < pts.len() {
            normal(at(i), at(i + 1))
        } else {
            None
        };
        let n = match (prev, next) {
            (Some(p), Some(n)) => tessellate_join(p, n),
            (Some(p), None) => p,
            (None, Some(n)) => n,
            (None, None) => continue,
        };
        let nx = (n.0 * 64.0).round().clamp(-127.0, 127.0) as i8;
        let ny = (n.1 * 64.0).round().clamp(-127.0, 127.0) as i8;
        let pos = at(i);
        out.push(OverlayLineVertex {
            pos,
            nx,
            ny,
            side: 1,
            _pad: 0,
            color,
        });
        out.push(OverlayLineVertex {
            pos,
            nx: -nx,
            ny: -ny,
            side: -1,
            _pad: 0,
            color,
        });
        pushed += 1;
    }
    let quads = if closed {
        pushed
    } else {
        pushed.saturating_sub(1)
    };
    for q in 0..quads {
        let a = base + q * 2;
        let b = base + ((q + 1) % pushed) * 2;
        indices.extend_from_slice(&[a, a + 1, b, b, a + 1, b + 1]);
    }
}

/// The miter of two unit normals, capped: rings have gentle corners and boxes square
/// ones, so a bevel is never needed.
fn tessellate_join(a: (f32, f32), b: (f32, f32)) -> (f32, f32) {
    let sum = (a.0 + b.0, a.1 + b.1);
    let len = sum.0.hypot(sum.1);
    if len < 1e-3 {
        return b;
    }
    let unit = (sum.0 / len, sum.1 / len);
    let cos = unit.0 * b.0 + unit.1 * b.1;
    let miter = if cos > 0.5 { 1.0 / cos } else { 2.0 };
    (unit.0 * miter, unit.1 * miter)
}

/// A ring as a fan around its centre, for the S wave's fill. A wavefront is star-shaped
/// around its epicentre, on the map as on the sphere.
pub fn fan(center: [f32; 2], ring: &[[f64; 2]], out: &mut Vec<[f32; 2]>, indices: &mut Vec<u32>) {
    if ring.len() < 3 {
        return;
    }
    let base = out.len() as u32;
    out.push(center);
    let open = if ring.first() == ring.last() {
        &ring[..ring.len() - 1]
    } else {
        ring
    };
    for p in open {
        out.push(rel(p[0], p[1]));
    }
    let n = open.len() as u32;
    for i in 0..n {
        indices.extend_from_slice(&[base, base + 1 + i, base + 1 + (i + 1) % n]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_closed_ring_strokes_into_a_closed_strip() {
        let mut v = Vec::new();
        let mut i = Vec::new();
        let ring = [[121.0, 23.0], [122.0, 23.0], [122.0, 24.0], [121.0, 23.0]];
        stroke_overlay(&ring, [255; 4], &mut v, &mut i);
        assert_eq!(v.len(), 6);
        assert_eq!(i.len(), 18);
    }

    #[test]
    fn a_fan_closes_around_its_centre() {
        let mut v = Vec::new();
        let mut i = Vec::new();
        let ring = [[121.0, 23.0], [122.0, 23.0], [122.0, 24.0], [121.0, 23.0]];
        fan(rel(121.5, 23.3), &ring, &mut v, &mut i);
        assert_eq!(v.len(), 4);
        assert_eq!(i.len(), 9);
    }
}
