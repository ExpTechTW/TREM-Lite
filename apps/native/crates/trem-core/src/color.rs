//! The intensity and long-period ground motion palettes (lib/constants.ts), as RGBA bytes:
//! each app makes them into the colour type it draws with.

pub const fn hex(v: u32) -> [u8; 4] {
    [(v >> 16) as u8, (v >> 8) as u8, v as u8, 255]
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

pub fn intensity_rgba(level: i32) -> [u8; 4] {
    COLOR_INTENSITY[level.clamp(0, 9) as usize]
}

pub fn lpgm_rgba(level: i32) -> [u8; 4] {
    COLOR_LPGM[level.clamp(0, 4) as usize]
}
