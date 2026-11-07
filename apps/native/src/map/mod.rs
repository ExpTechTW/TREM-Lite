//! The map: camera, tiles, what the features drew, and pointer input. Replaces
//! MapLibre GL JS for the one style this app uses (features/map/map.ts).

pub mod camera;
pub mod dem;
pub mod icons;
pub mod mvt;
pub mod scene;
pub mod tessellate;
pub mod tiles;

use std::time::Instant;

use camera::{Bounds, Camera, Padding};
use scene::Scene;
use tiles::{Fetch, TileId, TileManager};

use crate::render::map_pass::{MapFrame, MapPass};
use crate::render::Gpu;

const BASEMAP_TILE_URL: &str = "https://static.lb.exptech.dev/api/v1/map/tiles/{z}/{x}/{y}.pbf";
const TERRAIN_TILE_URL: &str = "https://static.lb.exptech.dev/api/v1/map/terrain/{z}/{x}/{y}.png";

/// map.ts `center`/`zoom`.
pub const INITIAL_CENTER: (f64, f64) = (121.6, 23.5);
pub const INITIAL_ZOOM: f64 = 6.8;
/// A second click this soon, this near, is a double click.
const DOUBLE_CLICK_MS: u128 = 400;
const DOUBLE_CLICK_PX: f64 = 8.0;
const DOUBLE_CLICK_ZOOM_MS: f64 = 300.0;

/// What reaches focus.ts: MapLibre's mousedown, mouseup, wheel, touchstart, and a
/// `movestart` that carries an originating event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MapEvent {
    MouseDown,
    MouseUp,
    Wheel,
    TouchStart,
    UserMove,
}

pub struct MapEngine {
    pub camera: Camera,
    pub tiles: TileManager,
    pub scene: Scene,
    pass: Option<MapPass>,
    vector_draw: Vec<TileId>,
    dem_draw: Vec<TileId>,
    clock: Instant,
    dragging: Option<(f64, f64)>,
    last_click: Option<(Instant, f64, f64)>,
    moved_since_down: bool,
    trimmed: bool,
}

impl MapEngine {
    pub fn new(
        fetch: Fetch,
        wake: std::sync::Arc<dyn Fn() + Send + Sync>,
        size: (f64, f64),
    ) -> Self {
        Self {
            camera: Camera::new(
                INITIAL_CENTER.0,
                INITIAL_CENTER.1,
                INITIAL_ZOOM,
                size.0,
                size.1,
            ),
            tiles: TileManager::new(fetch, wake, BASEMAP_TILE_URL, TERRAIN_TILE_URL),
            scene: Scene::new(),
            pass: None,
            vector_draw: Vec::new(),
            dem_draw: Vec::new(),
            clock: Instant::now(),
            dragging: None,
            last_click: None,
            moved_since_down: false,
            trimmed: false,
        }
    }

    fn now_ms(&self) -> f64 {
        self.clock.elapsed().as_secs_f64() * 1000.0
    }

    pub fn resize(&mut self, width: f64, height: f64) {
        if (self.camera.width - width).abs() > f64::EPSILON
            || (self.camera.height - height).abs() > f64::EPSILON
        {
            self.camera.resize(width, height);
            self.scene.dirty = true;
        }
    }

    /// Whether the camera is on its way somewhere or a drag holds it: MapLibre's `isMoving`.
    pub fn is_moving(&self) -> bool {
        self.camera.is_moving() || self.dragging.is_some()
    }

    /// `cameraForBounds` + `fitBounds`, skipping a fit to where the camera already is:
    /// MapLibre animates even a move of zero length, which kept the map redrawing (see
    /// focus.ts). The tolerances are far below a pixel.
    pub fn fit_bounds(
        &mut self,
        bounds: Bounds,
        padding: Padding,
        max_zoom: f64,
        duration_ms: f64,
    ) {
        let Some(target) = self.camera.for_bounds(bounds, padding, max_zoom) else {
            return;
        };
        if !self.is_moving() {
            let (lon, lat) = self.camera.center();
            if (self.camera.zoom - target.zoom).abs() < 1e-6
                && (lon - target.lon).abs() < 1e-9
                && (lat - target.lat).abs() < 1e-9
            {
                return;
            }
        }
        let now = self.now_ms();
        self.camera.fly(target, duration_ms, now);
        self.scene.dirty = true;
    }

    pub fn needs_frame(&self) -> bool {
        self.scene.dirty || self.camera.is_moving()
    }

    pub fn wants_animation(&self) -> bool {
        self.camera.is_moving()
    }

    /// Give back every GPU resource while nothing can be seen.
    pub fn trim(&mut self) {
        if self.trimmed {
            return;
        }
        self.trimmed = true;
        self.tiles.trim();
        self.pass = None;
        self.vector_draw.clear();
        self.dem_draw.clear();
        self.scene.mark_all_dirty();
        log::info!(target: "map", "視窗收起：釋放地圖的 GPU 資源");
    }

    /// Bring tiles and geometry up to date for a frame about to be drawn.
    pub fn prepare(&mut self, gpu: &Gpu, format: wgpu::TextureFormat) -> Result<(), String> {
        self.trimmed = false;
        if self.pass.as_ref().is_none_or(|p| p.format() != format) {
            self.pass = Some(MapPass::new(gpu, format)?);
            self.scene.mark_all_dirty();
        }
        let now = self.now_ms();
        self.camera.tick(now);
        if let Some(pass) = &self.pass {
            self.tiles.poll(gpu, &pass.shade_layout, now);
        }
        let (vector, dem) = self.tiles.update(&self.camera, now);
        self.vector_draw = vector;
        self.dem_draw = dem;
        if let Some(pass) = &mut self.pass {
            pass.prepare(gpu, &mut self.scene, &self.camera);
        }
        self.scene.dirty = false;
        Ok(())
    }

    pub fn encode(
        &mut self,
        gpu: &Gpu,
        view: &wgpu::TextureView,
        encoder: &mut wgpu::CommandEncoder,
        dpr: f64,
    ) {
        if let Some(pass) = &mut self.pass {
            pass.encode(
                gpu,
                view,
                encoder,
                &MapFrame {
                    scene: &self.scene,
                    camera: &self.camera,
                    tiles: &self.tiles,
                    vector_draw: &self.vector_draw,
                    dem_draw: &self.dem_draw,
                    dpr,
                },
            );
        }
    }

    /// A tile arrived: draw again. Called when the worker's wake reaches the main loop.
    pub fn tile_arrived(&mut self) {
        self.scene.dirty = true;
    }

    /// All wanted tiles have answered, for the screenshot mode.
    pub fn settled(&self) -> bool {
        self.tiles.settled(&self.camera)
    }

    // ---- Input ------------------------------------------------------------

    pub fn pointer_down(&mut self, x: f64, y: f64) -> Vec<MapEvent> {
        self.dragging = Some((x, y));
        self.moved_since_down = false;
        self.camera.stop();
        vec![MapEvent::MouseDown]
    }

    /// True when the map moved.
    pub fn pointer_move(&mut self, x: f64, y: f64) -> Option<MapEvent> {
        let (px, py) = self.dragging?;
        if (x - px).abs() < f64::EPSILON && (y - py).abs() < f64::EPSILON {
            return None;
        }
        self.camera.pan_by(x - px, y - py);
        self.dragging = Some((x, y));
        self.scene.dirty = true;
        let first = !self.moved_since_down;
        self.moved_since_down = true;
        first.then_some(MapEvent::UserMove)
    }

    pub fn pointer_up(&mut self, x: f64, y: f64) -> Vec<MapEvent> {
        if self.dragging.take().is_none() {
            return Vec::new();
        }
        if !self.moved_since_down {
            let now = Instant::now();
            let double = self.last_click.is_some_and(|(at, px, py)| {
                now.duration_since(at).as_millis() < DOUBLE_CLICK_MS
                    && (x - px).abs() < DOUBLE_CLICK_PX
                    && (y - py).abs() < DOUBLE_CLICK_PX
            });
            if double {
                self.last_click = None;
                self.zoom_animated(1.0, x, y);
            } else {
                self.last_click = Some((now, x, y));
            }
        }
        vec![MapEvent::MouseUp]
    }

    fn zoom_animated(&mut self, delta: f64, x: f64, y: f64) {
        let mut probe = self.camera.clone();
        probe.zoom_at(delta, x, y);
        let (lon, lat) = probe.center();
        let now = self.now_ms();
        self.camera.fly(
            camera::Target {
                lon,
                lat,
                zoom: probe.zoom,
            },
            DOUBLE_CLICK_ZOOM_MS,
            now,
        );
        self.scene.dirty = true;
    }

    /// MapLibre's scroll zoom: a smooth scale from the wheel delta. `pixels` is true
    /// for a trackpad, whose deltas are small and frequent.
    pub fn wheel(&mut self, delta: f64, pixels: bool, x: f64, y: f64) -> Vec<MapEvent> {
        const TRACKPAD_RATE: f64 = 1.0 / 100.0;
        const WHEEL_RATE: f64 = 1.0 / 450.0;
        let rate = if pixels { TRACKPAD_RATE } else { WHEEL_RATE };
        let mut scale = 2.0 / (1.0 + (-(delta * rate).abs()).exp());
        if delta > 0.0 && scale != 0.0 {
            scale = 1.0 / scale;
        }
        self.camera.zoom_at(scale.log2(), x, y);
        self.scene.dirty = true;
        vec![MapEvent::Wheel, MapEvent::UserMove]
    }

    pub fn pinch(&mut self, delta: f64, x: f64, y: f64) -> Vec<MapEvent> {
        self.camera.zoom_at((1.0 + delta).max(0.1).log2(), x, y);
        self.scene.dirty = true;
        vec![MapEvent::TouchStart, MapEvent::UserMove]
    }
}

/// The tiles' fetcher: the shared HTTP client and disk cache, on the runtime.
/// map.ts's transformRequest gives tiles 15 s and keeps them a week.
pub fn tile_fetch(
    handle: tokio::runtime::Handle,
    proxy: std::sync::Arc<crate::net::ProxyState>,
) -> Fetch {
    const TILE_TIMEOUT_MS: u64 = 15_000;
    const TILE_MAX_AGE_MS: u64 = 7 * 24 * 60 * 60 * 1000;
    std::sync::Arc::new(move |url, reply| {
        let proxy = std::sync::Arc::clone(&proxy);
        handle.spawn(async move {
            let request =
                crate::net::ProxyRequest::get(url, TILE_TIMEOUT_MS).max_age(TILE_MAX_AGE_MS);
            let answer = match proxy.send(request).await {
                Ok(fetched) if fetched.status == 404 || fetched.status == 204 => Ok(None),
                Ok(fetched) if fetched.ok() => Ok(Some(fetched.body)),
                Ok(fetched) => Err(format!("HTTP {}", fetched.status)),
                Err(err) => Err(err),
            };
            // Decoding is CPU work: off the async workers.
            let _ = tokio::task::spawn_blocking(move || reply(answer)).await;
        });
    })
}

/// Which icon a station's level shows: `intensity-N`.
pub fn intensity_icon(level: i32) -> icons::IconId {
    icons::IconId::Intensity(level.clamp(0, 9) as u8)
}
