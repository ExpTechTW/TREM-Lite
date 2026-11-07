//! What the features draw on the map, by the layer it sits in. Each layer of
//! MapLibre's style has a field here, so a port of `setFeatures` is an assignment to
//! it. A write that changes nothing changes nothing: the renderer re-uploads a kind
//! of geometry only when its dirty flag is set.

use std::collections::HashMap;

use super::camera::{merc_x, merc_y};
use super::icons::IconId;

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

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Symbol {
    pub lon: f64,
    pub lat: f64,
    pub icon: IconId,
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

#[derive(Default)]
pub struct Scene {
    /// `rts-layer`: coloured station dots.
    pub rts_dots: Vec<DotInstance>,
    /// `markers-0`: zero dots while an EEW is up.
    pub zero_dots: Vec<DotInstance>,
    /// The `circle-opacity` of `rts-layer`: 0.2 under an intensity or lpgm overlay.
    pub rts_opacity: f32,
    /// `markers`: alert icons.
    pub markers: Vec<Symbol>,
    /// `cross`, kept above the rest while it has anything to show.
    pub cross: Vec<Symbol>,
    /// `box-geojson`, in draw order.
    pub boxes: Vec<Stroke>,
    /// `eq-waves`: the listed earthquakes' wavefronts.
    pub eq_waves: Vec<Stroke>,
    /// `eq-epicentres`.
    pub eq_epicentres: Vec<DotInstance>,
    /// `intensity-markers`. Allow no overlap: icons that would collide are not shown.
    pub intensity_markers: Vec<Symbol>,
    /// `lpgm-markers`. Likewise.
    pub lpgm_markers: Vec<Symbol>,
    /// `report-markers` and `report-markers-cross`, which allow overlap.
    pub report_markers: Vec<Symbol>,
    pub report_cross: Vec<Symbol>,
    /// `${id}-p-wave-outline` and its S layers.
    pub waves: Vec<WaveLayer>,
    pub towns: TownColors,
    pub towns_painted: Option<String>,

    pub dots_dirty: bool,
    pub lines_dirty: bool,
    pub symbols_dirty: bool,
    pub towns_dirty: bool,
    /// Something drawn changed: the frame must be drawn again.
    pub dirty: bool,
}

impl Scene {
    pub fn new() -> Self {
        Self {
            rts_opacity: 1.0,
            dots_dirty: true,
            lines_dirty: true,
            symbols_dirty: true,
            towns_dirty: true,
            dirty: true,
            ..Self::default()
        }
    }

    /// Everything must reach a fresh GPU again: after [`super::MapEngine::trim`].
    pub fn mark_all_dirty(&mut self) {
        self.dots_dirty = true;
        self.lines_dirty = true;
        self.symbols_dirty = true;
        self.towns_dirty = true;
        self.dirty = true;
    }

    /// Colour towns by code — the EEW's predicted area, an intensity or a long-period
    /// report — or, with None, return them all to the base colour. Skips when nothing
    /// changed, as lib/mapSource.ts `paintTowns`.
    pub fn paint_towns(&mut self, colors: Option<TownColors>) {
        let colors = colors.unwrap_or_default();
        if colors == self.towns {
            return;
        }
        self.towns = colors;
        self.towns_dirty = true;
        self.dirty = true;
    }

    pub fn set_rts_opacity(&mut self, opacity: f32) {
        if (self.rts_opacity - opacity).abs() > f32::EPSILON {
            self.rts_opacity = opacity;
            self.dirty = true;
        }
    }

    fn touch_symbols(&mut self) {
        self.symbols_dirty = true;
        self.dirty = true;
    }

    fn touch_lines(&mut self) {
        self.lines_dirty = true;
        self.dirty = true;
    }

    fn touch_dots(&mut self) {
        self.dots_dirty = true;
        self.dirty = true;
    }

    pub fn set_station_dots(
        &mut self,
        rts: Vec<DotInstance>,
        zero: Vec<DotInstance>,
        markers: Vec<Symbol>,
    ) {
        if rts != self.rts_dots || zero != self.zero_dots {
            self.rts_dots = rts;
            self.zero_dots = zero;
            self.touch_dots();
        }
        if markers != self.markers {
            self.markers = markers;
            self.touch_symbols();
        }
    }

    pub fn set_cross(&mut self, cross: Vec<Symbol>) {
        if cross != self.cross {
            self.cross = cross;
            self.touch_symbols();
        }
    }

    pub fn set_boxes(&mut self, boxes: Vec<Stroke>) {
        if boxes != self.boxes {
            self.boxes = boxes;
            self.touch_lines();
        }
    }

    pub fn set_eq_waves(&mut self, rings: Vec<Stroke>, dots: Vec<DotInstance>) {
        if rings != self.eq_waves {
            self.eq_waves = rings;
            self.touch_lines();
        }
        if dots != self.eq_epicentres {
            self.eq_epicentres = dots;
            self.touch_dots();
        }
    }

    pub fn set_intensity_markers(&mut self, markers: Vec<Symbol>) {
        if markers != self.intensity_markers {
            self.intensity_markers = markers;
            self.touch_symbols();
        }
    }

    pub fn set_lpgm_markers(&mut self, markers: Vec<Symbol>) {
        if markers != self.lpgm_markers {
            self.lpgm_markers = markers;
            self.touch_symbols();
        }
    }

    pub fn set_report_markers(&mut self, markers: Vec<Symbol>, cross: Vec<Symbol>) {
        if markers != self.report_markers || cross != self.report_cross {
            self.report_markers = markers;
            self.report_cross = cross;
            self.touch_symbols();
        }
    }

    pub fn has_wave(&self, id: &str) -> bool {
        self.waves.iter().any(|w| w.id == id)
    }

    /// `createEewLayer`: add an EEW's layers if it has none yet.
    pub fn add_wave(&mut self, id: &str, s_color: [u8; 4]) {
        if self.has_wave(id) {
            return;
        }
        self.waves.push(WaveLayer {
            id: id.to_string(),
            s_color,
            p: Vec::new(),
            s: Vec::new(),
            s_fill: true,
        });
        self.touch_lines();
    }

    pub fn remove_wave(&mut self, id: &str) {
        let before = self.waves.len();
        self.waves.retain(|w| w.id != id);
        if self.waves.len() != before {
            self.touch_lines();
        }
    }

    /// `EewAlert` recolours by removing and adding again: they go back on top.
    pub fn recolour_wave(&mut self, id: &str, s_color: [u8; 4]) {
        if let Some(at) = self.waves.iter().position(|w| w.id == id) {
            let mut layer = self.waves.remove(at);
            layer.s_color = s_color;
            self.waves.push(layer);
            self.touch_lines();
        }
    }

    /// A wavefront tick. Always different, so there is nothing to compare.
    pub fn set_wave_rings(&mut self, id: &str, p: Vec<[f64; 2]>, s: Vec<[f64; 2]>, s_fill: bool) {
        if let Some(layer) = self.waves.iter_mut().find(|w| w.id == id) {
            layer.p = p;
            layer.s = s;
            layer.s_fill = s_fill;
            self.touch_lines();
        }
    }
}

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
    fn writing_the_same_thing_is_not_a_change() {
        let mut scene = Scene::new();
        scene.dirty = false;
        scene.symbols_dirty = false;
        scene.set_report_markers(Vec::new(), Vec::new());
        assert!(!scene.dirty);
        let marker = Symbol {
            lon: 121.0,
            lat: 23.0,
            icon: IconId::Cross,
            sort: 0.0,
            opacity: 1.0,
        };
        scene.set_report_markers(vec![marker], Vec::new());
        assert!(scene.dirty && scene.symbols_dirty);
    }

    #[test]
    fn painting_the_same_colours_again_skips_the_upload() {
        let mut scene = Scene::new();
        scene.towns_dirty = false;
        scene.paint_towns(None);
        assert!(!scene.towns_dirty);
        scene.paint_towns(Some(TownColors::from([(962, [1, 2, 3, 255])])));
        assert!(scene.towns_dirty);
        scene.towns_dirty = false;
        scene.paint_towns(Some(TownColors::from([(962, [1, 2, 3, 255])])));
        assert!(!scene.towns_dirty);
    }

    #[test]
    fn an_alert_puts_the_rings_back_on_top() {
        let mut scene = Scene::new();
        scene.add_wave("a", [1, 1, 1, 255]);
        scene.add_wave("b", [1, 1, 1, 255]);
        scene.recolour_wave("a", [9, 9, 9, 255]);
        assert_eq!(scene.waves[1].id, "a");
        assert_eq!(scene.waves[1].s_color, [9, 9, 9, 255]);
        scene.remove_wave("a");
        assert!(!scene.has_wave("a"));
    }

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
