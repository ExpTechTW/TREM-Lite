//! The map's icons, all in one texture with mipmaps: the intensity and long-period
//! badges (domain/utils.ts `createIntensityIcon*`, there SVG) drawn once with the UI
//! renderer, and the epicentre crosses from their PNGs. Mipmapped because they are
//! shown at 12 to 100 pixels and sampled from 96.

use wgpu::util::DeviceExt;

use crate::domain::constants::{
    intensity_color, intensity_text, lpgm_color, lpgm_text, INTENSITY_LIST,
};
#[cfg(not(target_arch = "wasm32"))]
use crate::render::{render_rgba, OFFSCREEN_FORMAT};
use crate::render::{Gpu, HAlign, TextStyle, VAlign};
use crate::ui::{Color, QuadStyle, Rect, Ui};

const CELL: u32 = 96;
const PAD: u32 = 4;
const COLUMNS: u32 = 6;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IconId {
    Intensity(u8),
    IntensitySquare(u8),
    Lpgm(u8),
    Cross,
    /// `cross1` to `cross4`: which of several EEWs.
    CrossNumbered(u8),
}

impl IconId {
    /// The cell: 10 intensity, 10 square, 4 lpgm, then the 5 crosses.
    fn index(self) -> u32 {
        match self {
            Self::Intensity(i) => u32::from(i.min(9)),
            Self::IntensitySquare(i) => 10 + u32::from(i.min(9)),
            Self::Lpgm(l) => 20 + u32::from(l.clamp(1, 4)) - 1,
            Self::Cross => 24,
            Self::CrossNumbered(n) => 24 + u32::from(n.clamp(1, 4)),
        }
    }

    /// The size MapLibre knew it by, which `icon-size` scales: the SVGs are 60 px and
    /// the cross PNGs 1080.
    pub fn natural(self) -> f32 {
        match self {
            Self::Cross | Self::CrossNumbered(_) => 1080.0,
            _ => 60.0,
        }
    }
}

const CELLS: u32 = 29;

fn atlas_size() -> (u32, u32) {
    let step = CELL + PAD * 2;
    (COLUMNS * step, CELLS.div_ceil(COLUMNS) * step)
}

fn cell_origin(index: u32) -> (u32, u32) {
    let step = CELL + PAD * 2;
    (
        (index % COLUMNS) * step + PAD,
        (index / COLUMNS) * step + PAD,
    )
}

/// u, v, width, height of an icon in the texture.
pub fn uv_rect(id: IconId) -> [f32; 4] {
    let (w, h) = atlas_size();
    let (x, y) = cell_origin(id.index());
    [
        x as f32 / w as f32,
        y as f32 / h as f32,
        CELL as f32 / w as f32,
        CELL as f32 / h as f32,
    ]
}

/// One badge, in its cell. `square` is the rounded square, else the circle.
fn draw_badge(ui: &mut Ui, index: u32, label: &str, bg: Color, fg: Color, square: bool) {
    let (ox, oy) = cell_origin(index);
    let s = CELL as f32 / 60.0;
    let (x, y) = (ox as f32, oy as f32);
    // The SVG's stroke straddles its edge; a CSS border lies inside it. So the box
    // grows by half the stroke (1.5 of 60).
    let style = if square {
        // <rect x=2 y=2 w=56 h=56 rx=10 stroke-width=3>
        QuadStyle::solid(bg).radius(11.5 * s).border(3.0 * s, fg)
    } else {
        // <circle cx=30 cy=30 r=28 stroke-width=3>
        QuadStyle::solid(bg).radius(29.5 * s).border(3.0 * s, fg)
    };
    ui.quad(
        Rect::new(x + 0.5 * s, y + 0.5 * s, 59.0 * s, 59.0 * s),
        &style,
    );
    let text = TextStyle {
        size: 36.0 * s,
        weight: 700,
        h_align: HAlign::Center,
        v_align: VAlign::Middle,
        subpixel: true,
        ..TextStyle::default()
    };
    ui.text(label, x + 30.0 * s, y + 31.5 * s, fg, &text);
}

fn draw_badges(ui: &mut Ui) {
    for i in 0..10u8 {
        let label = INTENSITY_LIST[i as usize];
        let bg = intensity_color(i);
        let fg = intensity_text(i);
        draw_badge(ui, IconId::Intensity(i).index(), label, bg, fg, false);
        draw_badge(ui, IconId::IntensitySquare(i).index(), label, bg, fg, true);
    }
    for l in 1..=4u8 {
        let label = l.to_string();
        draw_badge(
            ui,
            IconId::Lpgm(l).index(),
            &label,
            lpgm_color(l),
            lpgm_text(l),
            true,
        );
    }
}

fn blit_cross(atlas: &mut [u8], atlas_w: u32, id: IconId, png: &[u8]) {
    let Ok(image) = image::load_from_memory_with_format(png, image::ImageFormat::Png) else {
        log::warn!(target: "map", "地圖圖示解不開：{id:?}");
        return;
    };
    let rgba = image.into_rgba8();
    let (ox, oy) = cell_origin(id.index());
    let (w, h) = (rgba.width().min(CELL), rgba.height().min(CELL));
    for y in 0..h {
        for x in 0..w {
            let p = rgba.get_pixel(x, y).0;
            let a = u32::from(p[3]);
            let out = [
                ((u32::from(p[0]) * a + 127) / 255) as u8,
                ((u32::from(p[1]) * a + 127) / 255) as u8,
                ((u32::from(p[2]) * a + 127) / 255) as u8,
                p[3],
            ];
            let at = (((oy + y) * atlas_w + ox + x) * 4) as usize;
            atlas[at..at + 4].copy_from_slice(&out);
        }
    }
}

/// A box-filtered chain from `base` down to 1×1, in the order the upload wants.
fn with_mips(base: Vec<u8>, width: u32, height: u32) -> (Vec<u8>, u32) {
    let mut data = base.clone();
    let mut prev = base;
    let (mut w, mut h) = (width, height);
    let mut levels = 1;
    while w > 1 || h > 1 {
        let (nw, nh) = ((w / 2).max(1), (h / 2).max(1));
        let mut next = vec![0u8; (nw * nh * 4) as usize];
        for y in 0..nh {
            for x in 0..nw {
                let mut sum = [0u32; 4];
                for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                    let sx = (x * 2 + dx).min(w - 1);
                    let sy = (y * 2 + dy).min(h - 1);
                    let at = ((sy * w + sx) * 4) as usize;
                    for (c, s) in sum.iter_mut().enumerate() {
                        *s += u32::from(prev[at + c]);
                    }
                }
                let at = ((y * nw + x) * 4) as usize;
                for c in 0..4 {
                    next[at + c] = ((sum[c] + 2) / 4) as u8;
                }
            }
        }
        data.extend_from_slice(&next);
        prev = next;
        w = nw;
        h = nh;
        levels += 1;
    }
    (data, levels)
}

/// The sprite's size in pixels.
#[cfg(test)]
pub fn sprite_size() -> (u32, u32) {
    atlas_size()
}

/// Build the sprite texture.
#[cfg(not(target_arch = "wasm32"))]
pub fn build_sprite(gpu: &Gpu) -> Result<wgpu::Texture, String> {
    Ok(upload(gpu, sprite_pixels(gpu)?))
}

/// A browser cannot wait for a readback, so it takes the sprite the desktop draws, as
/// the test that pins it keeps it: the same pixels.
#[cfg(target_arch = "wasm32")]
pub fn build_sprite(gpu: &Gpu) -> Result<wgpu::Texture, String> {
    let png = include_bytes!("../../testdata/golden/render/map-sprite.png");
    let image = image::load_from_memory_with_format(png, image::ImageFormat::Png)
        .map_err(|e| format!("地圖圖示解不開：{e}"))?
        .into_rgba8();
    if image.dimensions() != atlas_size() {
        return Err("地圖圖示的大小不對".to_string());
    }
    Ok(upload(gpu, image.into_raw()))
}

/// The sprite's top level, premultiplied RGBA. The badges draw through the normal UI
/// renderer, on a transparent target, which leaves them premultiplied, as the map's blend
/// wants.
#[cfg(not(target_arch = "wasm32"))]
pub fn sprite_pixels(gpu: &Gpu) -> Result<Vec<u8>, String> {
    let (w, h) = atlas_size();
    let mut ui = Ui::new(gpu, OFFSCREEN_FORMAT, (w as f32, h as f32), 1.0)?;
    let mut atlas = render_rgba(gpu, w, h, |view, encoder| {
        ui.begin();
        draw_badges(&mut ui);
        ui.end();
        ui.render(gpu, view, encoder, Some(wgpu::Color::TRANSPARENT));
    })?;
    let crosses: [(IconId, &[u8]); 5] = [
        (IconId::Cross, include_bytes!("../../assets/map/cross.png")),
        (
            IconId::CrossNumbered(1),
            include_bytes!("../../assets/map/cross1.png"),
        ),
        (
            IconId::CrossNumbered(2),
            include_bytes!("../../assets/map/cross2.png"),
        ),
        (
            IconId::CrossNumbered(3),
            include_bytes!("../../assets/map/cross3.png"),
        ),
        (
            IconId::CrossNumbered(4),
            include_bytes!("../../assets/map/cross4.png"),
        ),
    ];
    for (id, png) in crosses {
        blit_cross(&mut atlas, w, id, png);
    }
    Ok(atlas)
}

/// The sprite with its mipmaps, on the GPU.
fn upload(gpu: &Gpu, atlas: Vec<u8>) -> wgpu::Texture {
    let (w, h) = atlas_size();
    let (data, levels) = with_mips(atlas, w, h);
    gpu.device.create_texture_with_data(
        &gpu.queue,
        &wgpu::TextureDescriptor {
            label: Some("map-sprite"),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: levels,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        },
        wgpu::util::TextureDataOrder::MipMajor,
        &data,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_icon_has_its_own_cell_inside_the_texture() {
        let mut seen = std::collections::HashSet::new();
        let ids = (0..10)
            .map(IconId::Intensity)
            .chain((0..10).map(IconId::IntensitySquare))
            .chain((1..=4).map(IconId::Lpgm))
            .chain([IconId::Cross])
            .chain((1..=4).map(IconId::CrossNumbered));
        for id in ids {
            assert!(seen.insert(id.index()), "{id:?}");
            let [u, v, w, h] = uv_rect(id);
            assert!(u >= 0.0 && v >= 0.0 && u + w <= 1.0 && v + h <= 1.0);
        }
        assert_eq!(seen.len() as u32, CELLS);
    }

    #[test]
    fn mips_run_down_to_one_pixel() {
        let (data, levels) = with_mips(vec![255; 16 * 4], 4, 4);
        assert_eq!(levels, 3);
        assert_eq!(data.len(), (16 + 4 + 1) * 4);
        assert!(data.iter().all(|v| *v == 255));
    }
}
