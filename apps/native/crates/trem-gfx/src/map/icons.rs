//! A map's icons, all in one texture with mipmaps: cells drawn once with the UI renderer,
//! and cells from PNGs. Mipmapped because icons are shown at many sizes and sampled from
//! one. What is in each cell is the app's.

use wgpu::util::DeviceExt;

use crate::render::Gpu;
#[cfg(not(target_arch = "wasm32"))]
use crate::render::{render_rgba, FontConfig, OFFSCREEN_FORMAT};
#[cfg(not(target_arch = "wasm32"))]
use crate::ui::Ui;

/// An icon of the app's sprite.
pub trait SpriteIcon: Copy + std::fmt::Debug {
    /// Its cell in the sprite.
    fn cell(self) -> u32;
    /// The size the style knew it by, which `icon-size` scales.
    fn natural(self) -> f32;
}

/// How a sprite's cells lie: `cells` squares `cell` pixels wide, `columns` to a row, each
/// with `pad` pixels around it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SpriteLayout {
    pub cell: u32,
    pub pad: u32,
    pub columns: u32,
    pub cells: u32,
}

impl SpriteLayout {
    /// The sprite's size in pixels.
    pub const fn size(&self) -> (u32, u32) {
        let step = self.cell + self.pad * 2;
        (
            self.columns * step,
            self.cells.div_ceil(self.columns) * step,
        )
    }

    /// The top left of a cell, in pixels.
    pub fn cell_origin(&self, index: u32) -> (u32, u32) {
        let step = self.cell + self.pad * 2;
        (
            (index % self.columns) * step + self.pad,
            (index / self.columns) * step + self.pad,
        )
    }

    /// u, v, width, height of a cell in the texture.
    pub fn uv_rect(&self, index: u32) -> [f32; 4] {
        let (w, h) = self.size();
        let (x, y) = self.cell_origin(index);
        [
            x as f32 / w as f32,
            y as f32 / h as f32,
            self.cell as f32 / w as f32,
            self.cell as f32 / h as f32,
        ]
    }

    /// The sprite's top level, premultiplied RGBA. `draw` paints its cells through the
    /// normal UI renderer, on a transparent target, which leaves them premultiplied, as
    /// the map's blend wants; then each PNG goes in its icon's cell.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn render<I: SpriteIcon>(
        &self,
        gpu: &Gpu,
        fonts: &FontConfig,
        draw: impl FnOnce(&mut Ui),
        pngs: &[(I, &[u8])],
    ) -> Result<Vec<u8>, String> {
        let (w, h) = self.size();
        let mut ui = Ui::new(gpu, OFFSCREEN_FORMAT, (w as f32, h as f32), 1.0, fonts)?;
        let mut atlas = render_rgba(gpu, w, h, |view, encoder| {
            ui.begin();
            draw(&mut ui);
            ui.end();
            ui.render(gpu, view, encoder, Some(wgpu::Color::TRANSPARENT));
        })?;
        for (id, png) in pngs {
            blit_png(self, &mut atlas, w, *id, png);
        }
        Ok(atlas)
    }

    /// A sprite drawn ahead, as a PNG of its top level: what a browser takes, since it
    /// cannot wait for a readback.
    pub fn from_png(&self, gpu: &Gpu, png: &[u8]) -> Result<wgpu::Texture, String> {
        let image = image::load_from_memory_with_format(png, image::ImageFormat::Png)
            .map_err(|e| format!("地圖圖示解不開：{e}"))?
            .into_rgba8();
        if image.dimensions() != self.size() {
            return Err("地圖圖示的大小不對".to_string());
        }
        Ok(self.upload(gpu, image.into_raw()))
    }

    /// The sprite with its mipmaps, on the GPU.
    pub fn upload(&self, gpu: &Gpu, atlas: Vec<u8>) -> wgpu::Texture {
        let (w, h) = self.size();
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
}

#[cfg(not(target_arch = "wasm32"))]
fn blit_png<I: SpriteIcon>(
    layout: &SpriteLayout,
    atlas: &mut [u8],
    atlas_w: u32,
    id: I,
    png: &[u8],
) {
    let Ok(image) = image::load_from_memory_with_format(png, image::ImageFormat::Png) else {
        log::warn!(target: "map", "地圖圖示解不開：{id:?}");
        return;
    };
    let rgba = image.into_rgba8();
    let (ox, oy) = layout.cell_origin(id.cell());
    let (w, h) = (
        rgba.width().min(layout.cell),
        rgba.height().min(layout.cell),
    );
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mips_run_down_to_one_pixel() {
        let (data, levels) = with_mips(vec![255; 16 * 4], 4, 4);
        assert_eq!(levels, 3);
        assert_eq!(data.len(), (16 + 4 + 1) * 4);
        assert!(data.iter().all(|v| *v == 255));
    }
}
