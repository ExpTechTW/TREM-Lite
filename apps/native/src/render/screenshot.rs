//! Offscreen target: draw, copy back, write a PNG. No window.

use std::path::Path;

use super::gpu::{Gpu, OFFSCREEN_FORMAT};

const MAX_SIDE: f32 = 8192.0;

pub fn physical_size(logical_w: f32, logical_h: f32, scale: f32) -> Result<(u32, u32), String> {
    if !(logical_w.is_finite() && logical_h.is_finite() && scale.is_finite()) || scale <= 0.0 {
        return Err("截圖尺寸不正確".to_string());
    }
    let w = (logical_w * scale).round();
    let h = (logical_h * scale).round();
    if w < 1.0 || h < 1.0 || w > MAX_SIDE || h > MAX_SIDE {
        return Err(format!("截圖尺寸不支援：{w}x{h}"));
    }
    Ok((w as u32, h as u32))
}

pub struct Offscreen {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
}

impl Offscreen {
    pub fn new(gpu: &Gpu, width: u32, height: u32) -> Result<Self, String> {
        if width == 0 || height == 0 {
            return Err("截圖尺寸是 0".to_string());
        }
        let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("screenshot"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: OFFSCREEN_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Ok(Self { texture, view })
    }

    pub fn view(&self) -> &wgpu::TextureView {
        &self.view
    }
}

/// Record `draw` into an offscreen target, read it back, and write `path`.
pub fn capture(
    gpu: &Gpu,
    logical_w: f32,
    logical_h: f32,
    scale: f32,
    path: &Path,
    draw: impl FnOnce(&wgpu::TextureView, &mut wgpu::CommandEncoder),
) -> Result<(u32, u32), String> {
    let (width, height) = physical_size(logical_w, logical_h, scale)?;
    let target = Offscreen::new(gpu, width, height)?;
    let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let unpadded = width.saturating_mul(4);
    let bytes_per_row = unpadded.div_ceil(align) * align;
    let buffer_size = u64::from(bytes_per_row) * u64::from(height);
    let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("screenshot-readback"),
        size: buffer_size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let mut encoder = gpu
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("screenshot"),
        });
    draw(target.view(), &mut encoder);
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &target.texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(bytes_per_row),
                rows_per_image: Some(height),
            },
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
    gpu.queue.submit([encoder.finish()]);

    let slice = buffer.slice(..);
    let (sender, receiver) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| {
        let _ = sender.send(result);
    });
    gpu.device
        .poll(wgpu::PollType::wait_indefinitely())
        .map_err(|err| format!("讀回截圖時等待 GPU 失敗：{err}"))?;
    match receiver.recv() {
        Ok(Ok(())) => {}
        Ok(Err(err)) => return Err(format!("讀回截圖失敗：{err}")),
        Err(_) => return Err("讀回截圖失敗：map callback 沒有回來".to_string()),
    }
    let mapped = slice
        .get_mapped_range()
        .map_err(|err| format!("讀回截圖失敗：{err}"))?;
    let row_bytes = (width * 4) as usize;
    let stride = bytes_per_row as usize;
    let mut rgba = vec![0u8; row_bytes * height as usize];
    for y in 0..height as usize {
        let src = y * stride;
        let dst = y * row_bytes;
        let src_end = src + row_bytes;
        if src_end > mapped.len() {
            return Err("讀回截圖的 buffer 比預期短".to_string());
        }
        rgba[dst..dst + row_bytes].copy_from_slice(&mapped[src..src_end]);
    }
    drop(mapped);
    buffer.unmap();

    let image = image::RgbaImage::from_raw(width, height, rgba)
        .ok_or_else(|| "截圖像素長度不對".to_string())?;
    image
        .save(path)
        .map_err(|err| format!("無法寫入截圖：{err}"))?;
    Ok((width, height))
}
