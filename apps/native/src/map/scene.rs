//! What the features draw on the map, by the layer it sits in. Each layer of
//! MapLibre's style has a field here, so a port of `setFeatures` is an assignment to
//! it. A write that changes nothing changes nothing: the renderer re-uploads a kind
//! of geometry only when its dirty flag is set.

pub use trem_gfx::map::scene::*;

use super::icons::IconId;

/// An icon of this app's sprite on the map.
pub type Symbol = trem_gfx::map::scene::Symbol<IconId>;

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
}
