//! Terrain-RGB to a baked hillshade: one RG8 texture per tile (premultiplied grey,
//! alpha). MapLibre keeps the derivatives in a texture and shades them in a fragment
//! shader on every frame. Its light never moves here, so the two shaders
//! (hillshade_prepare, hillshade's `standard_hillshade`) run once per tile, on a
//! worker, and the elevation is dropped.

use std::f32::consts::PI;

use super::camera::lat_of;

/// `hillshade-illumination-direction`, the map style's.
const DIRECTION_DEG: f32 = 335.0;
/// `hillshade-exaggeration`, the map style's.
const EXAGGERATION: f32 = 0.3;

pub struct Baked {
    pub size: u32,
    /// Grey (premultiplied) and alpha per pixel.
    pub pixels: Vec<u8>,
}

fn elevation(px: &[u8]) -> f32 {
    // getUnpackVector for Mapbox encoding, applied the way the shader applies it.
    f32::from(px[0]) * 6553.6 + f32::from(px[1]) * 25.6 + f32::from(px[2]) * 0.1 - 10000.0
}

fn bake_pixel(deriv: (f32, f32), scale_factor: f32) -> [u8; 2] {
    // hillshade_prepare stores deriv/8+0.5 clamped, which clamps it to ±4.
    let dx = deriv.0.clamp(-4.0, 4.0) / scale_factor;
    let dy = deriv.1.clamp(-4.0, 4.0) / scale_factor;
    let azimuth = DIRECTION_DEG.to_radians() + PI;
    let slope = (0.625 * dx.hypot(dy)).atan();
    let aspect = if dx != 0.0 {
        dy.atan2(-dx)
    } else {
        PI / 2.0 * if dy > 0.0 { 1.0 } else { -1.0 }
    };
    let intensity = EXAGGERATION;
    let base = 1.875 - intensity * 1.75;
    let max_value = 0.5 * PI;
    let scaled = if (intensity - 0.5).abs() > f32::EPSILON {
        ((base.powf(slope) - 1.0) / (base.powf(max_value) - 1.0)) * max_value
    } else {
        slope
    };
    let strength = (intensity * 2.0).clamp(0.0, 1.0);
    let accent_alpha = (1.0 - scaled.cos()) * strength;
    let shade = (((aspect + azimuth) / PI + 0.5).rem_euclid(2.0) - 1.0).abs();
    let shade_alpha = scaled.sin() * strength;
    // Shadow is opaque black and highlight opaque white: mix() gives grey `shade`.
    let grey = shade * shade_alpha;
    let alpha = accent_alpha * (1.0 - shade_alpha) + shade_alpha;
    [
        (grey.clamp(0.0, 1.0) * 255.0 + 0.5) as u8,
        (alpha.clamp(0.0, 1.0) * 255.0 + 0.5) as u8,
    ]
}

/// Bake one DEM tile. `rgb` is `size`×`size` RGB8. None when the size does not match.
pub fn bake(rgb: &[u8], size: u32, z: u32, y: u32) -> Option<Baked> {
    let n = size as usize;
    if rgb.len() != n * n * 3 || n < 2 {
        return None;
    }
    // Each elevation once, not nine times: every pixel reads its 3×3 neighbourhood.
    let heights: Vec<f32> = rgb.chunks_exact(3).map(elevation).collect();
    let at = |px: isize, py: isize| -> f32 {
        let x = px.clamp(0, n as isize - 1) as usize;
        let y = py.clamp(0, n as isize - 1) as usize;
        heights[y * n + x]
    };
    let zoom = z as f32;
    let factor = if zoom < 2.0 {
        0.4
    } else if zoom < 4.5 {
        0.35
    } else {
        0.3
    };
    let exaggeration = if zoom < 15.0 {
        (zoom - 15.0) * factor
    } else {
        0.0
    };
    let tile_size = size as f32;
    let scale = tile_size / 2f32.powf(exaggeration + (28.2562 - zoom));

    let tiles = 2f64.powi(z as i32);
    let lat_top = lat_of(f64::from(y) / tiles) as f32;
    let lat_bottom = lat_of(f64::from(y + 1) / tiles) as f32;

    let mut pixels = vec![0u8; n * n * 2];
    // Rows are independent: one per task, as many at once as there are cores.
    use rayon::prelude::*;
    pixels
        .par_chunks_mut(n * 2)
        .enumerate()
        .for_each(|(row, out)| {
            let py = row as isize;
            let v = (py as f32 + 0.5) / tile_size;
            // cos(radians((top - bottom) * (1 - v) + bottom))
            let scale_factor = ((lat_top - lat_bottom) * (1.0 - v) + lat_bottom)
                .to_radians()
                .cos();
            for px in 0..n as isize {
                let a = at(px - 1, py - 1);
                let b = at(px, py - 1);
                let c = at(px + 1, py - 1);
                let d = at(px - 1, py);
                let f = at(px + 1, py);
                let g = at(px - 1, py + 1);
                let h = at(px, py + 1);
                let i = at(px + 1, py + 1);
                let deriv = (
                    ((c + f + f + i) - (a + d + d + g)) * scale,
                    ((g + h + h + i) - (a + b + b + c)) * scale,
                );
                let shaded = bake_pixel(deriv, scale_factor);
                let at = px as usize * 2;
                out[at] = shaded[0];
                out[at + 1] = shaded[1];
            }
        });
    Some(Baked { size, pixels })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terrain_rgb_decodes() {
        // 10000 m of offset at 0.1 m: (0 + 10000) / 0.1 = 100000 = 0x0186A0.
        assert!(elevation(&[0x01, 0x86, 0xA0]).abs() < 0.01);
    }

    #[test]
    fn flat_ground_casts_no_shade() {
        let rgb = [0x01u8, 0x86, 0xA0].repeat(16);
        let baked = bake(&rgb, 4, 7, 55).unwrap();
        assert!(baked.pixels.iter().all(|&v| v == 0));
    }

    #[test]
    fn a_slope_facing_away_from_the_light_is_dark_and_one_facing_it_bright() {
        // Direction 335° lights from the north-west. Ground rising eastwards faces
        // west: lit. Rising westwards faces east: shadowed.
        let lit = bake_pixel((1.0, 0.0), 1.0);
        let dark = bake_pixel((-1.0, 0.0), 1.0);
        assert!(lit[1] > 0 && dark[1] > 0);
        assert!(lit[0] > dark[0], "{lit:?} vs {dark:?}");
    }

    #[test]
    fn a_wrong_size_is_refused() {
        assert!(bake(&[0; 10], 4, 7, 55).is_none());
    }
}
