//! The map as this app draws it (features/map/map.ts): trem_gfx's map engine on ExpTech's
//! tiles and terrain, with the overlays the features set and the layer order map.ts had.

pub mod icons;
pub mod layers;
pub mod scene;

pub use trem_gfx::map::*;

use scene::Scene;
use tiles::Fetch;

/// map.ts's sources, `center` and `zoom`.
const CONFIG: MapConfig = MapConfig {
    vector_url: "https://static.lb.exptech.dev/api/v1/map/tiles/{z}/{x}/{y}.pbf",
    terrain_url: Some("https://static.lb.exptech.dev/api/v1/map/terrain/{z}/{x}/{y}.png"),
    center: (121.6, 23.5),
    zoom: 6.8,
};

/// The map, with this app's overlays.
pub type MapEngine = trem_gfx::map::MapEngine<Scene>;

/// The map as it first appears, `size` in logical pixels.
pub fn engine(
    fetch: Fetch,
    wake: std::sync::Arc<dyn Fn() + Send + Sync>,
    size: (f64, f64),
) -> MapEngine {
    MapEngine::new(&CONFIG, Scene::new(), fetch, wake, size)
}
