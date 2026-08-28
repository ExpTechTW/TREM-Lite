//! Seismic intensity attenuation — moved to Rust for speed. This is the hot path
//! that loops over every Taiwan town (~370) on each EEW update. Ported to be
//! behavior-equivalent to `EEWCalculator.eewAreaPga` in the old
//! legacy/src/js/index/utils/eewCalculator.js (the redundant `atan(tan(x))` in
//! the JS haversine is simplified away — it is identically `x` for latitudes).

use std::collections::HashMap;
use std::f64::consts::PI;
use std::sync::OnceLock;

use serde::Serialize;

// Shared compact binary produced by scripts/encode-data.mjs (also decoded by the
// frontend, packages/core/src/lib/bindata.ts). Single source of truth — the old
// duplicated src-tauri/region.json is gone. Format per region.bin:
//   varint version | varint numCities
//   per city: varint nameLen + utf8 | varint numTowns
//   per town: varint nameLen + utf8 | varint code | f64 lat | f64 lon
const REGION_BIN: &[u8] = include_bytes!("../../../../packages/core/src/data/region.bin");

struct Town {
    code: i64,
    lat: f64,
    lon: f64,
}

/// Minimal sequential reader for region.bin (LEB128 varints, LE f64, utf8 strs).
struct BinReader<'a> {
    buf: &'a [u8],
    pos: usize,
}
impl BinReader<'_> {
    fn varint(&mut self) -> u64 {
        let mut result = 0u64;
        let mut shift = 0u32;
        loop {
            let b = self.buf[self.pos];
            self.pos += 1;
            result |= u64::from(b & 0x7f) << shift;
            if b & 0x80 == 0 {
                return result;
            }
            shift += 7;
        }
    }
    fn f64(&mut self) -> f64 {
        let mut b = [0u8; 8];
        b.copy_from_slice(&self.buf[self.pos..self.pos + 8]);
        self.pos += 8;
        f64::from_le_bytes(b)
    }
    fn skip_str(&mut self) {
        let len = self.varint() as usize;
        self.pos += len;
    }
}

fn towns() -> &'static Vec<Town> {
    static TOWNS: OnceLock<Vec<Town>> = OnceLock::new();
    TOWNS.get_or_init(|| {
        let mut r = BinReader {
            buf: REGION_BIN,
            pos: 0,
        };
        r.varint(); // version
        let num_cities = r.varint();
        let mut v = Vec::with_capacity(400);
        for _ in 0..num_cities {
            r.skip_str(); // city name (unused by the math)
            let num_towns = r.varint();
            for _ in 0..num_towns {
                r.skip_str(); // town name
                let code = r.varint() as i64;
                let lat = r.f64();
                let lon = r.f64();
                v.push(Town { code, lat, lon });
            }
        }
        v
    })
}

/// Great-circle distance in km (spherical law of cosines).
fn distance(lat_a: f64, lng_a: f64, lat_b: f64, lng_b: f64) -> f64 {
    let la = lat_a * PI / 180.0;
    let lna = lng_a * PI / 180.0;
    let lb = lat_b * PI / 180.0;
    let lnb = lng_b * PI / 180.0;
    (la.sin() * lb.sin() + la.cos() * lb.cos() * (lna - lnb).cos()).acos() * 6371.008
}

/// PGV-based intensity (used when the PGA estimate is already >= 4.5).
fn eew_area_pgv(ep_lat: f64, ep_lon: f64, pt_lat: f64, pt_lon: f64, depth: f64, mag_w: f64) -> f64 {
    let long = 10f64.powf(0.5 * mag_w - 1.85) / 2.0;
    let epicenter_distance = distance(ep_lat, ep_lon, pt_lat, pt_lon);
    let hypocenter_distance =
        (depth * depth + epicenter_distance * epicenter_distance).sqrt() - long;
    let x = hypocenter_distance.max(3.0);
    let gpv600 = 10f64.powf(
        0.58 * mag_w + 0.0038 * depth
            - 1.29
            - (x + 0.0028 * 10f64.powf(0.5 * mag_w)).log10()
            - 0.002 * x,
    );
    let pgv = gpv600 * 1.31;
    2.68 + 1.72 * pgv.log10()
}

#[derive(Serialize)]
pub struct AreaEntry {
    pub dist: f64,
    pub i: f64,
}

#[derive(Serialize)]
pub struct EewAreaResult {
    pub max_i: f64,
    /// town code -> { dist, i }
    pub area: HashMap<i64, AreaEntry>,
}

/// Predicted intensity per town for an EEW at (lat, lon, depth, mag).
#[tauri::command]
pub fn eew_area_pga(lat: f64, lon: f64, depth: f64, mag: f64) -> EewAreaResult {
    let mut area = HashMap::with_capacity(400);
    let mut max_i = 0.0f64;

    for t in towns() {
        let dist_surface = distance(lat, lon, t.lat, t.lon);
        let dist = (dist_surface * dist_surface + depth * depth).sqrt();
        let pga = 1.657 * (1.533 * mag).exp() * dist.powf(-1.607);
        let mut i = 2.0 * pga.log10() + 0.7;
        if i >= 4.5 {
            i = eew_area_pgv(lat, lon, t.lat, t.lon, depth, mag);
        }
        if i > max_i {
            max_i = i;
        }
        area.insert(t.code, AreaEntry { dist, i });
    }

    EewAreaResult { max_i, area }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn towns_parse() {
        assert!(
            towns().len() > 300,
            "expected ~370 towns, got {}",
            towns().len()
        );
    }

    #[test]
    fn distance_taipei_kaohsiung() {
        // Taipei ~ (25.03,121.56), Kaohsiung ~ (22.63,120.30): ~296 km great-circle.
        let d = distance(25.03, 121.56, 22.63, 120.30);
        assert!((d - 296.0).abs() < 15.0, "got {d}");
    }

    #[test]
    fn area_result_is_populated_and_bounded() {
        let r = eew_area_pga(23.5, 121.5, 10.0, 6.0);
        // Keyed by town code, which dedups a couple of shared codes (368 towns → 367 codes),
        // exactly like the JS `result[info.code] = ...` did.
        assert!(r.area.len() > 350, "got {}", r.area.len());
        assert!(r.max_i > 0.0 && r.max_i < 12.0, "max_i={}", r.max_i);
    }
}
