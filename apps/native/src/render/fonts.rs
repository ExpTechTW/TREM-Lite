//! The app's fonts, as the text engine takes them: Manrope then Noto Sans TC, matching
//! the CSS stack.

use trem_gfx::render::{FontConfig, FontMetrics};

const MANROPE: &[u8] = include_bytes!("../../assets/fonts/Manrope.ttf");
#[cfg(not(target_arch = "wasm32"))]
const NOTO: &[u8] = include_bytes!("../../assets/fonts/NotoSansTC.ttf");
/// A browser has no system fonts to fall back on: the same Noto Sans TC, cut to the app's
/// own text, the place names and Big5's common characters (web/make-font.py).
#[cfg(target_arch = "wasm32")]
const NOTO: &[u8] = include_bytes!("../../assets/fonts/web/NotoSansTC-web.ttf");
/// What the desktop takes from Apple Symbols or Segoe UI: ⁺ and ⁻ (Noto Sans), 𝖬 (Noto
/// Sans Math).
#[cfg(target_arch = "wasm32")]
const WEB_SYMBOLS: [&[u8]; 2] = [
    include_bytes!("../../assets/fonts/web/NotoSans-web.ttf"),
    include_bytes!("../../assets/fonts/web/NotoSansMath-web.ttf"),
];

#[cfg(not(target_arch = "wasm32"))]
const FACES: &[&[u8]] = &[MANROPE, NOTO];
#[cfg(target_arch = "wasm32")]
const FACES: &[&[u8]] = &[MANROPE, NOTO, WEB_SYMBOLS[0], WEB_SYMBOLS[1]];

/// Where Manrope's lines sit.
pub const METRICS: FontMetrics = FontMetrics {
    // Manrope's ascent and descent per em. Han characters fall back to Noto but share
    // Manrope's baseline.
    ascent: 1.066,
    descent: 0.3,
    // The ascent of `line-height: normal` on a line with Han, in em, and the height of
    // such a line.
    normal_ascent: 1.16,
    normal_line: 1.46,
    line_height: 1.35,
};

pub static FONTS: FontConfig = FontConfig {
    faces: FACES,
    sans: "Manrope",
    fallback: "Noto Sans TC",
    mono: None,
    // Manrope's `wght` axis. Outside it cosmic-text would pick Noto (whose OS/2 weight
    // is 100) for Latin as well.
    weights: 200..=800,
    metrics: METRICS,
    locale: "zh-TW",
};
