//! Draws the basemap and an app's overlays. Holds no tile data of its own; every frame it
//! binds what `TileManager` has on the GPU and moves it with one uniform per draw.
//!
//! Here are the pipelines, the per-draw uniforms, the buffers the overlays fill and the
//! draws themselves; which layers there are, and the order they go in, is the app's
//! ([`crate::map::Overlay`]).

use bytemuck::{Pod, Zeroable};

use super::gpu::Gpu;
use crate::map::camera::{merc_x, merc_y, Camera};
use crate::map::icons::{SpriteIcon, SpriteLayout};
use crate::map::scene::{self, DotInstance, OverlayLineVertex, Symbol, TownColors, ORIGIN};
use crate::map::tessellate::{FillVertex, LineVertex, Span};
use crate::map::tiles::{TileId, TileManager, VectorGpu};

/// The world's width at zoom 0, in pixels, as MapLibre has it.
const WORLD: f64 = 512.0;
/// One uniform per draw. A frame uses about six per visible tile.
const MAX_DRAWS: usize = 768;
const LOOKUP_SIDE: u32 = 32;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Globals {
    viewport: [f32; 2],
    dpr: f32,
    zoom: f32,
}

/// One draw's uniforms.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Draw {
    pub origin: [f32; 2],
    pub scale: f32,
    pub extent: f32,
    pub color: [f32; 4],
    pub width: f32,
    pub opacity: f32,
    pub use_lookup: f32,
    pub icon_size: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct IconInstance {
    pos: [f32; 2],
    size_opacity: [f32; 2],
    rect: [f32; 4],
}

/// Premultiplied, gamma-space colour from `#rrggbb`.
pub const fn rgb(r: u8, g: u8, b: u8) -> [f32; 4] {
    [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, 1.0]
}

pub fn with_alpha(c: [u8; 4], a: f32) -> [f32; 4] {
    let alpha = a * f32::from(c[3]) / 255.0;
    [
        f32::from(c[0]) / 255.0 * alpha,
        f32::from(c[1]) / 255.0 * alpha,
        f32::from(c[2]) / 255.0 * alpha,
        alpha,
    ]
}

/// MapLibre's linear `interpolate` over zoom, clamped at its ends.
pub fn lerp_zoom(zoom: f64, z0: f64, v0: f64, z1: f64, v1: f64) -> f32 {
    let t = ((zoom - z0) / (z1 - z0)).clamp(0.0, 1.0);
    (v0 + (v1 - v0) * t) as f32
}

/// A vertex or index buffer that only grows.
pub struct DynBuffer {
    buffer: Option<wgpu::Buffer>,
    capacity: u64,
    usage: wgpu::BufferUsages,
    label: &'static str,
}

impl DynBuffer {
    pub fn new(label: &'static str, usage: wgpu::BufferUsages) -> Self {
        Self {
            buffer: None,
            capacity: 0,
            usage,
            label,
        }
    }

    pub fn write(&mut self, gpu: &Gpu, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let needed = bytes.len() as u64;
        if needed > self.capacity || self.buffer.is_none() {
            let capacity = (needed * 3 / 2).max(4096);
            self.buffer = Some(gpu.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(self.label),
                size: capacity,
                usage: gpu.dynamic_usage(self.usage),
                mapped_at_creation: false,
            }));
            self.capacity = capacity;
        }
        if let Some(buffer) = &self.buffer {
            gpu.write_dynamic(buffer, bytes);
        }
    }

    /// Nothing until the first write.
    pub fn buffer(&self) -> Option<&wgpu::Buffer> {
        self.buffer.as_ref()
    }
}

/// A run of vertices, instances or indices in one buffer.
#[derive(Clone, Copy, Debug, Default)]
pub struct Range {
    pub start: u32,
    pub count: u32,
}

/// What one frame draws.
#[derive(Clone, Copy)]
pub struct MapFrame<'a> {
    pub camera: &'a Camera,
    pub tiles: &'a TileManager,
    pub vector_draw: &'a [TileId],
    pub dem_draw: &'a [TileId],
    pub dpr: f64,
}

impl MapFrame<'_> {
    /// The world's width on screen, in physical pixels.
    fn world_px(&self) -> f64 {
        WORLD * 2f64.powf(self.camera.zoom) * self.dpr
    }

    /// Where a tile's corner is, in physical pixels, and how large one of its `extent`
    /// units is.
    pub fn tile_place(&self, id: TileId, extent: u32) -> ([f32; 2], f32) {
        let n = f64::from(1u32 << id.z);
        let (sx, sy) = self
            .camera
            .to_screen(f64::from(id.x) / n, f64::from(id.y) / n);
        (
            [(sx * self.dpr) as f32, (sy * self.dpr) as f32],
            (self.world_px() / n / f64::from(extent)) as f32,
        )
    }

    /// A draw of overlay geometry, which is stored relative to [`ORIGIN`].
    pub fn overlay(&self, color: [f32; 4], width: f32, opacity: f32, icon_size: f32) -> Draw {
        let (sx, sy) = self.camera.to_screen(ORIGIN.0, ORIGIN.1);
        Draw {
            origin: [(sx * self.dpr) as f32, (sy * self.dpr) as f32],
            scale: self.world_px() as f32,
            extent: 0.0,
            color,
            width,
            opacity,
            use_lookup: 0.0,
            icon_size,
        }
    }
}

/// The uniform slots of one vector tile's draws, a slot for each part of its mesh.
pub struct TileSlots {
    pub id: TileId,
    pub global: Option<u32>,
    pub city: Option<u32>,
    pub town: Option<u32>,
    pub town_line: Option<u32>,
    pub city_line: Option<u32>,
}

/// Icon instances for one upload: each layer's symbols, as a range of one buffer.
pub struct IconBatch {
    layout: SpriteLayout,
    instances: Vec<IconInstance>,
}

impl IconBatch {
    /// For icons in a sprite laid out as `layout`.
    pub fn new(layout: SpriteLayout) -> Self {
        Self {
            layout,
            instances: Vec::new(),
        }
    }

    pub fn clear(&mut self) {
        self.instances.clear();
    }

    fn instance<I: SpriteIcon>(&self, s: &Symbol<I>) -> IconInstance {
        IconInstance {
            pos: scene::rel(s.lon, s.lat),
            size_opacity: [s.icon.natural(), s.opacity],
            rect: self.layout.uv_rect(s.icon.cell()),
        }
    }

    /// Every symbol, in sort order: `icon-allow-overlap`.
    pub fn push<I: SpriteIcon>(&mut self, symbols: &[Symbol<I>]) -> Range {
        let start = self.instances.len() as u32;
        let mut order: Vec<usize> = (0..symbols.len()).collect();
        order.sort_by(|a, b| symbols[*a].sort.total_cmp(&symbols[*b].sort));
        for at in order {
            let instance = self.instance(&symbols[at]);
            self.instances.push(instance);
        }
        Range {
            start,
            count: self.instances.len() as u32 - start,
        }
    }

    /// `icon-allow-overlap` off: place in sort order, leaving out what would collide.
    pub fn push_placed<I: SpriteIcon>(
        &mut self,
        symbols: &[Symbol<I>],
        zoom: f64,
        icon_size: f32,
    ) -> Range {
        let start = self.instances.len() as u32;
        let mut order: Vec<usize> = (0..symbols.len()).collect();
        order.sort_by(|a, b| symbols[*a].sort.total_cmp(&symbols[*b].sort));
        let world = WORLD * 2f64.powf(zoom);
        let mut placed: Vec<(f64, f64, f64)> = Vec::new();
        for at in order {
            let s = &symbols[at];
            let x = merc_x(s.lon) * world;
            let y = merc_y(s.lat) * world;
            // MapLibre's collision box: the icon plus its 2 px of icon-padding.
            let half = f64::from(s.icon.natural() * icon_size) / 2.0 + 2.0;
            let hit = placed
                .iter()
                .any(|(px, py, ph)| (x - px).abs() < half + ph && (y - py).abs() < half + ph);
            if hit {
                continue;
            }
            placed.push((x, y, half));
            let instance = self.instance(s);
            self.instances.push(instance);
        }
        Range {
            start,
            count: self.instances.len() as u32 - start,
        }
    }

    /// Write them all to `buffer`.
    pub fn upload(&self, gpu: &Gpu, buffer: &mut DynBuffer) {
        buffer.write(gpu, bytemuck::cast_slice(&self.instances));
    }
}

pub struct MapPass {
    format: wgpu::TextureFormat,
    pub shade_layout: wgpu::BindGroupLayout,
    group0: wgpu::BindGroup,
    group1: wgpu::BindGroup,
    globals: wgpu::Buffer,
    draws: wgpu::Buffer,
    draw_stride: u64,
    draw_data: Vec<u8>,
    draw_count: usize,
    lookup: wgpu::Texture,
    lookup_pixels: Vec<u8>,
    fill_tile: wgpu::RenderPipeline,
    fill_overlay: wgpu::RenderPipeline,
    line_tile: wgpu::RenderPipeline,
    line_overlay: wgpu::RenderPipeline,
    shade: wgpu::RenderPipeline,
    circle: wgpu::RenderPipeline,
    icon: wgpu::RenderPipeline,
}

fn alpha_target(format: wgpu::TextureFormat) -> [Option<wgpu::ColorTargetState>; 1] {
    [Some(wgpu::ColorTargetState {
        format,
        blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
        write_mask: wgpu::ColorWrites::ALL,
    })]
}

struct PipelineSpec<'a> {
    label: &'static str,
    vs: &'static str,
    fs: &'static str,
    layout: &'a wgpu::PipelineLayout,
    buffers: &'a [Option<wgpu::VertexBufferLayout<'a>>],
}

fn pipeline(
    gpu: &Gpu,
    shader: &wgpu::ShaderModule,
    format: wgpu::TextureFormat,
    spec: PipelineSpec<'_>,
) -> wgpu::RenderPipeline {
    gpu.device
        .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(spec.label),
            layout: Some(spec.layout),
            vertex: wgpu::VertexState {
                module: shader,
                entry_point: Some(spec.vs),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: spec.buffers,
            },
            fragment: Some(wgpu::FragmentState {
                module: shader,
                entry_point: Some(spec.fs),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &alpha_target(format),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        })
}

impl MapPass {
    /// The pipelines for `format`, with `sprite` as the icons' texture.
    pub fn new(
        gpu: &Gpu,
        format: wgpu::TextureFormat,
        sprite: &wgpu::Texture,
    ) -> Result<Self, String> {
        let scope = gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let shader = gpu
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("map"),
                source: wgpu::ShaderSource::Wgsl(include_str!("shaders/map.wgsl").into()),
            });
        let texture_entry = |binding, filterable| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let layout0 = gpu
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("map-globals"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: wgpu::BufferSize::new(
                                std::mem::size_of::<Globals>() as u64
                            ),
                        },
                        count: None,
                    },
                    texture_entry(1, false),
                    texture_entry(2, true),
                    wgpu::BindGroupLayoutEntry {
                        binding: 3,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            });
        let layout1 = gpu
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("map-draw"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: true,
                        min_binding_size: wgpu::BufferSize::new(std::mem::size_of::<Draw>() as u64),
                    },
                    count: None,
                }],
            });
        let shade_layout = gpu
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("map-shade"),
                entries: &[texture_entry(0, true)],
            });

        let base_layout = gpu
            .device
            .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("map"),
                bind_group_layouts: &[Some(&layout0), Some(&layout1)],
                immediate_size: 0,
            });
        let shade_pipeline_layout =
            gpu.device
                .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("map-shade"),
                    bind_group_layouts: &[Some(&layout0), Some(&layout1), Some(&shade_layout)],
                    immediate_size: 0,
                });

        let fill_vb = wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<FillVertex>() as u64,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &wgpu::vertex_attr_array![0 => Sint16x2, 1 => Uint16x2],
        };
        let line_vb = wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<LineVertex>() as u64,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &wgpu::vertex_attr_array![0 => Sint16x2, 1 => Sint8x4],
        };
        let overlay_fill_vb = wgpu::VertexBufferLayout {
            array_stride: 8,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &wgpu::vertex_attr_array![0 => Float32x2],
        };
        let overlay_line_vb = wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<OverlayLineVertex>() as u64,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &wgpu::vertex_attr_array![0 => Float32x2, 1 => Sint8x4, 2 => Unorm8x4],
        };
        let dot_vb = wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<DotInstance>() as u64,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &wgpu::vertex_attr_array![0 => Float32x2, 1 => Unorm8x4],
        };
        let icon_vb = wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<IconInstance>() as u64,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2, 2 => Float32x4],
        };

        let make = |label, vs, fs, buffers: &[Option<wgpu::VertexBufferLayout<'_>>]| {
            pipeline(
                gpu,
                &shader,
                format,
                PipelineSpec {
                    label,
                    vs,
                    fs,
                    layout: &base_layout,
                    buffers,
                },
            )
        };
        let fill_tile = make("fill-tile", "vs_fill_tile", "fs_fill", &[Some(fill_vb)]);
        let fill_overlay = make(
            "fill-overlay",
            "vs_fill_overlay",
            "fs_fill",
            &[Some(overlay_fill_vb)],
        );
        let line_tile = make("line-tile", "vs_line_tile", "fs_line", &[Some(line_vb)]);
        let line_overlay = make(
            "line-overlay",
            "vs_line_overlay",
            "fs_line",
            &[Some(overlay_line_vb)],
        );
        let circle = make("circle", "vs_circle", "fs_circle", &[Some(dot_vb)]);
        let icon = make("icon", "vs_icon", "fs_icon", &[Some(icon_vb)]);
        let shade = pipeline(
            gpu,
            &shader,
            format,
            PipelineSpec {
                label: "shade",
                vs: "vs_shade",
                fs: "fs_shade",
                layout: &shade_pipeline_layout,
                buffers: &[],
            },
        );

        // A browser cannot wait here: its answer arrives later, and is logged.
        #[cfg(target_arch = "wasm32")]
        {
            let popped = scope.pop();
            trem_io::exec::spawn(async move {
                if let Some(err) = popped.await {
                    log::error!(target: "map", "地圖 pipeline 建立失敗：{err}");
                }
            });
        }
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(err) = pollster::block_on(scope.pop()) {
            return Err(format!("地圖 pipeline 建立失敗：{err}"));
        }

        let globals = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("map-globals"),
            size: std::mem::size_of::<Globals>() as u64,
            usage: gpu.dynamic_usage(wgpu::BufferUsages::UNIFORM),
            mapped_at_creation: false,
        });
        let align = u64::from(gpu.device.limits().min_uniform_buffer_offset_alignment);
        let draw_stride = (std::mem::size_of::<Draw>() as u64).div_ceil(align) * align;
        let draws = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("map-draws"),
            size: draw_stride * MAX_DRAWS as u64,
            usage: gpu.dynamic_usage(wgpu::BufferUsages::UNIFORM),
            mapped_at_creation: false,
        });
        let lookup = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("town-colours"),
            size: wgpu::Extent3d {
                width: LOOKUP_SIDE,
                height: LOOKUP_SIDE,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let sampler = gpu.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("map"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });
        let group0 = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("map-globals"),
            layout: &layout0,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: globals.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(
                        &lookup.create_view(&wgpu::TextureViewDescriptor::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(
                        &sprite.create_view(&wgpu::TextureViewDescriptor::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });
        let group1 = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("map-draw"),
            layout: &layout1,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &draws,
                    offset: 0,
                    size: wgpu::BufferSize::new(std::mem::size_of::<Draw>() as u64),
                }),
            }],
        });
        Ok(Self {
            format,
            shade_layout,
            group0,
            group1,
            globals,
            draws,
            draw_stride,
            draw_data: vec![0; (draw_stride * MAX_DRAWS as u64) as usize],
            draw_count: 0,
            lookup,
            lookup_pixels: vec![0; (LOOKUP_SIDE * LOOKUP_SIDE * 4) as usize],
            fill_tile,
            fill_overlay,
            line_tile,
            line_overlay,
            shade,
            circle,
            icon,
        })
    }

    pub fn format(&self) -> wgpu::TextureFormat {
        self.format
    }

    /// Colour the towns by code (`paintTowns`): a lookup texture the town fill samples.
    pub fn upload_towns(&mut self, gpu: &Gpu, towns: &TownColors) {
        self.lookup_pixels.fill(0);
        for (code, color) in towns {
            if *code >= LOOKUP_SIDE * LOOKUP_SIDE {
                continue;
            }
            let at = (*code * 4) as usize;
            let c = with_alpha(*color, 1.0);
            for (i, v) in c.iter().enumerate() {
                self.lookup_pixels[at + i] = (v * 255.0 + 0.5) as u8;
            }
        }
        gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.lookup,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &self.lookup_pixels,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(LOOKUP_SIDE * 4),
                rows_per_image: Some(LOOKUP_SIDE),
            },
            wgpu::Extent3d {
                width: LOOKUP_SIDE,
                height: LOOKUP_SIDE,
                depth_or_array_layers: 1,
            },
        );
    }

    /// Start a frame: its globals, and no draws yet.
    pub fn begin_frame(&mut self, gpu: &Gpu, frame: &MapFrame<'_>) {
        let camera = frame.camera;
        let width = (camera.width * frame.dpr) as f32;
        let height = (camera.height * frame.dpr) as f32;
        gpu.write_dynamic(
            &self.globals,
            bytemuck::bytes_of(&Globals {
                viewport: [width, height],
                dpr: frame.dpr as f32,
                zoom: camera.zoom as f32,
            }),
        );
        self.draw_count = 0;
    }

    /// A uniform slot for one draw this frame, by its offset. None past the frame's limit.
    pub fn slot(&mut self, draw: Draw) -> Option<u32> {
        if self.draw_count >= MAX_DRAWS {
            log::warn!(target: "map", "這一幀的繪製數超過上限，略過多的部分");
            return None;
        }
        let offset = self.draw_count as u64 * self.draw_stride;
        let at = offset as usize;
        let bytes = bytemuck::bytes_of(&draw);
        self.draw_data[at..at + bytes.len()].copy_from_slice(bytes);
        self.draw_count += 1;
        Some(offset as u32)
    }

    /// Write every draw's uniforms at once, once the frame's slots are taken.
    pub fn write_draws(&self, gpu: &Gpu) {
        let used = self.draw_count * self.draw_stride as usize;
        if used > 0 {
            gpu.write_dynamic(&self.draws, &self.draw_data[..used]);
        }
    }

    /// The frame's render pass, cleared to `clear`.
    pub fn begin_pass<'e>(
        &self,
        encoder: &'e mut wgpu::CommandEncoder,
        view: &wgpu::TextureView,
        clear: wgpu::Color,
    ) -> wgpu::RenderPass<'e> {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("map"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(clear),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_bind_group(0, &self.group0, &[]);
        pass
    }

    /// One fill layer of the vector tiles: `span` picks the part of each mesh, `pick` its
    /// slot.
    pub fn draw_tile_fills(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        tiles: &TileManager,
        slots: &[TileSlots],
        pick: fn(&TileSlots) -> Option<u32>,
        span: fn(&VectorGpu) -> Span,
    ) {
        pass.set_pipeline(&self.fill_tile);
        for draws in slots {
            let Some(tile) = tiles.vector_tile(draws.id) else {
                continue;
            };
            let (Some(vb), Some(ib), Some(slot)) = (&tile.fill_vb, &tile.fill_ib, pick(draws))
            else {
                continue;
            };
            let span = span(tile);
            if span.count == 0 {
                continue;
            }
            pass.set_bind_group(1, &self.group1, &[slot]);
            pass.set_vertex_buffer(0, vb.slice(..));
            pass.set_index_buffer(ib.slice(..), wgpu::IndexFormat::Uint32);
            pass.draw_indexed(span.start..span.start + span.count, 0, 0..1);
        }
    }

    /// One line layer of the vector tiles, as [`Self::draw_tile_fills`].
    pub fn draw_tile_lines(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        tiles: &TileManager,
        slots: &[TileSlots],
        pick: fn(&TileSlots) -> Option<u32>,
        span: fn(&VectorGpu) -> Span,
    ) {
        pass.set_pipeline(&self.line_tile);
        for draws in slots {
            let Some(tile) = tiles.vector_tile(draws.id) else {
                continue;
            };
            let (Some(vb), Some(ib), Some(slot)) = (&tile.line_vb, &tile.line_ib, pick(draws))
            else {
                continue;
            };
            let span = span(tile);
            if span.count == 0 {
                continue;
            }
            pass.set_bind_group(1, &self.group1, &[slot]);
            pass.set_vertex_buffer(0, vb.slice(..));
            pass.set_index_buffer(ib.slice(..), wgpu::IndexFormat::Uint32);
            pass.draw_indexed(span.start..span.start + span.count, 0, 0..1);
        }
    }

    /// The hillshade of each DEM tile.
    pub fn draw_shade(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        tiles: &TileManager,
        draws: impl IntoIterator<Item = (TileId, Option<u32>)>,
    ) {
        pass.set_pipeline(&self.shade);
        for (id, slot) in draws {
            let (Some(tile), Some(slot)) = (tiles.dem_tile(id), slot) else {
                continue;
            };
            pass.set_bind_group(1, &self.group1, &[slot]);
            pass.set_bind_group(2, &tile.bind, &[]);
            pass.draw(0..6, 0..1);
        }
    }

    /// Overlay fills: triangles of `[f32; 2]` positions relative to [`ORIGIN`].
    pub fn draw_fills(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        vertices: &DynBuffer,
        indices: &DynBuffer,
        fills: impl IntoIterator<Item = (Range, Option<u32>)>,
    ) {
        let (Some(vb), Some(ib)) = (vertices.buffer(), indices.buffer()) else {
            return;
        };
        pass.set_pipeline(&self.fill_overlay);
        pass.set_vertex_buffer(0, vb.slice(..));
        pass.set_index_buffer(ib.slice(..), wgpu::IndexFormat::Uint32);
        for (range, slot) in fills {
            if let Some(slot) = slot {
                pass.set_bind_group(1, &self.group1, &[slot]);
                pass.draw_indexed(range.start..range.start + range.count, 0, 0..1);
            }
        }
    }

    /// Overlay lines: [`OverlayLineVertex`] strips, as `stroke_overlay` makes them.
    pub fn draw_lines(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        vertices: &DynBuffer,
        indices: &DynBuffer,
        lines: impl IntoIterator<Item = (Range, Option<u32>)>,
    ) {
        let (Some(vb), Some(ib)) = (vertices.buffer(), indices.buffer()) else {
            return;
        };
        pass.set_pipeline(&self.line_overlay);
        pass.set_vertex_buffer(0, vb.slice(..));
        pass.set_index_buffer(ib.slice(..), wgpu::IndexFormat::Uint32);
        for (range, slot) in lines {
            if let (Some(slot), true) = (slot, range.count > 0) {
                pass.set_bind_group(1, &self.group1, &[slot]);
                pass.draw_indexed(range.start..range.start + range.count, 0, 0..1);
            }
        }
    }

    /// Circles, one a [`DotInstance`].
    pub fn draw_dots(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        dots: &DynBuffer,
        ranges: impl IntoIterator<Item = (Range, Option<u32>)>,
    ) {
        let Some(buffer) = dots.buffer() else {
            return;
        };
        pass.set_pipeline(&self.circle);
        pass.set_vertex_buffer(0, buffer.slice(..));
        for (range, slot) in ranges {
            if let (Some(slot), true) = (slot, range.count > 0) {
                pass.set_bind_group(1, &self.group1, &[slot]);
                pass.draw(0..6, range.start..range.start + range.count);
            }
        }
    }

    /// Icons from the sprite, as an [`IconBatch`] wrote them.
    pub fn draw_icons(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        icons: &DynBuffer,
        range: Range,
        slot: Option<u32>,
    ) {
        let (Some(buffer), Some(slot)) = (icons.buffer(), slot) else {
            return;
        };
        if range.count == 0 {
            return;
        }
        pass.set_pipeline(&self.icon);
        pass.set_vertex_buffer(0, buffer.slice(..));
        pass.set_bind_group(1, &self.group1, &[slot]);
        pass.draw(0..6, range.start..range.start + range.count);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zoom_functions_clamp_at_their_ends() {
        assert_eq!(lerp_zoom(4.0, 5.0, 0.2, 10.0, 0.6), 0.2);
        assert_eq!(lerp_zoom(12.0, 5.0, 0.2, 10.0, 0.6), 0.6);
        assert!((lerp_zoom(7.5, 5.0, 0.2, 10.0, 0.6) - 0.4).abs() < 1e-6);
    }

    #[test]
    fn colours_come_out_premultiplied() {
        let c = with_alpha([255, 0, 0, 255], 0.25);
        assert!((c[0] - 0.25).abs() < 1e-6 && (c[3] - 0.25).abs() < 1e-6);
    }
}
