//! The realtime station dots' colours, identical to rts-image-go's station layer
//! (features/rts/palette.ts). The table is color.json, one entry per 0.1 from -3 to 7.

use super::constants::hex;

pub const RTS_PALETTE: [[u8; 4]; 101] = [
    hex(0x0000cd),
    hex(0x0007d1),
    hex(0x000ed6),
    hex(0x0015da),
    hex(0x001cdf),
    hex(0x0024e3),
    hex(0x002be7),
    hex(0x0032ec),
    hex(0x0039f0),
    hex(0x0040f5),
    hex(0x0048fa),
    hex(0x0055ee),
    hex(0x0063e3),
    hex(0x0070d8),
    hex(0x007ecd),
    hex(0x008cc2),
    hex(0x0099b7),
    hex(0x00a7ac),
    hex(0x00b4a1),
    hex(0x00c296),
    hex(0x00d08b),
    hex(0x06d482),
    hex(0x0cd879),
    hex(0x12dc71),
    hex(0x19e068),
    hex(0x1fe460),
    hex(0x25e958),
    hex(0x2ced4f),
    hex(0x32f147),
    hex(0x38f53e),
    hex(0x3ffa36),
    hex(0x4bfa31),
    hex(0x58fa2d),
    hex(0x64fb29),
    hex(0x71fb25),
    hex(0x7dfc21),
    hex(0x8afc1c),
    hex(0x97fd18),
    hex(0xa3fd14),
    hex(0xb0fe10),
    hex(0xbdff0c),
    hex(0xc3fe0a),
    hex(0xcafe09),
    hex(0xd0fe08),
    hex(0xd7fe07),
    hex(0xdeff05),
    hex(0xe4fe04),
    hex(0xebff03),
    hex(0xf1fe02),
    hex(0xf8ff01),
    hex(0xffff00),
    hex(0xfefb00),
    hex(0xfef800),
    hex(0xfef400),
    hex(0xfef100),
    hex(0xffee00),
    hex(0xfeea00),
    hex(0xffe700),
    hex(0xfee300),
    hex(0xffe000),
    hex(0xffdd00),
    hex(0xfed500),
    hex(0xfecd00),
    hex(0xfec500),
    hex(0xfebe00),
    hex(0xffb600),
    hex(0xfeae00),
    hex(0xffa700),
    hex(0xfe9f00),
    hex(0xff9700),
    hex(0xff9000),
    hex(0xfe8800),
    hex(0xfe8000),
    hex(0xfe7900),
    hex(0xfe7100),
    hex(0xff6a00),
    hex(0xfe6200),
    hex(0xff5a00),
    hex(0xfe5300),
    hex(0xff4b00),
    hex(0xff4400),
    hex(0xfe3d00),
    hex(0xfd3600),
    hex(0xfc2f00),
    hex(0xfb2800),
    hex(0xfa2100),
    hex(0xf91b00),
    hex(0xf81400),
    hex(0xf70d00),
    hex(0xf60600),
    hex(0xf50000),
    hex(0xee0000),
    hex(0xe60000),
    hex(0xdf0000),
    hex(0xd70000),
    hex(0xd00000),
    hex(0xc80000),
    hex(0xc00000),
    hex(0xb90000),
    hex(0xb10000),
    hex(0xaa0000),
];

/// MapLibre's `round`: half away from zero.
fn round_half_away(n: f64) -> f64 {
    if n < 0.0 {
        -js_round(-n)
    } else {
        js_round(n)
    }
}

/// `Math.round`: halves go up.
pub fn js_round(n: f64) -> f64 {
    (n + 0.5).floor()
}

/// Index into the palette for a measured intensity. Every quiet station lands on
/// the same blue, so noise below 0 does not count as a new picture.
pub fn rts_color_index(i: f64) -> usize {
    let scale = if i <= 0.0 {
        -3.0
    } else if i <= 1.0 {
        -3.0 + 3.0 * i
    } else {
        (7.0 * (i - 1.0)) / 6.0
    };
    let index = round_half_away(scale * 10.0) + 30.0;
    if index.is_nan() || index <= 0.0 {
        return 0;
    }
    let last = RTS_PALETTE.len() - 1;
    if index >= last as f64 {
        last
    } else {
        index as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_follow_the_table_scale() {
        assert_eq!(RTS_PALETTE.len(), 101);
        assert_eq!(rts_color_index(-3.0), 0);
        assert_eq!(rts_color_index(0.0), 0);
        // i = 1 is the table's 0, which is green, at index 30.
        assert_eq!(rts_color_index(1.0), 30);
        assert_eq!(rts_color_index(7.0), 100);
        assert_eq!(rts_color_index(100.0), 100);
    }
}
