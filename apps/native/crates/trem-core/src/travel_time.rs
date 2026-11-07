//! The P/S wavefront radii from the travel-time table (domain/eewCalculator.ts), built on
//! first use from the embedded time.bin.

use std::sync::OnceLock;

use crate::bindata::{self, TimeTable};

static TIME_BIN: &[u8] = include_bytes!("../assets/data/time.bin");

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wavefronts_grow_with_time_and_s_trails_p() {
        let early = ps_wave_dist(10.0, 0.0, 10_000.0);
        let late = ps_wave_dist(10.0, 0.0, 30_000.0);
        assert!(late.p_dist > early.p_dist);
        assert!(late.s_dist > early.s_dist);
        assert!(late.s_dist < late.p_dist);
        assert_eq!(ps_wave_dist(10.0, 0.0, -1000.0).s_dist.min(0.0), 0.0);
    }
}
