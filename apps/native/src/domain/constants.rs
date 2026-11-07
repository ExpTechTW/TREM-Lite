//! Static app constants, ported from lib/constants.ts.

use crate::ui::Color;

pub const fn hex(v: u32) -> [u8; 4] {
    [(v >> 16) as u8, (v >> 8) as u8, v as u8, 255]
}

const fn to_color(c: [u8; 4]) -> Color {
    Color::rgba_u8(c[0], c[1], c[2], c[3])
}

pub const COLOR_INTENSITY: [[u8; 4]; 10] = [
    hex(0x202020),
    hex(0x003264),
    hex(0x0064c8),
    hex(0x1e9632),
    hex(0xffc800),
    hex(0xff9600),
    hex(0xff6400),
    hex(0xff0000),
    hex(0xc00000),
    hex(0x9600c8),
];
pub const COLOR_INTENSITY_TEXT: [[u8; 4]; 10] = [
    hex(0xffffff),
    hex(0xffffff),
    hex(0xffffff),
    hex(0xffffff),
    hex(0x000000),
    hex(0x000000),
    hex(0x000000),
    hex(0xffffff),
    hex(0xffffff),
    hex(0xffffff),
];
pub const COLOR_LPGM: [[u8; 4]; 5] = [
    hex(0x000000),
    hex(0x0040ff),
    hex(0xffe600),
    hex(0xff2800),
    hex(0xa50021),
];
pub const COLOR_LPGM_TEXT: [[u8; 4]; 5] = [
    hex(0xffffff),
    hex(0xffffff),
    hex(0x000000),
    hex(0xffffff),
    hex(0xffffff),
];
pub const EEW_S_WARN: [u8; 4] = hex(0xffaa00);
pub const EEW_S_ALERT: [u8; 4] = hex(0xff0000);
pub const EEW_P: [u8; 4] = hex(0x00caca);
pub const BOX_0: [u8; 4] = hex(0x00db00);
pub const BOX_1: [u8; 4] = hex(0xeac100);
pub const BOX_2: [u8; 4] = hex(0xff0000);
pub const TW_COUNTY_FILL: [u8; 4] = hex(0x3f4045);

pub fn intensity_rgba(level: i32) -> [u8; 4] {
    COLOR_INTENSITY[level.clamp(0, 9) as usize]
}

pub fn intensity_color(level: u8) -> Color {
    to_color(COLOR_INTENSITY[usize::from(level.min(9))])
}

pub fn intensity_text(level: u8) -> Color {
    to_color(COLOR_INTENSITY_TEXT[usize::from(level.min(9))])
}

pub fn lpgm_rgba(level: i32) -> [u8; 4] {
    COLOR_LPGM[level.clamp(0, 4) as usize]
}

pub fn lpgm_color(level: u8) -> Color {
    to_color(COLOR_LPGM[usize::from(level.min(4))])
}

pub fn lpgm_text(level: u8) -> Color {
    to_color(COLOR_LPGM_TEXT[usize::from(level.min(4))])
}

/// Box and wavefront colour by intensity level: green up to 1, yellow 2–3, red from 4.
pub fn level_color(level: i32) -> [u8; 4] {
    match level {
        4..=9 => BOX_2,
        2 | 3 => BOX_1,
        _ => BOX_0,
    }
}

pub const LAST_DATA_TIMEOUT_ERROR: f64 = 3000.0;
/// The EEWs this app shows: CWA's. The feed also carries other agencies'.
pub const EEW_AUTHOR: &[&str] = &["cwa"];
/// Reports in the list: the panel's length, and each full fetch's.
pub const REPORT_LIMIT: u32 = 75;

pub mod timeout {
    pub const LOOP: f64 = 1000.0;
    pub const RESOURCE: u64 = 3500;
    pub const RTS: u64 = 1000;
    pub const EEW: u64 = 1000;
    pub const REPORT: u64 = 5000;
    pub const INTENSITY: u64 = 1000;
    pub const LPGM: u64 = 1000;
}

/// map bounds of all Taiwan and the fit's padding.
pub const MAP_BOUNDS: [[f64; 2]; 2] = [[118.0, 21.2], [124.0, 25.8]];
pub const MAP_PADDING: f64 = 20.0;

/// CWA intensity labels 0..9.
pub const INTENSITY_LIST: [&str; 10] = ["0", "1", "2", "3", "4", "5⁻", "5⁺", "6⁻", "6⁺", "7"];

/// A level's label, or the number itself outside 0..9 (`INTENSITY_LIST[i] ?? String(i)`).
pub fn intensity_label(level: i32) -> String {
    usize::try_from(level)
        .ok()
        .and_then(|l| INTENSITY_LIST.get(l))
        .map_or_else(|| level.to_string(), |s| (*s).to_string())
}

/// The ExpTech hosts, by their balanced names (lib/endpoints.ts `HOST`).
pub mod host {
    pub const LB_API: &str = "api.lb.exptech.dev";
    pub const CORE_API: &str = "api.core.exptech.dev";
    /// The lpgm archive and the older station list are served only by api-1.
    pub const API_1: &str = "api-1.exptech.dev";
}
