//! Pure helpers (domain/utils.ts, domain/eewCalculator.ts, features/eew/waves.ts,
//! features/rts/shakeLevel.ts, features/rts/townPeaks.ts).

use std::collections::HashMap;
use std::sync::OnceLock;

use chrono::{DateTime, Datelike, Local, TimeZone, Timelike};

use super::bindata::{self, TimeTable};
use super::palette::js_round;
use super::region::town_of;

/// Great-circle distance in km, by the spherical law of cosines. The cosine is capped
/// at 1: for two points in the same place it can round above, and acos of that is NaN.
pub fn distance(lat_a: f64, lng_a: f64, lat_b: f64, lng_b: f64) -> f64 {
    let (ra, rb) = (lat_a.to_radians(), lat_b.to_radians());
    let d = lng_a.to_radians() - lng_b.to_radians();
    let cos = ra.sin() * rb.sin() + ra.cos() * rb.cos() * d.cos();
    cos.min(1.0).acos() * 6371.008
}

pub fn local(ms: f64) -> Option<DateTime<Local>> {
    Local.timestamp_millis_opt(ms as i64).single()
}

/// `YYYY-MM-DD HH:MM:SS`, local.
pub fn format_time(ms: f64) -> String {
    local(ms).map_or_else(String::new, |d| d.format("%Y-%m-%d %H:%M:%S").to_string())
}

/// `YYYY-MM-DD HH:MM`, local: a report's time has no seconds.
pub fn format_report_time(ms: f64) -> String {
    local(ms).map_or_else(String::new, |d| d.format("%Y-%m-%d %H:%M").to_string())
}

/// `HH:MM`, local.
pub fn format_timestamp(ms: f64) -> String {
    local(ms).map_or_else(String::new, |d| d.format("%H:%M").to_string())
}

/// `MM/DD HH:mm:ss`, local, for the event log.
pub fn when(ms: f64) -> String {
    if ms == 0.0 {
        return "?".to_string();
    }
    local(ms).map_or_else(
        || "?".to_string(),
        |d| d.format("%m/%d %H:%M:%S").to_string(),
    )
}

/// Spoken time: `8月28日7點26分`.
pub fn chinese_time(ms: f64) -> String {
    local(ms).map_or_else(String::new, |d| {
        format!("{}月{}日{}點{}分", d.month(), d.day(), d.hour(), d.minute())
    })
}

/// CWA level for a measured intensity: rounded below 4.5, then one level per half
/// step, and 7 from 6.5. NaN gives 9, as the chain of comparisons this replaced did.
pub fn intensity_float_to_int(float: f64) -> i32 {
    if float < 0.0 {
        0
    } else if float < 4.5 {
        js_round(float) as i32
    } else if float < 6.5 {
        (float * 2.0).floor() as i32 - 4
    } else {
        9
    }
}

pub fn int_to_string(max: i32) -> String {
    match max {
        5 => "5弱".to_string(),
        6 => "5強".to_string(),
        7 => "6弱".to_string(),
        8 => "6強".to_string(),
        9 => "7級".to_string(),
        _ => format!("{max}級"),
    }
}

/// The place in a report's `loc`: what follows `位於`, before the closing parenthesis
/// and the first space.
pub fn extract_location(loc: &str) -> String {
    let mut extracted = loc;
    if let Some(at) = loc.find("位於") {
        let rest = &loc[at + "位於".len()..];
        // Greedy, as the regex was: up to the last `)`.
        if let Some(close) = rest.rfind(')') {
            if close > 0 {
                extracted = &rest[..close];
            }
        }
    }
    match extracted.find(' ') {
        Some(space) => extracted[..space].to_string(),
        None => extracted.to_string(),
    }
}

/// Each town's colour for its level, intensity's or long-period's palette, 0 unlit.
pub fn town_colors(area: &HashMap<i32, i32>, lpgm: bool) -> HashMap<u32, [u8; 4]> {
    use super::constants::{intensity_rgba, lpgm_rgba, TW_COUNTY_FILL};
    area.iter()
        .filter(|(code, _)| **code >= 0)
        .map(|(code, level)| {
            let color = if *level == 0 {
                TW_COUNTY_FILL
            } else if lpgm {
                lpgm_rgba(*level)
            } else {
                intensity_rgba(*level)
            };
            (*code as u32, color)
        })
        .collect()
}

/// A body's fingerprint, to tell an unchanged answer without keeping it.
pub fn text_hash(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

// ---- Travel times -------------------------------------------------------------

static TIME_BIN: &[u8] = include_bytes!("../../../../packages/core/src/data/time.bin");

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PsWaveDist {
    pub p_dist: f64,
    pub s_dist: f64,
    pub s_t: f64,
}

fn time_table() -> &'static TimeTable {
    static TABLE: OnceLock<TimeTable> = OnceLock::new();
    TABLE.get_or_init(|| {
        bindata::decode_time_table(TIME_BIN).unwrap_or_else(|| {
            log::error!(target: "init", "time.bin 解不開");
            Vec::new()
        })
    })
}

/// The P/S wavefront radii (km) reached `now - time` after origin.
pub fn ps_wave_dist(depth: f64, time: f64, now: f64) -> PsWaveDist {
    let table = time_table();
    let Some(first) = table.first() else {
        return PsWaveDist::default();
    };
    let t = (now - time) / 1000.0;
    // Strictly closer, so a tie keeps the earlier depth.
    let mut best = first;
    for row in table {
        if (row.0 - depth).abs() < (best.0 - depth).abs() {
            best = row;
        }
    }
    let (mut p_dist, mut s_dist, mut s_t) = (None, None, 0.0);
    let mut prev: Option<&bindata::TimeTableRow> = None;
    for row in &best.1 {
        if p_dist.is_none() && row.p > t {
            p_dist = Some(match prev {
                Some(prev) => prev.r + ((t - prev.p) / (row.p - prev.p)) * (row.r - prev.r),
                None => row.r,
            });
        }
        if s_dist.is_none() && row.s > t {
            s_dist = Some(match prev {
                Some(prev) => prev.r + ((t - prev.s) / (row.s - prev.s)) * (row.r - prev.r),
                None => {
                    s_t = row.s;
                    row.r
                }
            });
        }
        if p_dist.is_some() && s_dist.is_some() {
            break;
        }
        prev = Some(row);
    }
    PsWaveDist {
        p_dist: p_dist.filter(|d: &f64| *d >= 0.0).unwrap_or(0.0),
        s_dist: s_dist.filter(|d: &f64| *d >= 0.0).unwrap_or(0.0),
        s_t,
    }
}

// ---- Wavefront rings ----------------------------------------------------------

const RING_STEPS: usize = 256;
const M_PER_PX_Z0: f64 = 156_543.033_92;

fn meters_per_pixel(lat: f64, zoom: f64) -> f64 {
    (M_PER_PX_Z0 * lat.to_radians().cos()) / 2f64.powf(zoom)
}

/// How far a ring must grow, in km, before it moves by a pixel at this zoom.
pub fn ring_step_km(lat: f64, zoom: f64) -> f64 {
    meters_per_pixel(lat, zoom) / 1000.0
}

/// A great-circle ring of `radius` km around (lon, lat), with a vertex every 8 pixels
/// or so, at least 16.
pub fn circle_ring(lon: f64, lat: f64, radius: f64, zoom: f64) -> Vec<[f64; 2]> {
    static BEARINGS: OnceLock<Vec<(f64, f64)>> = OnceLock::new();
    let bearings = BEARINGS.get_or_init(|| {
        (0..=RING_STEPS)
            .map(|i| {
                ((i * 360) as f64 / RING_STEPS as f64)
                    .to_radians()
                    .sin_cos()
            })
            .collect()
    });
    let delta = radius / 6371.0;
    let (sin_phi1, cos_phi1) = lat.to_radians().sin_cos();
    let lambda1 = lon.to_radians();
    let (sin_delta, cos_delta) = delta.sin_cos();
    let a = sin_phi1 * cos_delta;
    let b = cos_phi1 * sin_delta;

    let mpp = meters_per_pixel(lat, zoom);
    let circumference = if mpp > 0.0 && radius > 0.0 {
        (std::f64::consts::TAU * radius * 1000.0) / mpp
    } else {
        RING_STEPS as f64
    };
    let need = ((circumference / 8.0).ceil() as usize).max(16);
    let stride = if need >= RING_STEPS {
        1
    } else {
        (RING_STEPS / need).max(1)
    };

    let mut ring = Vec::with_capacity(RING_STEPS / stride + 2);
    let mut i = 0;
    while i <= RING_STEPS {
        let (sin_b, cos_b) = bearings[i];
        let sin_phi2 = (a + b * cos_b).clamp(-1.0, 1.0);
        let lambda2 = lambda1 + (sin_b * b).atan2(cos_delta - sin_phi1 * sin_phi2);
        ring.push([lambda2.to_degrees(), sin_phi2.asin().to_degrees()]);
        i += stride;
    }
    if let Some(first) = ring.first().copied() {
        ring.push(first);
    }
    ring
}

// ---- Shake level --------------------------------------------------------------

/// rts-image-go's ShakeLevel: stations binned into a 0.05° grid, each cell's strongest
/// intensity above 0 adding (I)^1.5, the sum scaled by 1.4.
pub fn shake_level(points: impl Iterator<Item = (f64, f64, f64)>) -> i32 {
    const CELL: f64 = 0.05;
    let mut grid: HashMap<i64, f64> = HashMap::new();
    for (lon, lat, i) in points {
        if i.is_nan() {
            continue;
        }
        let key = (lon / CELL).floor() as i64 * 100_000 + (lat / CELL).floor() as i64;
        let cell = grid.entry(key).or_insert(i);
        if i > *cell {
            *cell = i;
        }
    }
    let sum: f64 = grid
        .values()
        .filter(|i| **i > 0.0)
        .map(|i| i.powf(1.5))
        .sum();
    js_round(1.4 * sum) as i32
}

// ---- Town peaks ---------------------------------------------------------------

const PEAK_WINDOW_MS: f64 = 60_000.0;

struct TownSamples {
    key: (&'static str, &'static str, i32),
    code: i32,
    samples: Vec<(f64, i32)>,
}

/// The bottom-right ranking's memory: each town's highest level over the last 60 s.
#[derive(Default)]
pub struct TownPeaks {
    towns: Vec<TownSamples>,
}

impl TownPeaks {
    pub fn clear(&mut self) {
        self.towns.clear();
    }

    /// Adds one frame's per-town levels at `now`; returns every town's peak in the window.
    pub fn update(&mut self, frame: &[(i32, i32)], now: f64) -> Vec<(i32, i32)> {
        for &(code, i) in frame {
            // Unnamed towns key on their code alone.
            let key = town_of(code).map_or(("", "", code), |t| (t.city, t.town, 0));
            match self.towns.iter_mut().find(|t| t.key == key) {
                Some(town) => town.samples.push((now, i)),
                None => self.towns.push(TownSamples {
                    key,
                    code,
                    samples: vec![(now, i)],
                }),
            }
        }
        let mut peaks = Vec::with_capacity(self.towns.len());
        self.towns.retain_mut(|town| {
            // `time <= now` also drops what a jump back in time left in the future.
            town.samples
                .retain(|(time, _)| *time <= now && now - *time < PEAK_WINDOW_MS);
            if town.samples.is_empty() {
                return false;
            }
            let max = town.samples.iter().fold(0, |m, (_, i)| m.max(*i));
            peaks.push((town.code, max));
            true
        });
        peaks
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_split_on_their_bounds() {
        assert_eq!(intensity_float_to_int(-0.3), 0);
        assert_eq!(intensity_float_to_int(0.49), 0);
        assert_eq!(intensity_float_to_int(0.5), 1);
        assert_eq!(intensity_float_to_int(4.49), 4);
        assert_eq!(intensity_float_to_int(4.5), 5);
        assert_eq!(intensity_float_to_int(5.0), 6);
        assert_eq!(intensity_float_to_int(5.5), 7);
        assert_eq!(intensity_float_to_int(6.0), 8);
        assert_eq!(intensity_float_to_int(6.5), 9);
        assert_eq!(intensity_float_to_int(f64::NAN), 9);
    }

    #[test]
    fn same_point_is_zero_km_not_nan() {
        assert_eq!(distance(23.5, 121.6, 23.5, 121.6), 0.0);
        let km = distance(25.0, 121.5, 22.6, 120.3);
        assert!((km - 290.0).abs() < 10.0, "{km}");
    }

    #[test]
    fn location_comes_from_inside_the_parenthesis() {
        assert_eq!(
            extract_location("花蓮縣政府南南西方 20.1 公里 (位於花蓮縣秀林鄉)"),
            "花蓮縣秀林鄉"
        );
        assert_eq!(extract_location("臺灣東部海域 外海"), "臺灣東部海域");
    }

    #[test]
    fn wavefronts_grow_with_time_and_s_trails_p() {
        let early = ps_wave_dist(10.0, 0.0, 10_000.0);
        let late = ps_wave_dist(10.0, 0.0, 30_000.0);
        assert!(late.p_dist > early.p_dist);
        assert!(late.s_dist > early.s_dist);
        assert!(late.s_dist < late.p_dist);
        assert_eq!(ps_wave_dist(10.0, 0.0, -1000.0).s_dist.min(0.0), 0.0);
    }

    #[test]
    fn rings_close_and_keep_their_radius() {
        let ring = circle_ring(121.0, 23.0, 100.0, 7.0);
        assert_eq!(ring.first(), ring.last());
        for [lon, lat] in &ring {
            assert!((distance(23.0, 121.0, *lat, *lon) - 100.0).abs() < 0.5);
        }
    }

    #[test]
    fn peaks_hold_for_a_minute() {
        let mut peaks = TownPeaks::default();
        assert_eq!(peaks.update(&[(1, 3)], 0.0), vec![(1, 3)]);
        assert_eq!(peaks.update(&[(1, 1)], 30_000.0), vec![(1, 3)]);
        assert_eq!(peaks.update(&[], 61_000.0), vec![(1, 1)]);
        assert_eq!(peaks.update(&[], 100_000.0), vec![]);
    }

    #[test]
    fn shake_scores_each_cell_once() {
        let two_in_one_cell = shake_level([(121.01, 23.01, 4.0), (121.02, 23.02, 3.0)].into_iter());
        assert_eq!(two_in_one_cell, 11);
        assert_eq!(shake_level([(121.0, 23.0, -1.0)].into_iter()), 0);
    }
}
