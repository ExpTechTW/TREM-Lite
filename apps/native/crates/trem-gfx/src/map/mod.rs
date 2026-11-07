//! The map: camera, tiles, what the app drew over them, and pointer input. Replaces
//! MapLibre GL JS for the styles TREM apps use: ExpTech's vector basemap, its terrain
//! as a hillshade, and the app's overlays ([`Overlay`]) in the app's order.

pub mod camera;
#[cfg(feature = "dem")]
pub mod dem;
pub mod icons;
pub mod mvt;
pub mod scene;
pub mod tessellate;
pub mod tiles;

use web_time::Instant;

use camera::{Bounds, Camera, Padding};
use tiles::{Fetch, TileConfig, TileId, TileManager};

use crate::render::map_pass::{MapFrame, MapPass};
use crate::render::Gpu;

/// Where a map's tiles come from, and where its camera starts.
#[derive(Clone, Copy, Debug)]
pub struct MapConfig {
    /// The vector tiles, `{z}`, `{x}` and `{y}` in place of the tile's.
    pub vector_url: &'static str,
    /// Terrain-RGB tiles, for the hillshade; none, no hillshade. Needs the `dem` feature.
    pub terrain_url: Option<&'static str>,
    /// The camera's first centre, lon and lat, and zoom.
    pub center: (f64, f64),
    pub zoom: f64,
}

impl MapConfig {
    pub fn tiles(&self) -> TileConfig {
        TileConfig {
            vector_url: self.vector_url,
            terrain_url: self.terrain_url,
        }
    }
}

/// What an app draws over the basemap, and the order everything goes in: its layers'
/// data, which it keeps, and their GPU buffers, which live as long as the pass.
pub trait Overlay {
    /// The overlay's GPU buffers: made empty with each pass, dropped with it.
    type Buffers: Default;
    /// The texture its icons sample, made with each pass on the thread that makes it.
    fn sprite(gpu: &Gpu) -> Result<wgpu::Texture, String>;
    /// Something drawn changed: the next frame must be drawn.
    fn dirty(&self) -> bool;
    fn set_dirty(&mut self, dirty: bool);
    /// Everything must reach a fresh GPU again: after [`MapEngine::trim`] or a new pass.
    fn mark_all_dirty(&mut self);
    /// Bring the GPU up to date for a frame about to be drawn: only what changed.
    fn prepare(
        &mut self,
        buffers: &mut Self::Buffers,
        pass: &mut MapPass,
        gpu: &Gpu,
        camera: &Camera,
    );
    /// Record the whole map: the basemap's layers and the overlay's, in the app's order.
    fn encode(
        &self,
        buffers: &Self::Buffers,
        pass: &mut MapPass,
        gpu: &Gpu,
        view: &wgpu::TextureView,
        encoder: &mut wgpu::CommandEncoder,
        frame: &MapFrame<'_>,
    );
}

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

pub struct MapEngine<S: Overlay> {
    pub camera: Camera,
    pub tiles: TileManager,
    pub scene: S,
    pass: Option<MapPass>,
    buffers: S::Buffers,
    vector_draw: Vec<TileId>,
    dem_draw: Vec<TileId>,
    clock: Instant,
    #[cfg(feature = "testing")]
    clock_override: Option<f64>,
    dragging: Option<(f64, f64)>,
    last_click: Option<(Instant, f64, f64)>,
    moved_since_down: bool,
    trimmed: bool,
}

impl<S: Overlay> MapEngine<S> {
    pub fn new(
        config: &MapConfig,
        scene: S,
        fetch: Fetch,
        wake: std::sync::Arc<dyn Fn() + Send + Sync>,
        size: (f64, f64),
    ) -> Self {
        Self {
            camera: Camera::new(
                config.center.0,
                config.center.1,
                config.zoom,
                size.0,
                size.1,
            ),
            tiles: TileManager::new(fetch, wake, config.tiles()),
            scene,
            pass: None,
            buffers: S::Buffers::default(),
            vector_draw: Vec::new(),
            dem_draw: Vec::new(),
            clock: Instant::now(),
            #[cfg(feature = "testing")]
            clock_override: None,
            dragging: None,
            last_click: None,
            moved_since_down: false,
            trimmed: false,
        }
    }

    /// A test's clock for flights, in ms.
    #[cfg(feature = "testing")]
    pub fn set_clock(&mut self, now_ms: f64) {
        self.clock_override = Some(now_ms);
        self.camera.tick(now_ms);
    }

    fn now_ms(&self) -> f64 {
        #[cfg(feature = "testing")]
        if let Some(ms) = self.clock_override {
            return ms;
        }
        self.clock.elapsed().as_secs_f64() * 1000.0
    }

    pub fn resize(&mut self, width: f64, height: f64) {
        if (self.camera.width - width).abs() > f64::EPSILON
            || (self.camera.height - height).abs() > f64::EPSILON
        {
            self.camera.resize(width, height);
            self.scene.set_dirty(true);
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
        self.scene.set_dirty(true);
    }

    pub fn needs_frame(&self) -> bool {
        self.scene.dirty() || self.camera.is_moving()
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
        self.buffers = S::Buffers::default();
        self.vector_draw.clear();
        self.dem_draw.clear();
        self.scene.mark_all_dirty();
        log::info!(target: "map", "視窗收起：釋放地圖的 GPU 資源");
    }

    /// Bring tiles and geometry up to date for a frame about to be drawn.
    /// Whether `prepare` would first have to make the pipelines for `format`.
    pub fn needs_pass(&self, format: wgpu::TextureFormat) -> bool {
        self.pass.as_ref().is_none_or(|p| p.format() != format)
    }

    /// The pipelines and the sprite for `format`, as `prepare` makes them: on any
    /// thread, ahead of the first frame.
    pub fn new_pass(gpu: &Gpu, format: wgpu::TextureFormat) -> Result<MapPass, String> {
        let sprite = S::sprite(gpu)?;
        MapPass::new(gpu, format, &sprite)
    }

    /// Pipelines made elsewhere, ahead of the first frame, as `prepare` would have made them.
    pub fn install_pass(&mut self, pass: MapPass) {
        self.pass = Some(pass);
        self.buffers = S::Buffers::default();
        self.scene.mark_all_dirty();
    }

    pub fn prepare(&mut self, gpu: &Gpu, format: wgpu::TextureFormat) -> Result<(), String> {
        self.trimmed = false;
        if self.needs_pass(format) {
            self.install_pass(Self::new_pass(gpu, format)?);
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
            self.scene
                .prepare(&mut self.buffers, pass, gpu, &self.camera);
        }
        self.scene.set_dirty(false);
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
            self.scene.encode(
                &self.buffers,
                pass,
                gpu,
                view,
                encoder,
                &MapFrame {
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
        self.scene.set_dirty(true);
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
        self.scene.set_dirty(true);
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
        self.scene.set_dirty(true);
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
        self.scene.set_dirty(true);
        vec![MapEvent::Wheel, MapEvent::UserMove]
    }

    /// A key's pan or zoom, about the middle of the map.
    pub fn key_move(&mut self, dx: f64, dy: f64, dz: f64) {
        if dz != 0.0 {
            self.camera
                .zoom_at(dz, self.camera.width / 2.0, self.camera.height / 2.0);
        } else {
            self.camera.pan_by(dx, dy);
        }
        self.scene.set_dirty(true);
    }

    pub fn pinch(&mut self, delta: f64, x: f64, y: f64) -> Vec<MapEvent> {
        self.camera.zoom_at((1.0 + delta).max(0.1).log2(), x, y);
        self.scene.set_dirty(true);
        vec![MapEvent::TouchStart, MapEvent::UserMove]
    }
}

const TILE_TIMEOUT_MS: u64 = 15_000;
const TILE_MAX_AGE_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// A tile's answer as the tile manager takes it: none for a tile the server does not have.
async fn fetch_tile(
    proxy: &trem_io::net::ProxyState,
    url: String,
) -> Result<Option<std::sync::Arc<Vec<u8>>>, String> {
    let request = trem_io::net::ProxyRequest::get(url, TILE_TIMEOUT_MS).max_age(TILE_MAX_AGE_MS);
    match proxy.send(request).await {
        Ok(fetched) if fetched.status == 404 || fetched.status == 204 => Ok(None),
        Ok(fetched) if fetched.ok() => Ok(Some(fetched.body)),
        Ok(fetched) => Err(format!("HTTP {}", fetched.status)),
        Err(err) => Err(err),
    }
}

/// In a browser: fetched by the page and decoded on its one thread.
#[cfg(target_arch = "wasm32")]
pub fn tile_fetch(proxy: std::sync::Arc<trem_io::net::ProxyState>) -> Fetch {
    std::sync::Arc::new(move |url, reply| {
        let proxy = std::sync::Arc::clone(&proxy);
        trem_io::exec::spawn(async move {
            reply(fetch_tile(&proxy, url).await);
        });
    })
}

/// The tiles' fetcher: the shared HTTP client and disk cache, on the runtime.
/// map.ts's transformRequest gives tiles 15 s and keeps them a week.
#[cfg(not(target_arch = "wasm32"))]
pub fn tile_fetch(
    handle: tokio::runtime::Handle,
    proxy: std::sync::Arc<trem_io::net::ProxyState>,
) -> Fetch {
    std::sync::Arc::new(move |url, reply| {
        let proxy = std::sync::Arc::clone(&proxy);
        handle.spawn(async move {
            let answer = fetch_tile(&proxy, url).await;
            // Decoding is CPU work: on the worker pool, off the async workers.
            rayon::spawn(move || reply(answer));
        });
    })
}
