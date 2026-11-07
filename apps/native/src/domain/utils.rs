//! Pure helpers (domain/utils.ts, features/eew/waves.ts, features/rts/townPeaks.ts).
//! The intensity levels, the shake level and the travel times are trem_core's.

use std::collections::HashMap;
use std::sync::OnceLock;

use chrono::{DateTime, Datelike, Local, TimeZone, Timelike};
use trem_core::region::town_of;

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
    use super::constants::TW_COUNTY_FILL;
    use trem_core::color::{intensity_rgba, lpgm_rgba};
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
}
