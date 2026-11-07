//! The app's shared state (lib/variable.ts, lib/variable.ui.ts). Features read and
//! write it directly, as they did `TREM.variable`; the UI draws from it each frame.

use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;

use crate::domain::types::{EewData, IntensityReport, LpgmData, ReportListItem, RtsData, Stations};

/// A map coordinate.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Coord {
    pub lon: f64,
    pub lat: f64,
}

#[derive(Default)]
pub struct Data {
    pub rts: Option<Rc<RtsData>>,
    pub intensity: Vec<Rc<IntensityReport>>,
    pub report: Vec<Rc<ReportListItem>>,
    pub eew: Vec<EewData>,
    pub lpgm: Vec<Rc<LpgmData>>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Replay {
    pub start_time: f64,
    pub local_time: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct AudioCounts {
    pub pga_1: u32,
    pub pga_2: u32,
    pub shindo_1: u32,
    pub shindo_2: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct AudioCache {
    pub shindo: i32,
    pub pga: f64,
    pub status_shindo: i32,
    pub status_pga: i32,
    pub count: AudioCounts,
}

impl Default for AudioCache {
    fn default() -> Self {
        Self {
            shindo: -1,
            pga: -1.0,
            status_shindo: 0,
            status_pga: 0,
            count: AudioCounts::default(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TriggerLocation {
    pub i: i32,
    pub name: String,
}

#[derive(Clone, Debug, Default)]
pub struct RtsTrigger {
    pub max: i32,
    pub loc: Vec<TriggerLocation>,
}

#[derive(Default)]
pub struct Bounds {
    pub rts: Vec<Coord>,
    pub intensity: Vec<Coord>,
    pub report: Vec<Coord>,
    pub lpgm: Vec<Coord>,
}

/// The predicted towns of one EEW, merged with what it reported.
#[derive(Clone, Debug, Default)]
pub struct MergedArea {
    pub max_i: i32,
    pub towns: HashMap<i32, i32>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct LastSeen {
    pub last_time: f64,
    pub serial: i64,
}

#[derive(Default)]
pub struct Cache {
    pub rts_alert: bool,
    pub unstable: f64,
    pub show_eew_box: bool,
    pub rts_trigger: RtsTrigger,
    pub last_report: Option<Rc<ReportListItem>>,
    pub eew_intensity_area: BTreeMap<String, MergedArea>,
    pub show_intensity: bool,
    pub show_lpgm: bool,
    pub eew_last: HashMap<String, LastSeen>,
    pub intensity_last: HashMap<u64, LastSeen>,
    /// The clock's calibration: server minus local, ms.
    pub time_offset: f64,
    pub intensity_time: f64,
    pub intensity_max: i32,
    pub last_data_time: f64,
    pub last_rts_alert: f64,
    pub bounds: Bounds,
    pub audio: AudioCache,
}

#[derive(Default)]
pub struct Variable {
    pub data: Data,
    /// 0 realtime (SSE), 2 replay (HTTP), 3 replay (file).
    pub play_mode: u8,
    pub replay: Replay,
    /// Hex-id stations of the rts.v1 feed.
    pub station: Option<Stations>,
    /// Decimal-id stations of the older network, still named by lpgm reports.
    pub legacy_station: Option<Stations>,
    pub cache: Cache,
    /// A test's wall clock, in place of the system's.
    #[cfg(test)]
    pub wall_override: Option<f64>,
}

impl Variable {
    /// The local clock in ms, uncalibrated.
    pub fn wall_ms(&self) -> f64 {
        #[cfg(test)]
        if let Some(ms) = self.wall_override {
            return ms;
        }
        chrono::Utc::now().timestamp_millis() as f64
    }

    /// Calibrated wall-clock time in ms.
    pub fn real_now(&self) -> f64 {
        self.wall_ms() + self.cache.time_offset
    }

    /// Replay-aware standard time: the replay's clock during a replay.
    pub fn now(&mut self) -> f64 {
        if (self.play_mode == 2 || self.play_mode == 3) && self.replay.start_time != 0.0 {
            // Anchored on the first replay tick: without it the epoch is added whole.
            if self.replay.local_time == 0.0 {
                self.replay.local_time = self.real_now();
            }
            return self.replay.start_time + (self.real_now() - self.replay.local_time);
        }
        self.real_now()
    }

    /// An earthquake still holds the map: an EEW, the 15 s after an RTS alert, an
    /// intensity or long-period overlay, or a replay.
    pub fn event_holds_map(&self) -> bool {
        if self.cache.show_lpgm || self.cache.show_intensity {
            return true;
        }
        if !self.data.eew.is_empty() {
            return true;
        }
        if self.play_mode == 2 || self.play_mode == 3 {
            return true;
        }
        self.data
            .rts
            .as_ref()
            .is_some_and(|rts| rts.time - self.cache.last_rts_alert < 15_000.0)
    }
}

/// The EEW the rotation currently wants the info box to display.
#[derive(Clone, Debug, PartialEq)]
pub struct EewDisplay {
    pub id: String,
    pub status: EewStatus,
    pub serial: i64,
    pub is_final: bool,
    pub unit_text: String,
    pub loc: String,
    pub depth: f64,
    pub mag: f64,
    pub max: i32,
    pub time: f64,
}

/// The CSS state class: eew-cancel, eew-alert, eew-warn.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EewStatus {
    Cancel,
    Alert,
    Warn,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TriggerDisplay {
    pub max: i32,
    pub locations: Vec<TriggerLocation>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CurrentStation {
    pub loc: String,
    pub i: i32,
    pub raw_i: f64,
    pub pga: f64,
}

/// Values the features compute and the overlays draw.
pub struct UiState {
    pub max_intensity: (i32, String),
    pub max_pga: f64,
    /// Coloured only while the RTS payload is in an alert state.
    pub max_pga_intensity: i32,
    pub current_station: Option<CurrentStation>,
    pub rts_level: i32,
    pub rts_trigger: i32,
    /// Each town's 60 s peak, for the bottom-right panel.
    pub rts_intensity_rows: Vec<TriggerLocation>,
    pub unstable: bool,
    pub internet_error: bool,
    /// The downloaded update waiting for a restart, or "".
    pub update_ready: String,
    pub current_eew: Option<EewDisplay>,
    pub current_trigger: Option<TriggerDisplay>,
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            max_intensity: (0, "0".to_string()),
            max_pga: 0.0,
            max_pga_intensity: 0,
            current_station: None,
            rts_level: 0,
            rts_trigger: 0,
            rts_intensity_rows: Vec::new(),
            unstable: false,
            internet_error: false,
            update_ready: String::new(),
            current_eew: None,
            current_trigger: None,
        }
    }
}
