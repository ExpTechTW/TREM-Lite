//! The fixed tables: towns, detection boxes and the travel-time table, built on first
//! use from the embedded binaries (domain/region.ts, features/box/polygons.ts).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::bindata::{self, BoxFeature, Town};

static REGION_BIN: &[u8] = include_bytes!("../assets/data/region.bin");
static BOX_BIN: &[u8] = include_bytes!("../assets/data/box.bin");

struct Region {
    towns: Vec<Town>,
    by_code: HashMap<i32, usize>,
}

fn region() -> &'static Region {
    static REGION: OnceLock<Region> = OnceLock::new();
    REGION.get_or_init(|| {
        let towns = bindata::decode_region(REGION_BIN).unwrap_or_else(|| {
            log::error!(target: "init", "region.bin 解不開");
            Vec::new()
        });
        // The first town for a code, as the scan this replaced found.
        let mut by_code = HashMap::with_capacity(towns.len());
        for (i, town) in towns.iter().enumerate() {
            by_code.entry(town.code).or_insert(i);
        }
        Region { towns, by_code }
    })
}

/// The town a code belongs to, or None.
pub fn town_of(code: i32) -> Option<&'static Town> {
    let r = region();
    r.by_code.get(&code).map(|i| &r.towns[*i])
}

/// `search_loc_name`'s `city + town`, or "" when unknown.
pub fn town_name(code: i32) -> String {
    town_of(code).map_or_else(String::new, |t| format!("{}{}", t.city, t.town))
}

pub fn towns() -> &'static [Town] {
    &region().towns
}

pub fn boxes() -> &'static [BoxFeature] {
    static BOXES: OnceLock<Vec<BoxFeature>> = OnceLock::new();
    BOXES.get_or_init(|| {
        bindata::decode_box(BOX_BIN).unwrap_or_else(|| {
            log::error!(target: "init", "box.bin 解不開");
            Vec::new()
        })
    })
}

/// Even-odd ray cast against one ring.
fn inside(lon: f64, lat: f64, ring: &[[f64; 2]]) -> bool {
    let mut hit = false;
    let mut j = ring.len().wrapping_sub(1);
    for i in 0..ring.len() {
        let [xi, yi] = ring[i];
        let [xj, yj] = ring[j];
        if (yi > lat) != (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi {
            hit = !hit;
        }
        j = i;
    }
    hit
}

/// The ID of the box a point lies in. Station coordinates never move within a run, so
/// each point is looked up once.
pub fn box_of(lon: f64, lat: f64) -> Option<u32> {
    type Memo = Mutex<HashMap<(u64, u64), Option<u32>>>;
    static MEMO: OnceLock<Memo> = OnceLock::new();
    let key = (lon.to_bits(), lat.to_bits());
    let memo = MEMO.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(known) = memo.lock() {
        if let Some(id) = known.get(&key) {
            return *id;
        }
    }
    let id = boxes()
        .iter()
        .find(|b| inside(lon, lat, &b.ring))
        .map(|b| b.id);
    if let Ok(mut known) = memo.lock() {
        known.insert(key, id);
    }
    id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tables_decode() {
        assert!(towns().len() > 300);
        let hualien = towns().iter().find(|t| t.town == "秀林鄉").map(|t| t.code);
        assert!(hualien.is_some());
        assert_eq!(
            town_of(hualien.unwrap_or(0)).map(|t| t.city),
            Some("花蓮縣")
        );
        assert!(!boxes().is_empty());
    }

    #[test]
    fn a_ray_cast_finds_the_box_it_lies_in() {
        let square = [[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0], [0.0, 0.0]];
        assert!(inside(1.0, 1.0, &square));
        assert!(!inside(3.0, 1.0, &square));
    }
}
