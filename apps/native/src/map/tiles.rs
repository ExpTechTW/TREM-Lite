//! Which tiles the camera needs, fetching and cutting them off the main thread,
//! and holding them on the GPU within a budget.
//!
//! Tile choice follows MapLibre: vector z = floor(zoom), DEM z = round(zoom), both
//! 512 px and overscaled past their maxzoom. While a tile loads, a loaded parent or
//! its children stand in, so a pan or zoom leaves no hole.

use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;

use wgpu::util::DeviceExt;

use super::camera::Camera;
use super::dem;
use super::tessellate::{self, Span, TileMesh};
use crate::render::Gpu;

const BASEMAP_MAX_ZOOM: u8 = 9;
const TERRAIN_MAX_ZOOM: u8 = 11;
/// Deliberately wider than Taiwan so the edge of the DEM never appears as a hard
/// line while the user pans around.
const TERRAIN_BOUNDS: [f64; 4] = [110.0, 10.0, 132.0, 35.0];
const VECTOR_BUDGET: u64 = 64 * 1024 * 1024;
const DEM_BUDGET: u64 = 48 * 1024 * 1024;
/// A tile that failed is asked for again after this long, if it is still wanted.
const RETRY_MS: f64 = 10_000.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TileId {
    pub z: u8,
    pub x: u32,
    pub y: u32,
}

impl TileId {
    pub fn parent(self) -> Option<Self> {
        (self.z > 0).then(|| Self {
            z: self.z - 1,
            x: self.x / 2,
            y: self.y / 2,
        })
    }

    pub fn children(self) -> [Self; 4] {
        let (z, x, y) = (self.z + 1, self.x * 2, self.y * 2);
        [
            Self { z, x, y },
            Self { z, x: x + 1, y },
            Self { z, x, y: y + 1 },
            Self {
                z,
                x: x + 1,
                y: y + 1,
            },
        ]
    }
}

/// The tiles at `z` the camera can see.
pub fn covering(camera: &Camera, z: u8) -> Vec<TileId> {
    let n = 1u32 << z;
    let (left, top) = camera.screen_to_merc(0.0, 0.0);
    let (right, bottom) = camera.screen_to_merc(camera.width, camera.height);
    let span = f64::from(n);
    let x0 = (left * span).floor() as i64;
    let x1 = (right * span).floor() as i64;
    let y0 = ((top * span).floor() as i64).max(0);
    let y1 = ((bottom * span).floor() as i64).min(i64::from(n) - 1);
    let mut out = Vec::new();
    for y in y0..=y1 {
        for x in x0..=x1 {
            out.push(TileId {
                z,
                x: x.rem_euclid(i64::from(n)) as u32,
                y: y as u32,
            });
        }
    }
    out
}

pub fn vector_zoom(zoom: f64) -> u8 {
    (zoom.floor().max(0.0) as u8).min(BASEMAP_MAX_ZOOM)
}

pub fn dem_zoom(zoom: f64) -> u8 {
    (zoom.round().max(0.0) as u8).min(TERRAIN_MAX_ZOOM)
}

fn dem_in_bounds(id: TileId) -> bool {
    let n = f64::from(1u32 << id.z);
    let west = f64::from(id.x) / n * 360.0 - 180.0;
    let east = f64::from(id.x + 1) / n * 360.0 - 180.0;
    let north = super::camera::lat_of(f64::from(id.y) / n);
    let south = super::camera::lat_of(f64::from(id.y + 1) / n);
    east > TERRAIN_BOUNDS[0]
        && west < TERRAIN_BOUNDS[2]
        && north > TERRAIN_BOUNDS[1]
        && south < TERRAIN_BOUNDS[3]
}

/// Called with a URL; answers with the body, None for an empty tile, Err on failure.
pub type Reply = Box<dyn FnOnce(Result<Option<Arc<Vec<u8>>>, String>) + Send>;
pub type Fetch = Arc<dyn Fn(String, Reply) + Send + Sync>;

/// A tile's geometry, on the GPU.
pub struct VectorGpu {
    pub fill_vb: Option<wgpu::Buffer>,
    pub fill_ib: Option<wgpu::Buffer>,
    pub line_vb: Option<wgpu::Buffer>,
    pub line_ib: Option<wgpu::Buffer>,
    pub global: Span,
    pub city: Span,
    pub town: Span,
    pub town_line: Span,
    pub city_line: Span,
    pub extent: u32,
    pub bytes: u64,
}

/// A tile's baked hillshade, on the GPU.
pub struct DemGpu {
    pub bind: wgpu::BindGroup,
    pub bytes: u64,
}

enum Slot<T> {
    Loading,
    Empty,
    Failed(f64),
    Ready(T, u64),
}

enum Loaded {
    Vector(TileId, Result<Option<TileMesh>, String>),
    Dem(TileId, Result<Option<dem::Baked>, String>),
}

pub struct TileManager {
    fetch: Fetch,
    wake: Arc<dyn Fn() + Send + Sync>,
    tx: Sender<Loaded>,
    rx: Receiver<Loaded>,
    vector: HashMap<TileId, Slot<VectorGpu>>,
    dem: HashMap<TileId, Slot<DemGpu>>,
    vector_bytes: u64,
    dem_bytes: u64,
    tick: u64,
    vector_url: String,
    terrain_url: String,
}

fn tile_url(template: &str, id: TileId) -> String {
    template
        .replace("{z}", &id.z.to_string())
        .replace("{x}", &id.x.to_string())
        .replace("{y}", &id.y.to_string())
}

fn upload_vector(gpu: &Gpu, mesh: &TileMesh) -> VectorGpu {
    let buffer = |label: &str, bytes: &[u8], usage: wgpu::BufferUsages| -> Option<wgpu::Buffer> {
        (!bytes.is_empty()).then(|| {
            gpu.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some(label),
                    contents: bytes,
                    usage,
                })
        })
    };
    VectorGpu {
        fill_vb: buffer(
            "tile-fill-v",
            bytemuck::cast_slice(&mesh.fill_vertices),
            wgpu::BufferUsages::VERTEX,
        ),
        fill_ib: buffer(
            "tile-fill-i",
            bytemuck::cast_slice(&mesh.fill_indices),
            wgpu::BufferUsages::INDEX,
        ),
        line_vb: buffer(
            "tile-line-v",
            bytemuck::cast_slice(&mesh.line_vertices),
            wgpu::BufferUsages::VERTEX,
        ),
        line_ib: buffer(
            "tile-line-i",
            bytemuck::cast_slice(&mesh.line_indices),
            wgpu::BufferUsages::INDEX,
        ),
        global: mesh.global,
        city: mesh.city,
        town: mesh.town,
        town_line: mesh.town_line,
        city_line: mesh.city_line,
        extent: mesh.extent,
        bytes: mesh.gpu_bytes(),
    }
}

impl TileManager {
    pub fn new(
        fetch: Fetch,
        wake: Arc<dyn Fn() + Send + Sync>,
        vector_url: &str,
        terrain_url: &str,
    ) -> Self {
        let (tx, rx) = channel();
        Self {
            fetch,
            wake,
            tx,
            rx,
            vector: HashMap::new(),
            dem: HashMap::new(),
            vector_bytes: 0,
            dem_bytes: 0,
            tick: 0,
            vector_url: vector_url.to_string(),
            terrain_url: terrain_url.to_string(),
        }
    }

    pub fn gpu_bytes(&self) -> (u64, u64) {
        (self.vector_bytes, self.dem_bytes)
    }

    fn request_vector(&mut self, id: TileId) {
        self.vector.insert(id, Slot::Loading);
        let tx = self.tx.clone();
        let wake = self.wake.clone();
        (self.fetch)(
            tile_url(&self.vector_url, id),
            Box::new(move |result| {
                let loaded = result.map(|body| body.and_then(|b| tessellate::tessellate(&b)));
                let _ = tx.send(Loaded::Vector(id, loaded));
                wake();
            }),
        );
    }

    fn request_dem(&mut self, id: TileId) {
        self.dem.insert(id, Slot::Loading);
        let tx = self.tx.clone();
        let wake = self.wake.clone();
        (self.fetch)(
            tile_url(&self.terrain_url, id),
            Box::new(move |result| {
                let loaded = result.map(|body| {
                    body.and_then(|b| {
                        let image =
                            image::load_from_memory_with_format(&b, image::ImageFormat::Png)
                                .ok()?
                                .into_rgb8();
                        dem::bake(image.as_raw(), image.width(), u32::from(id.z), id.y)
                    })
                });
                let _ = tx.send(Loaded::Dem(id, loaded));
                wake();
            }),
        );
    }

    /// Take what the workers finished onto the GPU. True when anything arrived.
    pub fn poll(&mut self, gpu: &Gpu, shade_layout: &wgpu::BindGroupLayout, now_ms: f64) -> bool {
        let mut any = false;
        while let Ok(loaded) = self.rx.try_recv() {
            any = true;
            match loaded {
                Loaded::Vector(id, Ok(Some(mesh))) => {
                    let tile = upload_vector(gpu, &mesh);
                    self.vector_bytes += tile.bytes;
                    self.vector.insert(id, Slot::Ready(tile, self.tick));
                }
                Loaded::Vector(id, Ok(None)) => {
                    self.vector.insert(id, Slot::Empty);
                }
                Loaded::Vector(id, Err(e)) => {
                    log::debug!(target: "map", "圖磚 {}/{}/{} 取得失敗：{e}", id.z, id.x, id.y);
                    self.vector.insert(id, Slot::Failed(now_ms));
                }
                Loaded::Dem(id, Ok(Some(baked))) => {
                    let tile = upload_dem(gpu, shade_layout, &baked);
                    self.dem_bytes += tile.bytes;
                    self.dem.insert(id, Slot::Ready(tile, self.tick));
                }
                Loaded::Dem(id, Ok(None)) => {
                    self.dem.insert(id, Slot::Empty);
                }
                Loaded::Dem(id, Err(e)) => {
                    log::debug!(target: "map", "地形圖磚 {}/{}/{} 取得失敗：{e}", id.z, id.x, id.y);
                    self.dem.insert(id, Slot::Failed(now_ms));
                }
            }
        }
        any
    }

    /// Ask for what the camera needs and evict past the budget. Returns what to
    /// draw this frame, parents first so a child overdraws them.
    pub fn update(&mut self, camera: &Camera, now_ms: f64) -> (Vec<TileId>, Vec<TileId>) {
        self.tick += 1;
        let tick = self.tick;

        let wanted = covering(camera, vector_zoom(camera.zoom));
        for &id in &wanted {
            let ask = match self.vector.get(&id) {
                None => true,
                Some(Slot::Failed(at)) => now_ms - at > RETRY_MS,
                _ => false,
            };
            if ask {
                self.request_vector(id);
            }
        }
        let vector_draw = choose(&wanted, tick, &mut self.vector);

        let wanted_dem: Vec<TileId> = covering(camera, dem_zoom(camera.zoom))
            .into_iter()
            .filter(|id| dem_in_bounds(*id))
            .collect();
        for &id in &wanted_dem {
            let ask = match self.dem.get(&id) {
                None => true,
                Some(Slot::Failed(at)) => now_ms - at > RETRY_MS,
                _ => false,
            };
            if ask {
                self.request_dem(id);
            }
        }
        let dem_draw = choose(&wanted_dem, tick, &mut self.dem);

        evict(
            &mut self.vector,
            &mut self.vector_bytes,
            VECTOR_BUDGET,
            tick,
            |t| t.bytes,
        );
        evict(&mut self.dem, &mut self.dem_bytes, DEM_BUDGET, tick, |t| {
            t.bytes
        });
        (vector_draw, dem_draw)
    }

    /// Every wanted tile has answered (loaded, or known to be empty).
    pub fn settled(&self, camera: &Camera) -> bool {
        let done_v = covering(camera, vector_zoom(camera.zoom))
            .into_iter()
            .all(|id| !matches!(self.vector.get(&id), None | Some(Slot::Loading)));
        let done_d = covering(camera, dem_zoom(camera.zoom))
            .into_iter()
            .filter(|id| dem_in_bounds(*id))
            .all(|id| !matches!(self.dem.get(&id), None | Some(Slot::Loading)));
        done_v && done_d
    }

    pub fn vector_tile(&self, id: TileId) -> Option<&VectorGpu> {
        match self.vector.get(&id) {
            Some(Slot::Ready(tile, _)) => Some(tile),
            _ => None,
        }
    }

    pub fn dem_tile(&self, id: TileId) -> Option<&DemGpu> {
        match self.dem.get(&id) {
            Some(Slot::Ready(tile, _)) => Some(tile),
            _ => None,
        }
    }

    /// Give every GPU resource back. The tiles are in the HTTP cache: a re-show is
    /// quick, and a hidden window should hold nothing.
    pub fn trim(&mut self) {
        // In-flight answers still arrive; they find no slot and are dropped below.
        self.vector.clear();
        self.dem.clear();
        self.vector_bytes = 0;
        self.dem_bytes = 0;
        while self.rx.try_recv().is_ok() {}
    }
}

fn upload_dem(gpu: &Gpu, layout: &wgpu::BindGroupLayout, baked: &dem::Baked) -> DemGpu {
    let texture = gpu.device.create_texture_with_data(
        &gpu.queue,
        &wgpu::TextureDescriptor {
            label: Some("hillshade"),
            size: wgpu::Extent3d {
                width: baked.size,
                height: baked.size,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rg8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        },
        wgpu::util::TextureDataOrder::LayerMajor,
        &baked.pixels,
    );
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    let bind = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("hillshade"),
        layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: wgpu::BindingResource::TextureView(&view),
        }],
    });
    DemGpu {
        bind,
        bytes: baked.pixels.len() as u64,
    }
}

/// What to draw for `wanted`: each tile if ready, else its nearest ready ancestor,
/// else its ready children. Marks them used.
fn choose<T>(wanted: &[TileId], tick: u64, slots: &mut HashMap<TileId, Slot<T>>) -> Vec<TileId> {
    let mut draw: HashSet<TileId> = HashSet::with_capacity(wanted.len());
    let ready = |slots: &HashMap<TileId, Slot<T>>, id: &TileId| {
        matches!(slots.get(id), Some(Slot::Ready(..)))
    };
    for &id in wanted {
        if ready(slots, &id) {
            draw.insert(id);
            continue;
        }
        if matches!(slots.get(&id), Some(Slot::Empty)) {
            continue;
        }
        let mut found = false;
        let mut up = id.parent();
        let mut steps = 0;
        while let Some(parent) = up {
            if ready(slots, &parent) {
                draw.insert(parent);
                found = true;
                break;
            }
            steps += 1;
            if steps >= 6 {
                break;
            }
            up = parent.parent();
        }
        if !found && id.z < 22 {
            for child in id.children() {
                if ready(slots, &child) {
                    draw.insert(child);
                }
            }
        }
    }
    for id in wanted.iter().chain(draw.iter()) {
        if let Some(Slot::Ready(_, used)) = slots.get_mut(id) {
            *used = tick;
        }
    }
    let mut out: Vec<TileId> = draw.into_iter().collect();
    out.sort();
    out
}

fn evict<T>(
    slots: &mut HashMap<TileId, Slot<T>>,
    bytes: &mut u64,
    budget: u64,
    tick: u64,
    size: impl Fn(&T) -> u64,
) {
    if *bytes <= budget {
        return;
    }
    let mut ready: Vec<(u64, TileId, u64)> = slots
        .iter()
        .filter_map(|(id, slot)| match slot {
            Slot::Ready(tile, used) if *used != tick => Some((*used, *id, size(tile))),
            _ => None,
        })
        .collect();
    ready.sort();
    for (_, id, tile_bytes) in ready {
        if *bytes <= budget {
            break;
        }
        slots.remove(&id);
        *bytes = bytes.saturating_sub(tile_bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zoom_levels_follow_maplibre() {
        assert_eq!(vector_zoom(6.8), 6);
        assert_eq!(vector_zoom(11.5), 9);
        assert_eq!(dem_zoom(6.8), 7);
        assert_eq!(dem_zoom(12.0), 11);
    }

    #[test]
    fn the_tiles_of_the_initial_view_cover_taiwan() {
        let cam = Camera::new(121.6, 23.5, 6.8, 1280.0, 815.0);
        let tiles = covering(&cam, 6);
        // lon 121.6 at z6 is column 53, lat 23.5 row 27.
        assert!(tiles.contains(&TileId { z: 6, x: 53, y: 27 }));
        assert!(tiles.iter().all(|t| t.z == 6));
    }

    #[test]
    fn a_loading_tile_is_stood_in_for_by_its_parent_then_its_children() {
        let id = TileId {
            z: 7,
            x: 107,
            y: 55,
        };
        let mut slots: HashMap<TileId, Slot<()>> = HashMap::new();
        slots.insert(id, Slot::Loading);
        assert!(choose(&[id], 1, &mut slots).is_empty());
        slots.insert(id.parent().unwrap(), Slot::Ready((), 0));
        assert_eq!(choose(&[id], 1, &mut slots), vec![id.parent().unwrap()]);
        slots.remove(&id.parent().unwrap());
        let kids = id.children();
        slots.insert(kids[1], Slot::Ready((), 0));
        assert_eq!(choose(&[id], 1, &mut slots), vec![kids[1]]);
        slots.insert(id, Slot::Ready((), 0));
        assert_eq!(choose(&[id], 1, &mut slots), vec![id]);
    }

    #[test]
    fn eviction_keeps_what_this_frame_uses() {
        let mut slots: HashMap<TileId, Slot<u64>> = HashMap::new();
        let a = TileId { z: 1, x: 0, y: 0 };
        let b = TileId { z: 1, x: 1, y: 0 };
        let c = TileId { z: 1, x: 0, y: 1 };
        slots.insert(a, Slot::Ready(10, 1));
        slots.insert(b, Slot::Ready(10, 2));
        slots.insert(c, Slot::Ready(10, 3));
        let mut bytes = 30;
        evict(&mut slots, &mut bytes, 15, 3, |t| *t);
        assert_eq!(bytes, 10);
        assert!(slots.contains_key(&c));
        assert!(!slots.contains_key(&a) && !slots.contains_key(&b));
    }

    #[test]
    fn dem_stops_outside_its_bounds() {
        assert!(dem_in_bounds(TileId {
            z: 7,
            x: 107,
            y: 55
        }));
        assert!(!dem_in_bounds(TileId { z: 7, x: 10, y: 55 }));
    }
}
