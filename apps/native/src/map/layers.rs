//! The map's layers as this app draws them (features/map/map.ts's style): the basemap's
//! colours, what each overlay layer uploads, and the order everything goes in. The
//! pipelines and the draws themselves are trem_gfx's map pass.

use trem_gfx::map::camera::Camera;
use trem_gfx::map::tessellate::Span;
use trem_gfx::map::tiles::{TileId, VectorGpu};
use trem_gfx::map::Overlay;
use trem_gfx::render::map_pass::{
    lerp_zoom, rgb, with_alpha, Draw, DynBuffer, IconBatch, MapFrame, MapPass, Range, TileSlots,
};

use super::scene::{self, DotInstance, OverlayLineVertex, Scene};
use crate::render::Gpu;

const LAND: [f32; 4] = rgb(0x3f, 0x40, 0x45);
const TOWN_OUTLINE: [f32; 4] = rgb(0x6a, 0x6b, 0x72);
const COUNTY_OUTLINE: [f32; 4] = rgb(0xa9, 0xb4, 0xbc);
pub const BACKGROUND: wgpu::Color = wgpu::Color {
    r: 0x1f as f64 / 255.0,
    g: 0x20 as f64 / 255.0,
    b: 0x25 as f64 / 255.0,
    a: 1.0,
};

struct WaveRanges {
    fill: Option<(Range, [f32; 4])>,
    p: Range,
    s: Range,
}

#[derive(Default)]
struct SymbolRanges {
    markers: Range,
    cross: Range,
    intensity: Range,
    lpgm: Range,
    report: Range,
    report_cross: Range,
}

#[derive(Default)]
struct DotRanges {
    rts: Range,
    zero: Range,
    eq: Range,
}

/// A tile's line layer: its uniform slot, and the part of its mesh.
type LineLayer = (fn(&TileSlots) -> Option<u32>, fn(&VectorGpu) -> Span);

/// The overlays' GPU buffers, made with each map pass and dropped with it.
pub struct Layers {
    dots: DynBuffer,
    dot_ranges: DotRanges,
    lines_v: DynBuffer,
    lines_i: DynBuffer,
    box_range: Range,
    eq_range: Range,
    fills_v: DynBuffer,
    fills_i: DynBuffer,
    wave_ranges: Vec<WaveRanges>,
    symbols: DynBuffer,
    symbol_ranges: SymbolRanges,
    symbol_zoom: f64,
    icons: IconBatch,
}

impl Default for Layers {
    fn default() -> Self {
        Self {
            dots: DynBuffer::new("map-dots", wgpu::BufferUsages::VERTEX),
            dot_ranges: DotRanges::default(),
            lines_v: DynBuffer::new("map-lines-v", wgpu::BufferUsages::VERTEX),
            lines_i: DynBuffer::new("map-lines-i", wgpu::BufferUsages::INDEX),
            box_range: Range::default(),
            eq_range: Range::default(),
            fills_v: DynBuffer::new("map-fills-v", wgpu::BufferUsages::VERTEX),
            fills_i: DynBuffer::new("map-fills-i", wgpu::BufferUsages::INDEX),
            wave_ranges: Vec::new(),
            symbols: DynBuffer::new("map-symbols", wgpu::BufferUsages::VERTEX),
            symbol_ranges: SymbolRanges::default(),
            symbol_zoom: f64::NAN,
            icons: IconBatch::new(super::icons::LAYOUT),
        }
    }
}

impl Layers {
    fn upload_dots(&mut self, gpu: &Gpu, scene: &Scene) {
        let mut all: Vec<DotInstance> = Vec::with_capacity(
            scene.rts_dots.len() + scene.zero_dots.len() + scene.eq_epicentres.len(),
        );
        all.extend_from_slice(&scene.rts_dots);
        all.extend_from_slice(&scene.zero_dots);
        all.extend_from_slice(&scene.eq_epicentres);
        self.dot_ranges = DotRanges {
            rts: Range {
                start: 0,
                count: scene.rts_dots.len() as u32,
            },
            zero: Range {
                start: scene.rts_dots.len() as u32,
                count: scene.zero_dots.len() as u32,
            },
            eq: Range {
                start: (scene.rts_dots.len() + scene.zero_dots.len()) as u32,
                count: scene.eq_epicentres.len() as u32,
            },
        };
        self.dots.write(gpu, bytemuck::cast_slice(&all));
    }

    fn upload_lines(&mut self, gpu: &Gpu, scene: &Scene) {
        let mut v: Vec<OverlayLineVertex> = Vec::new();
        let mut i: Vec<u32> = Vec::new();
        let mut range = |strokes: &mut dyn FnMut(&mut Vec<OverlayLineVertex>, &mut Vec<u32>)| {
            let start = i.len() as u32;
            strokes(&mut v, &mut i);
            Range {
                start,
                count: i.len() as u32 - start,
            }
        };
        self.box_range = range(&mut |v, i| {
            for stroke in &scene.boxes {
                scene::stroke_overlay(&stroke.points, stroke.color, v, i);
            }
        });
        self.eq_range = range(&mut |v, i| {
            for stroke in &scene.eq_waves {
                scene::stroke_overlay(&stroke.points, stroke.color, v, i);
            }
        });
        let mut fill_v: Vec<[f32; 2]> = Vec::new();
        let mut fill_i: Vec<u32> = Vec::new();
        self.wave_ranges.clear();
        for wave in &scene.waves {
            let p = range(&mut |v, i| {
                scene::stroke_overlay(&wave.p, crate::domain::constants::EEW_P, v, i);
            });
            let s = range(&mut |v, i| {
                scene::stroke_overlay(&wave.s, wave.s_color, v, i);
            });
            let fill = if wave.s_fill && !wave.s.is_empty() {
                let center = ring_center(&wave.s);
                let start = fill_i.len() as u32;
                scene::fan(center, &wave.s, &mut fill_v, &mut fill_i);
                Some((
                    Range {
                        start,
                        count: fill_i.len() as u32 - start,
                    },
                    with_alpha(wave.s_color, 0.25),
                ))
            } else {
                None
            };
            self.wave_ranges.push(WaveRanges { fill, p, s });
        }
        self.lines_v.write(gpu, bytemuck::cast_slice(&v));
        self.lines_i.write(gpu, bytemuck::cast_slice(&i));
        self.fills_v.write(gpu, bytemuck::cast_slice(&fill_v));
        self.fills_i.write(gpu, bytemuck::cast_slice(&fill_i));
    }

    fn upload_symbols(&mut self, gpu: &Gpu, scene: &Scene, zoom: f64) {
        self.icons.clear();
        let markers = self.icons.push(&scene.markers);
        let cross = self.icons.push(&scene.cross);
        let square_size = lerp_zoom(zoom, 5.0, 0.3, 10.0, 0.7);
        let intensity = self
            .icons
            .push_placed(&scene.intensity_markers, zoom, square_size);
        let lpgm = self
            .icons
            .push_placed(&scene.lpgm_markers, zoom, square_size);
        let report = self.icons.push(&scene.report_markers);
        let report_cross = self.icons.push(&scene.report_cross);
        self.symbol_ranges = SymbolRanges {
            markers,
            cross,
            intensity,
            lpgm,
            report,
            report_cross,
        };
        self.symbol_zoom = zoom;
        self.icons.upload(gpu, &mut self.symbols);
    }
}

impl Overlay for Scene {
    type Buffers = Layers;

    fn sprite(gpu: &Gpu) -> Result<wgpu::Texture, String> {
        super::icons::build_sprite(gpu)
    }

    fn dirty(&self) -> bool {
        self.dirty
    }

    fn set_dirty(&mut self, dirty: bool) {
        self.dirty = dirty;
    }

    fn mark_all_dirty(&mut self) {
        Scene::mark_all_dirty(self);
    }

    /// Bring the GPU up to date with the scene. Only what changed is written.
    fn prepare(&mut self, layers: &mut Layers, pass: &mut MapPass, gpu: &Gpu, camera: &Camera) {
        if self.towns_dirty {
            pass.upload_towns(gpu, &self.towns);
            self.towns_dirty = false;
        }
        if self.dots_dirty {
            layers.upload_dots(gpu, self);
            self.dots_dirty = false;
        }
        if self.lines_dirty {
            layers.upload_lines(gpu, self);
            self.lines_dirty = false;
        }
        let collides = !self.intensity_markers.is_empty() || !self.lpgm_markers.is_empty();
        let zoom_moved =
            (layers.symbol_zoom - camera.zoom).abs() > 1e-3 || layers.symbol_zoom.is_nan();
        if self.symbols_dirty || (collides && zoom_moved) {
            layers.upload_symbols(gpu, self, camera.zoom);
            self.symbols_dirty = false;
        }
    }

    /// Record the whole map. `frame.dpr` turns logical pixels into physical.
    fn encode(
        &self,
        layers: &Layers,
        pass: &mut MapPass,
        gpu: &Gpu,
        view: &wgpu::TextureView,
        encoder: &mut wgpu::CommandEncoder,
        frame: &MapFrame<'_>,
    ) {
        let MapFrame {
            camera,
            tiles,
            vector_draw,
            dem_draw,
            ..
        } = *frame;
        pass.begin_frame(gpu, frame);

        // Record every draw's uniforms first, so one buffer write covers the frame.
        let mut tile_draws: Vec<TileSlots> = Vec::with_capacity(vector_draw.len());
        for &id in vector_draw {
            let Some(tile) = tiles.vector_tile(id) else {
                continue;
            };
            let (origin, scale) = frame.tile_place(id, tile.extent);
            let base = Draw {
                origin,
                scale,
                extent: tile.extent as f32,
                color: LAND,
                width: 0.0,
                opacity: 1.0,
                use_lookup: 0.0,
                icon_size: 0.0,
            };
            tile_draws.push(TileSlots {
                id,
                global: pass.slot(base),
                city: pass.slot(base),
                town: pass.slot(Draw {
                    use_lookup: 1.0,
                    ..base
                }),
                town_line: pass.slot(Draw {
                    color: TOWN_OUTLINE,
                    width: 0.4,
                    opacity: 0.7,
                    ..base
                }),
                city_line: pass.slot(Draw {
                    color: COUNTY_OUTLINE,
                    width: 1.0,
                    ..base
                }),
            });
        }
        let shade_draws: Vec<(TileId, Option<u32>)> = dem_draw
            .iter()
            .map(|&id| {
                let (origin, scale) = frame.tile_place(id, 1);
                let slot = pass.slot(Draw {
                    origin,
                    scale,
                    extent: 0.0,
                    color: [0.0; 4],
                    width: 0.0,
                    opacity: 1.0,
                    use_lookup: 0.0,
                    icon_size: 0.0,
                });
                (id, slot)
            })
            .collect();

        let zoom = camera.zoom;
        let radius = lerp_zoom(zoom, 4.0, 2.0, 12.0, 8.0);
        let badge = lerp_zoom(zoom, 5.0, 0.2, 10.0, 0.6);
        let square = lerp_zoom(zoom, 5.0, 0.3, 10.0, 0.7);
        let cross = lerp_zoom(zoom, 5.0, 0.02, 10.0, 0.1);
        let report_cross = lerp_zoom(zoom, 5.0, 0.01, 10.0, 0.09);
        let overlay =
            |color, width, opacity, icon_size| frame.overlay(color, width, opacity, icon_size);

        let fills: Vec<(Range, Option<u32>)> = layers
            .wave_ranges
            .iter()
            .filter_map(|w| w.fill)
            .collect::<Vec<_>>()
            .into_iter()
            .map(|(range, color)| (range, pass.slot(overlay(color, 0.0, 1.0, 0.0))))
            .collect();
        let rts_slot = pass.slot(overlay([0.0; 4], radius, self.rts_opacity, 0.0));
        let zero_slot = pass.slot(overlay([0.0; 4], radius, 1.0, 0.0));
        let markers_slot = pass.slot(overlay([0.0; 4], 0.0, 1.0, badge));
        let box_slot = pass.slot(overlay([0.0; 4], 2.0, 1.0, 0.0));
        let eq_slot = pass.slot(overlay([0.0; 4], 2.0, 0.6, 0.0));
        let eq_dot_slot = pass.slot(overlay([0.0; 4], 4.0, 0.6, 0.0));
        let square_slot = pass.slot(overlay([0.0; 4], 0.0, 1.0, square));
        let report_slot = pass.slot(overlay([0.0; 4], 0.0, 1.0, badge));
        let report_cross_slot = pass.slot(overlay([0.0; 4], 0.0, 1.0, report_cross));
        let p_slot = pass.slot(overlay([0.0; 4], 1.0, 1.0, 0.0));
        let s_slot = pass.slot(overlay([0.0; 4], 2.0, 1.0, 0.0));
        let cross_slot = pass.slot(overlay([0.0; 4], 0.0, 1.0, cross));
        pass.write_draws(gpu);

        let pass = &*pass;
        let mut rp = pass.begin_pass(encoder, view, BACKGROUND);

        pass.draw_tile_fills(&mut rp, tiles, &tile_draws, |d| d.global, |t| t.global);

        // The S wave's fill sits beneath the county fill: it shows over the sea.
        if !fills.is_empty() {
            pass.draw_fills(&mut rp, &layers.fills_v, &layers.fills_i, fills);
        }

        pass.draw_tile_fills(&mut rp, tiles, &tile_draws, |d| d.city, |t| t.city);
        pass.draw_tile_fills(&mut rp, tiles, &tile_draws, |d| d.town, |t| t.town);

        pass.draw_shade(&mut rp, tiles, shade_draws);

        let lines: [LineLayer; 2] = [
            (|d| d.town_line, |t| t.town_line),
            (|d| d.city_line, |t| t.city_line),
        ];
        for (pick, span) in lines {
            pass.draw_tile_lines(&mut rp, tiles, &tile_draws, pick, span);
        }

        // Station dots and alert icons.
        let dots = &layers.dot_ranges;
        pass.draw_dots(
            &mut rp,
            &layers.dots,
            [(dots.rts, rts_slot), (dots.zero, zero_slot)],
        );
        let symbols = &layers.symbol_ranges;
        pass.draw_icons(&mut rp, &layers.symbols, symbols.markers, markers_slot);

        // Boxes, listed earthquakes.
        pass.draw_lines(
            &mut rp,
            &layers.lines_v,
            &layers.lines_i,
            [(layers.box_range, box_slot), (layers.eq_range, eq_slot)],
        );
        pass.draw_dots(&mut rp, &layers.dots, [(dots.eq, eq_dot_slot)]);

        for (range, slot) in [
            (symbols.intensity, square_slot),
            (symbols.lpgm, square_slot),
            (symbols.report, report_slot),
            (symbols.report_cross, report_cross_slot),
        ] {
            pass.draw_icons(&mut rp, &layers.symbols, range, slot);
        }

        // The rings of each EEW, in the order they were added.
        pass.draw_lines(
            &mut rp,
            &layers.lines_v,
            &layers.lines_i,
            layers
                .wave_ranges
                .iter()
                .flat_map(|wave| [(wave.p, p_slot), (wave.s, s_slot)]),
        );

        pass.draw_icons(&mut rp, &layers.symbols, symbols.cross, cross_slot);
    }
}

/// The epicentre a ring grew from: the mean of its vertices is close enough for a fan.
fn ring_center(ring: &[[f64; 2]]) -> [f32; 2] {
    let n = ring.len().max(1) as f64;
    let (mut lon, mut lat) = (0.0, 0.0);
    for p in ring {
        lon += p[0];
        lat += p[1];
    }
    scene::rel(lon / n, lat / n)
}
