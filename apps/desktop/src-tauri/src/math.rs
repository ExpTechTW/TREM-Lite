//! EEW predicted intensity per town — the hot path that runs over every Taiwan
//! town (368) on each EEW update. The level comes from the ML model v1
//! (ml_intensity.rs); this file owns the town table and the hypocentral
//! distance the frontend also receives.
//!
//! It replaced the TREM-Lite formula (Katsumata PGA, and a PGV estimate once
//! that reached 4.5) ported from legacy/src/js/index/utils/eewCalculator.js.

use std::collections::HashMap;
use std::f64::consts::PI;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::ml_intensity;

// Shared compact binary produced by scripts/encode-data.mjs (also decoded by the
// frontend, packages/core/src/lib/bindata.ts). Single source of truth — the old
// duplicated src-tauri/region.json is gone. Format per region.bin:
//   varint version | varint numCities
//   per city: varint nameLen + utf8 | varint numTowns
//   per town: varint nameLen + utf8 | varint code | f64 lat | f64 lon
const REGION_BIN: &[u8] = include_bytes!("../../../../packages/core/src/data/region.bin");

struct Town {
    code: i64,
    /// Degrees, as in region.json: the model's feature inputs.
    lat_deg: f64,
    lon_deg: f64,
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
                let lat_deg = r.f64();
                let lon = r.f64();
                let lat = lat_deg * PI / 180.0;
                v.push(Town {
                    code,
                    lat_deg,
                    lon_deg: lon,
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

#[derive(Serialize, Clone)]
pub struct AreaEntry {
    /// Hypocentral distance (km), √(epicentral² + depth²).
    pub dist: f64,
    /// Predicted CWA level 0-9 (5 = 5弱 … 9 = 7).
    pub level: u8,
}

#[derive(Serialize, Clone)]
pub struct EewAreaResult {
    /// town code -> { dist, level }
    pub area: HashMap<i64, AreaEntry>,
}

/// Predicted level per town for an EEW at (lat, lon, depth, mag).
///
/// `async` so it runs off the main thread: the model takes a few milliseconds.
#[tauri::command(async)]
pub fn eew_area_intensity(
    lat: f64,
    lon: f64,
    depth: f64,
    mag: f64,
) -> Result<EewAreaResult, String> {
    area_intensity(lat, lon, depth, mag)
}

fn area_intensity(lat: f64, lon: f64, depth: f64, mag: f64) -> Result<EewAreaResult, String> {
    // The trees need finite features; a garbled report must fail, not paint a
    // plausible-looking map.
    if ![lat, lon, depth, mag].iter().all(|v| v.is_finite()) {
        return Err(format!("non-finite EEW M{mag} {depth}km at {lat},{lon}"));
    }
    // Successive reports often carry the same solution (only the serial moves
    // on), so the last result is kept and reused for identical inputs.
    static LAST: Mutex<Option<([u64; 4], EewAreaResult)>> = Mutex::new(None);
    let key = [lat, lon, depth, mag].map(f64::to_bits);
    if let Some((k, r)) = LAST.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if *k == key {
            return Ok(r.clone());
        }
    }

    let model = ml_intensity::model()?;
    let towns = towns();
    let rows: Vec<ml_intensity::Row> = towns
        .iter()
        .map(|t| ml_intensity::features(mag, depth, lat, lon, t.lat_deg, t.lon_deg))
        .collect();
    let (pga, pgv) = model.predict(&rows);

    let la = lat * PI / 180.0;
    let (sin_la, cos_la) = (la.sin(), la.cos());
    let lna = lon * PI / 180.0;
    let mut area = HashMap::with_capacity(towns.len());
    for (i, t) in towns.iter().enumerate() {
        let surface = distance(sin_la, cos_la, lna, t.sin_lat, t.cos_lat, t.lon_rad);
        let dist = (surface * surface + depth * depth).sqrt();
        area.insert(
            t.code,
            AreaEntry {
                dist,
                level: ml_intensity::level(pga[i], pgv[i]),
            },
        );
    }
    let result = EewAreaResult { area };
    *LAST.lock().unwrap_or_else(|e| e.into_inner()) = Some((key, result.clone()));
    Ok(result)
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
        ml_intensity::load_for_tests();
        let r = area_intensity(23.5, 121.5, 10.0, 6.0).unwrap();
        // Keyed by town code, one entry per town. Exact rather than a floor: a
        // stale region.bin once gave two towns the same code, which a floor let
        // through while one of them silently lost its estimate.
        assert_eq!(r.area.len(), 368);
        let max = r.area.values().map(|e| e.level).max().unwrap();
        assert!((1..=9).contains(&max), "max level {max}");
    }

    #[test]
    fn rejects_non_finite_input() {
        assert!(area_intensity(f64::NAN, 121.5, 10.0, 6.0).is_err());
    }

    /// The whole town table against onnxruntime's levels for the same events,
    /// through region.bin rather than the golden file's own coordinates.
    #[test]
    fn town_levels_match_onnxruntime() {
        #[derive(serde::Deserialize)]
        struct Field {
            lat: f64,
            lon: f64,
            mag: f64,
            depth: f64,
            levels: HashMap<String, u8>,
        }
        #[derive(serde::Deserialize)]
        struct Golden {
            fields: Vec<Field>,
        }
        let g: Golden =
            serde_json::from_str(include_str!("../testdata/ml_intensity_golden.json")).unwrap();
        assert!(!g.fields.is_empty());
        ml_intensity::load_for_tests();
        for f in g.fields {
            let r = area_intensity(f.lat, f.lon, f.depth, f.mag).unwrap();
            assert_eq!(r.area.len(), f.levels.len());
            for (code, want) in f.levels {
                let got = r.area[&code.parse::<i64>().unwrap()].level;
                assert_eq!(got, want, "M{} town {code}", f.mag);
            }
        }
    }
}
