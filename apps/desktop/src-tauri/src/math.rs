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
    /// Sine and cosine of the latitude, and the longitude, in radians: the
    /// parts of the distance that depend only on the town, worked out once
    /// instead of on every EEW update.
    sin_lat: f64,
    cos_lat: f64,
    lon_rad: f64,
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
                let lat = r.f64() * PI / 180.0;
                let lon = r.f64();
                v.push(Town {
                    code,
                    sin_lat: lat.sin(),
                    cos_lat: lat.cos(),
                    lon_rad: lon * PI / 180.0,
                });
            }
        }
        v
    })
}

/// Great-circle distance in km (spherical law of cosines), from each end's
/// sine and cosine of latitude and its longitude, all in radians.
fn distance(sin_a: f64, cos_a: f64, lng_a: f64, sin_b: f64, cos_b: f64, lng_b: f64) -> f64 {
    (sin_a * sin_b + cos_a * cos_b * (lng_a - lng_b).cos()).acos() * 6371.008
}

/// The PGV estimate's terms that depend only on the quake (it takes over once
/// the PGA estimate reaches 4.5).
struct Pgv {
    long: f64,
    near: f64,
    base: f64,
}

impl Pgv {
    fn new(depth: f64, mag_w: f64) -> Self {
        Self {
            long: 10f64.powf(0.5 * mag_w - 1.85) / 2.0,
            near: 0.0028 * 10f64.powf(0.5 * mag_w),
            base: 0.58 * mag_w + 0.0038 * depth - 1.29,
        }
    }

    /// `hypo` is the hypocentral distance, √(e² + depth²). This used to compute
    /// √(depth² + e²) itself, which is the same number: IEEE addition commutes.
    fn intensity(&self, hypo: f64) -> f64 {
        let x = (hypo - self.long).max(3.0);
        let gpv600 = 10f64.powf(self.base - (x + self.near).log10() - 0.002 * x);
        let pgv = gpv600 * 1.31;
        2.68 + 1.72 * pgv.log10()
    }
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

    // Everything that depends only on the quake, worked out once rather than
    // per town. Each keeps the grouping it had inside the loop — the hoisted
    // factor is always the one evaluated first — so every intensity comes out
    // bit-identical.
    let la = lat * PI / 180.0;
    let (sin_la, cos_la) = (la.sin(), la.cos());
    let lna = lon * PI / 180.0;
    let pga_scale = 1.657 * (1.533 * mag).exp();
    let pgv = Pgv::new(depth, mag);

    for t in towns() {
        let dist_surface = distance(sin_la, cos_la, lna, t.sin_lat, t.cos_lat, t.lon_rad);
        let dist = (dist_surface * dist_surface + depth * depth).sqrt();
        let pga = pga_scale * dist.powf(-1.607);
        let mut i = 2.0 * pga.log10() + 0.7;
        if i >= 4.5 {
            i = pgv.intensity(dist);
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
        let r = |d: f64| d * PI / 180.0;
        let (a, b) = (r(25.03), r(22.63));
        let d = distance(a.sin(), a.cos(), r(121.56), b.sin(), b.cos(), r(120.30));
        assert!((d - 296.0).abs() < 15.0, "got {d}");
    }

    #[test]
    fn area_result_is_populated_and_bounded() {
        let r = eew_area_pga(23.5, 121.5, 10.0, 6.0);
        // Keyed by town code, one entry per town. Exact rather than a floor: a
        // stale region.bin once gave two towns the same code, which a floor let
        // through while one of them silently lost its estimate.
        assert_eq!(r.area.len(), 368);
        assert!(r.max_i > 0.0 && r.max_i < 12.0, "max_i={}", r.max_i);
    }
}
