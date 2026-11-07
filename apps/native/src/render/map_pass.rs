//! Draws the basemap and the overlays. Holds no tile data of its own; every frame it
//! binds what `TileManager` has on the GPU and moves it with one uniform per draw.

use bytemuck::{Pod, Zeroable};

use super::gpu::Gpu;
use crate::map::camera::Camera;
use crate::map::icons;
use crate::map::scene::{self, DotInstance, OverlayLineVertex, Scene, Symbol, ORIGIN};
use crate::map::tessellate::{FillVertex, LineVertex, Span};
use crate::map::tiles::{TileId, TileManager};

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

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Draw {
    origin: [f32; 2],
    scale: f32,
    extent: f32,
    color: [f32; 4],
    width: f32,
    opacity: f32,
    use_lookup: f32,
    icon_size: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct IconInstance {
    pos: [f32; 2],
    size_opacity: [f32; 2],
    rect: [f32; 4],
}

/// Premultiplied, gamma-space colour from `#rrggbb`.
const fn rgb(r: u8, g: u8, b: u8) -> [f32; 4] {
    [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, 1.0]
}

fn with_alpha(c: [u8; 4], a: f32) -> [f32; 4] {
    let alpha = a * f32::from(c[3]) / 255.0;
    [
        f32::from(c[0]) / 255.0 * alpha,
        f32::from(c[1]) / 255.0 * alpha,
        f32::from(c[2]) / 255.0 * alpha,
        alpha,
    ]
}

const LAND: [f32; 4] = rgb(0x3f, 0x40, 0x45);
const TOWN_OUTLINE: [f32; 4] = rgb(0x6a, 0x6b, 0x72);
const COUNTY_OUTLINE: [f32; 4] = rgb(0xa9, 0xb4, 0xbc);
pub const BACKGROUND: wgpu::Color = wgpu::Color {
    r: 0x1f as f64 / 255.0,
    g: 0x20 as f64 / 255.0,
    b: 0x25 as f64 / 255.0,
    a: 1.0,
};

/// MapLibre's linear `interpolate` over zoom, clamped at its ends.
fn lerp_zoom(zoom: f64, z0: f64, v0: f64, z1: f64, v1: f64) -> f32 {
    let t = ((zoom - z0) / (z1 - z0)).clamp(0.0, 1.0);
    (v0 + (v1 - v0) * t) as f32
}

/// A vertex or index buffer that only grows.
struct DynBuffer {
    buffer: Option<wgpu::Buffer>,
    capacity: u64,
    usage: wgpu::BufferUsages,
    label: &'static str,
}

impl DynBuffer {
    fn new(label: &'static str, usage: wgpu::BufferUsages) -> Self {
        Self {
            buffer: None,
            capacity: 0,
            usage,
            label,
        }
    }

    fn write(&mut self, gpu: &Gpu, bytes: &[u8]) {
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
}

#[derive(Clone, Copy, Default)]
struct Range {
    start: u32,
    count: u32,
}

struct WaveRanges {
    fill: Option<(Range, [f32; 4])>,
    p: Range,
    s: Range,
}

#[derive(Default)]
struct SymbolRanges {
    markers: Range,
    cross: Range,
    intensity: Range,
    lpgm: Range,
    report: Range,
    report_cross: Range,
}

#[derive(Default)]
struct DotRanges {
    rts: Range,
    zero: Range,
    eq: Range,
}

/// What one frame draws.
#[derive(Clone, Copy)]
pub struct MapFrame<'a> {
    pub scene: &'a Scene,
    pub camera: &'a Camera,
    pub tiles: &'a TileManager,
    pub vector_draw: &'a [TileId],
    pub dem_draw: &'a [TileId],
    pub dpr: f64,
}

/// A tile's line layer: its uniform slot, and the part of its mesh.
type LineLayer = (
    fn(&TileDraws) -> Option<u32>,
    fn(&crate::map::tiles::VectorGpu) -> Span,
);

/// The uniform slots of one vector tile's draws.
struct TileDraws {
    id: TileId,
    global: Option<u32>,
    city: Option<u32>,
    town: Option<u32>,
    town_line: Option<u32>,
    city_line: Option<u32>,
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
    dots: DynBuffer,
    dot_ranges: DotRanges,
    lines_v: DynBuffer,
    lines_i: DynBuffer,
    box_range: Range,
    eq_range: Range,
    fills_v: DynBuffer,
    fills_i: DynBuffer,
    wave_ranges: Vec<WaveRanges>,
    symbols: DynBuffer,
    symbol_ranges: SymbolRanges,
    symbol_zoom: f64,
    icon_scratch: Vec<IconInstance>,
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
    pub fn new(gpu: &Gpu, format: wgpu::TextureFormat) -> Result<Self, String> {
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
        let sprite = icons::build_sprite(gpu)?;
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
            dots: DynBuffer::new("map-dots", wgpu::BufferUsages::VERTEX),
            dot_ranges: DotRanges::default(),
            lines_v: DynBuffer::new("map-lines-v", wgpu::BufferUsages::VERTEX),
            lines_i: DynBuffer::new("map-lines-i", wgpu::BufferUsages::INDEX),
            box_range: Range::default(),
            eq_range: Range::default(),
            fills_v: DynBuffer::new("map-fills-v", wgpu::BufferUsages::VERTEX),
            fills_i: DynBuffer::new("map-fills-i", wgpu::BufferUsages::INDEX),
            wave_ranges: Vec::new(),
            symbols: DynBuffer::new("map-symbols", wgpu::BufferUsages::VERTEX),
            symbol_ranges: SymbolRanges::default(),
            symbol_zoom: f64::NAN,
            icon_scratch: Vec::new(),
        })
    }

    pub fn format(&self) -> wgpu::TextureFormat {
        self.format
    }

    fn upload_towns(&mut self, gpu: &Gpu, scene: &Scene) {
        self.lookup_pixels.fill(0);
        for (code, color) in &scene.towns {
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

    fn upload_dots(&mut self, gpu: &Gpu, scene: &Scene) {
        let mut all: Vec<DotInstance> = Vec::with_capacity(
            scene.rts_dots.len() + scene.zero_dots.len() + scene.eq_epicentres.len(),
        );
        all.extend_from_slice(&scene.rts_dots);
        all.extend_from_slice(&scene.zero_dots);
        all.extend_from_slice(&scene.eq_epicentres);
        self.dot_ranges = DotRanges {
            rts: Range {
                start: 0,
                count: scene.rts_dots.len() as u32,
            },
            zero: Range {
                start: scene.rts_dots.len() as u32,
                count: scene.zero_dots.len() as u32,
            },
            eq: Range {
                start: (scene.rts_dots.len() + scene.zero_dots.len()) as u32,
                count: scene.eq_epicentres.len() as u32,
            },
        };
        self.dots.write(gpu, bytemuck::cast_slice(&all));
    }

    fn upload_lines(&mut self, gpu: &Gpu, scene: &Scene) {
        let mut v: Vec<OverlayLineVertex> = Vec::new();
        let mut i: Vec<u32> = Vec::new();
        let mut range = |strokes: &mut dyn FnMut(&mut Vec<OverlayLineVertex>, &mut Vec<u32>)| {
            let start = i.len() as u32;
            strokes(&mut v, &mut i);
            Range {
                start,
                count: i.len() as u32 - start,
            }
        };
        self.box_range = range(&mut |v, i| {
            for stroke in &scene.boxes {
                scene::stroke_overlay(&stroke.points, stroke.color, v, i);
            }
        });
        self.eq_range = range(&mut |v, i| {
            for stroke in &scene.eq_waves {
                scene::stroke_overlay(&stroke.points, stroke.color, v, i);
            }
        });
        let mut fill_v: Vec<[f32; 2]> = Vec::new();
        let mut fill_i: Vec<u32> = Vec::new();
        self.wave_ranges.clear();
        for wave in &scene.waves {
            let p = range(&mut |v, i| {
                scene::stroke_overlay(&wave.p, crate::domain::constants::EEW_P, v, i);
            });
            let s = range(&mut |v, i| {
                scene::stroke_overlay(&wave.s, wave.s_color, v, i);
            });
            let fill = if wave.s_fill && !wave.s.is_empty() {
                let center = ring_center(&wave.s);
                let start = fill_i.len() as u32;
                scene::fan(center, &wave.s, &mut fill_v, &mut fill_i);
                Some((
                    Range {
                        start,
                        count: fill_i.len() as u32 - start,
                    },
                    with_alpha(wave.s_color, 0.25),
                ))
            } else {
                None
            };
            self.wave_ranges.push(WaveRanges { fill, p, s });
        }
        self.lines_v.write(gpu, bytemuck::cast_slice(&v));
        self.lines_i.write(gpu, bytemuck::cast_slice(&i));
        self.fills_v.write(gpu, bytemuck::cast_slice(&fill_v));
        self.fills_i.write(gpu, bytemuck::cast_slice(&fill_i));
    }

    fn push_symbols(&mut self, symbols: &[Symbol]) -> Range {
        let start = self.icon_scratch.len() as u32;
        let mut order: Vec<usize> = (0..symbols.len()).collect();
        order.sort_by(|a, b| symbols[*a].sort.total_cmp(&symbols[*b].sort));
        for at in order {
            let s = symbols[at];
            self.icon_scratch.push(icon_instance(s));
        }
        Range {
            start,
            count: self.icon_scratch.len() as u32 - start,
        }
    }

    /// `icon-allow-overlap` off: place in sort order, leaving out what would collide.
    fn push_placed(&mut self, symbols: &[Symbol], zoom: f64, icon_size: f32) -> Range {
        let start = self.icon_scratch.len() as u32;
        let mut order: Vec<usize> = (0..symbols.len()).collect();
        order.sort_by(|a, b| symbols[*a].sort.total_cmp(&symbols[*b].sort));
        let world = WORLD * 2f64.powf(zoom);
        let mut placed: Vec<(f64, f64, f64)> = Vec::new();
        for at in order {
            let s = symbols[at];
            let x = crate::map::camera::merc_x(s.lon) * world;
            let y = crate::map::camera::merc_y(s.lat) * world;
            // MapLibre's collision box: the icon plus its 2 px of icon-padding.
            let half = f64::from(s.icon.natural() * icon_size) / 2.0 + 2.0;
            let hit = placed
                .iter()
                .any(|(px, py, ph)| (x - px).abs() < half + ph && (y - py).abs() < half + ph);
            if hit {
                continue;
            }
            placed.push((x, y, half));
            self.icon_scratch.push(icon_instance(s));
        }
        Range {
            start,
            count: self.icon_scratch.len() as u32 - start,
        }
    }

    fn upload_symbols(&mut self, gpu: &Gpu, scene: &Scene, zoom: f64) {
        self.icon_scratch.clear();
        let markers = self.push_symbols(&scene.markers);
        let cross = self.push_symbols(&scene.cross);
        let square_size = lerp_zoom(zoom, 5.0, 0.3, 10.0, 0.7);
        let intensity = self.push_placed(&scene.intensity_markers, zoom, square_size);
        let lpgm = self.push_placed(&scene.lpgm_markers, zoom, square_size);
        let report = self.push_symbols(&scene.report_markers);
        let report_cross = self.push_symbols(&scene.report_cross);
        self.symbol_ranges = SymbolRanges {
            markers,
            cross,
            intensity,
            lpgm,
            report,
            report_cross,
        };
        self.symbol_zoom = zoom;
        let bytes: Vec<u8> = bytemuck::cast_slice(&self.icon_scratch).to_vec();
        self.symbols.write(gpu, &bytes);
    }

    /// Bring the GPU up to date with the scene. Only what changed is written.
    pub fn prepare(&mut self, gpu: &Gpu, scene: &mut Scene, camera: &Camera) {
        if scene.towns_dirty {
            self.upload_towns(gpu, scene);
            scene.towns_dirty = false;
        }
        if scene.dots_dirty {
            self.upload_dots(gpu, scene);
            scene.dots_dirty = false;
        }
        if scene.lines_dirty {
            self.upload_lines(gpu, scene);
            scene.lines_dirty = false;
        }
        let collides = !scene.intensity_markers.is_empty() || !scene.lpgm_markers.is_empty();
        let zoom_moved = (self.symbol_zoom - camera.zoom).abs() > 1e-3 || self.symbol_zoom.is_nan();
        if scene.symbols_dirty || (collides && zoom_moved) {
            self.upload_symbols(gpu, scene, camera.zoom);
            scene.symbols_dirty = false;
        }
    }

    fn slot(&mut self, draw: Draw) -> Option<u32> {
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

    /// Record the whole map. `dpr` turns logical pixels into physical.
    pub fn encode(
        &mut self,
        gpu: &Gpu,
        view: &wgpu::TextureView,
        encoder: &mut wgpu::CommandEncoder,
        frame: &MapFrame<'_>,
    ) {
        let MapFrame {
            scene,
            camera,
            tiles,
            vector_draw,
            dem_draw,
            dpr,
        } = *frame;
        let width = (camera.width * dpr) as f32;
        let height = (camera.height * dpr) as f32;
        gpu.write_dynamic(
            &self.globals,
            bytemuck::bytes_of(&Globals {
                viewport: [width, height],
                dpr: dpr as f32,
                zoom: camera.zoom as f32,
            }),
        );

        let world_px = WORLD * 2f64.powf(camera.zoom) * dpr;
        let tile_place = |id: TileId, extent: u32| -> ([f32; 2], f32) {
            let n = f64::from(1u32 << id.z);
            let (sx, sy) = camera.to_screen(f64::from(id.x) / n, f64::from(id.y) / n);
            (
                [(sx * dpr) as f32, (sy * dpr) as f32],
                (world_px / n / f64::from(extent)) as f32,
            )
        };
        let overlay_origin = {
            let (sx, sy) = camera.to_screen(ORIGIN.0, ORIGIN.1);
            [(sx * dpr) as f32, (sy * dpr) as f32]
        };
        let overlay = |color: [f32; 4], width: f32, opacity: f32, icon_size: f32| Draw {
            origin: overlay_origin,
            scale: world_px as f32,
            extent: 0.0,
            color,
            width,
            opacity,
            use_lookup: 0.0,
            icon_size,
        };

        self.draw_count = 0;
        // Record every draw's uniforms first, so one buffer write covers the frame.
        let mut tile_draws: Vec<TileDraws> = Vec::with_capacity(vector_draw.len());
        for &id in vector_draw {
            let Some(tile) = tiles.vector_tile(id) else {
                continue;
            };
            let (origin, scale) = tile_place(id, tile.extent);
            let base = Draw {
                origin,
                scale,
                extent: tile.extent as f32,
                color: LAND,
                width: 0.0,
                opacity: 1.0,
                use_lookup: 0.0,
                icon_size: 0.0,
            };
            tile_draws.push(TileDraws {
                id,
                global: self.slot(base),
                city: self.slot(base),
                town: self.slot(Draw {
                    use_lookup: 1.0,
                    ..base
                }),
                town_line: self.slot(Draw {
                    color: TOWN_OUTLINE,
                    width: 0.4,
                    opacity: 0.7,
                    ..base
                }),
                city_line: self.slot(Draw {
                    color: COUNTY_OUTLINE,
                    width: 1.0,
                    ..base
                }),
            });
        }
        let shade_draws: Vec<(TileId, Option<u32>)> = dem_draw
            .iter()
            .map(|&id| {
                let (origin, scale) = tile_place(id, 1);
                let slot = self.slot(Draw {
                    origin,
                    scale,
                    extent: 0.0,
                    color: [0.0; 4],
                    width: 0.0,
                    opacity: 1.0,
                    use_lookup: 0.0,
                    icon_size: 0.0,
                });
                (id, slot)
            })
            .collect();

        let zoom = camera.zoom;
        let radius = lerp_zoom(zoom, 4.0, 2.0, 12.0, 8.0);
        let badge = lerp_zoom(zoom, 5.0, 0.2, 10.0, 0.6);
        let square = lerp_zoom(zoom, 5.0, 0.3, 10.0, 0.7);
        let cross = lerp_zoom(zoom, 5.0, 0.02, 10.0, 0.1);
        let report_cross = lerp_zoom(zoom, 5.0, 0.01, 10.0, 0.09);

        let fills: Vec<(Range, Option<u32>)> = self
            .wave_ranges
            .iter()
            .filter_map(|w| w.fill)
            .collect::<Vec<_>>()
            .into_iter()
            .map(|(range, color)| (range, self.slot(overlay(color, 0.0, 1.0, 0.0))))
            .collect();
        let rts_slot = self.slot(overlay([0.0; 4], radius, scene.rts_opacity, 0.0));
        let zero_slot = self.slot(overlay([0.0; 4], radius, 1.0, 0.0));
        let markers_slot = self.slot(overlay([0.0; 4], 0.0, 1.0, badge));
        let box_slot = self.slot(overlay([0.0; 4], 2.0, 1.0, 0.0));
        let eq_slot = self.slot(overlay([0.0; 4], 2.0, 0.6, 0.0));
        let eq_dot_slot = self.slot(overlay([0.0; 4], 4.0, 0.6, 0.0));
        let square_slot = self.slot(overlay([0.0; 4], 0.0, 1.0, square));
        let report_slot = self.slot(overlay([0.0; 4], 0.0, 1.0, badge));
        let report_cross_slot = self.slot(overlay([0.0; 4], 0.0, 1.0, report_cross));
        let p_slot = self.slot(overlay([0.0; 4], 1.0, 1.0, 0.0));
        let s_slot = self.slot(overlay([0.0; 4], 2.0, 1.0, 0.0));
        let cross_slot = self.slot(overlay([0.0; 4], 0.0, 1.0, cross));

        let used = self.draw_count * self.draw_stride as usize;
        if used > 0 {
            gpu.write_dynamic(&self.draws, &self.draw_data[..used]);
        }

        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("map"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(BACKGROUND),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_bind_group(0, &self.group0, &[]);

        let draw_fill = |pass: &mut wgpu::RenderPass<'_>,
                         group1: &wgpu::BindGroup,
                         tile_draws: &[TileDraws],
                         pick: fn(&TileDraws) -> Option<u32>,
                         span: fn(&crate::map::tiles::VectorGpu) -> Span| {
            for draws in tile_draws {
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
                pass.set_bind_group(1, group1, &[slot]);
                pass.set_vertex_buffer(0, vb.slice(..));
                pass.set_index_buffer(ib.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(span.start..span.start + span.count, 0, 0..1);
            }
        };

        pass.set_pipeline(&self.fill_tile);
        draw_fill(
            &mut pass,
            &self.group1,
            &tile_draws,
            |d| d.global,
            |t| t.global,
        );

        // The S wave's fill sits beneath the county fill: it shows over the sea.
        if !fills.is_empty() {
            if let (Some(vb), Some(ib)) = (&self.fills_v.buffer, &self.fills_i.buffer) {
                pass.set_pipeline(&self.fill_overlay);
                pass.set_vertex_buffer(0, vb.slice(..));
                pass.set_index_buffer(ib.slice(..), wgpu::IndexFormat::Uint32);
                for (range, slot) in &fills {
                    if let Some(slot) = slot {
                        pass.set_bind_group(1, &self.group1, &[*slot]);
                        pass.draw_indexed(range.start..range.start + range.count, 0, 0..1);
                    }
                }
            }
        }

        pass.set_pipeline(&self.fill_tile);
        draw_fill(&mut pass, &self.group1, &tile_draws, |d| d.city, |t| t.city);
        draw_fill(&mut pass, &self.group1, &tile_draws, |d| d.town, |t| t.town);

        pass.set_pipeline(&self.shade);
        for (id, slot) in &shade_draws {
            let (Some(tile), Some(slot)) = (tiles.dem_tile(*id), slot) else {
                continue;
            };
            pass.set_bind_group(1, &self.group1, &[*slot]);
            pass.set_bind_group(2, &tile.bind, &[]);
            pass.draw(0..6, 0..1);
        }

        pass.set_pipeline(&self.line_tile);
        let lines: [LineLayer; 2] = [
            (|d| d.town_line, |t| t.town_line),
            (|d| d.city_line, |t| t.city_line),
        ];
        for (pick, span) in lines {
            for draws in &tile_draws {
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

        // Station dots and alert icons.
        if let Some(dots) = &self.dots.buffer {
            pass.set_pipeline(&self.circle);
            pass.set_vertex_buffer(0, dots.slice(..));
            if let (Some(slot), true) = (rts_slot, self.dot_ranges.rts.count > 0) {
                pass.set_bind_group(1, &self.group1, &[slot]);
                let r = self.dot_ranges.rts;
                pass.draw(0..6, r.start..r.start + r.count);
            }
            if let (Some(slot), true) = (zero_slot, self.dot_ranges.zero.count > 0) {
                pass.set_bind_group(1, &self.group1, &[slot]);
                let r = self.dot_ranges.zero;
                pass.draw(0..6, r.start..r.start + r.count);
            }
        }
        let symbols = self.symbols.buffer.as_ref();
        let draw_icons = |pass: &mut wgpu::RenderPass<'_>,
                          group1: &wgpu::BindGroup,
                          pipeline: &wgpu::RenderPipeline,
                          range: Range,
                          slot: Option<u32>| {
            let (Some(buffer), Some(slot)) = (symbols, slot) else {
                return;
            };
            if range.count == 0 {
                return;
            }
            pass.set_pipeline(pipeline);
            pass.set_vertex_buffer(0, buffer.slice(..));
            pass.set_bind_group(1, group1, &[slot]);
            pass.draw(0..6, range.start..range.start + range.count);
        };
        draw_icons(
            &mut pass,
            &self.group1,
            &self.icon,
            self.symbol_ranges.markers,
            markers_slot,
        );

        // Boxes, listed earthquakes.
        if let (Some(vb), Some(ib)) = (&self.lines_v.buffer, &self.lines_i.buffer) {
            pass.set_pipeline(&self.line_overlay);
            pass.set_vertex_buffer(0, vb.slice(..));
            pass.set_index_buffer(ib.slice(..), wgpu::IndexFormat::Uint32);
            for (range, slot) in [(self.box_range, box_slot), (self.eq_range, eq_slot)] {
                if let (Some(slot), true) = (slot, range.count > 0) {
                    pass.set_bind_group(1, &self.group1, &[slot]);
                    pass.draw_indexed(range.start..range.start + range.count, 0, 0..1);
                }
            }
        }
        if let (Some(dots), Some(slot), true) =
            (&self.dots.buffer, eq_dot_slot, self.dot_ranges.eq.count > 0)
        {
            pass.set_pipeline(&self.circle);
            pass.set_vertex_buffer(0, dots.slice(..));
            pass.set_bind_group(1, &self.group1, &[slot]);
            let r = self.dot_ranges.eq;
            pass.draw(0..6, r.start..r.start + r.count);
        }

        for (range, slot) in [
            (self.symbol_ranges.intensity, square_slot),
            (self.symbol_ranges.lpgm, square_slot),
            (self.symbol_ranges.report, report_slot),
            (self.symbol_ranges.report_cross, report_cross_slot),
        ] {
            draw_icons(&mut pass, &self.group1, &self.icon, range, slot);
        }

        // The rings of each EEW, in the order they were added.
        if let (Some(vb), Some(ib)) = (&self.lines_v.buffer, &self.lines_i.buffer) {
            pass.set_pipeline(&self.line_overlay);
            pass.set_vertex_buffer(0, vb.slice(..));
            pass.set_index_buffer(ib.slice(..), wgpu::IndexFormat::Uint32);
            for wave in &self.wave_ranges {
                for (range, slot) in [(wave.p, p_slot), (wave.s, s_slot)] {
                    if let (Some(slot), true) = (slot, range.count > 0) {
                        pass.set_bind_group(1, &self.group1, &[slot]);
                        pass.draw_indexed(range.start..range.start + range.count, 0, 0..1);
                    }
                }
            }
        }

        draw_icons(
            &mut pass,
            &self.group1,
            &self.icon,
            self.symbol_ranges.cross,
            cross_slot,
        );
    }
}

fn icon_instance(s: Symbol) -> IconInstance {
    IconInstance {
        pos: scene::rel(s.lon, s.lat),
        size_opacity: [s.icon.natural(), s.opacity],
        rect: icons::uv_rect(s.icon),
    }
}

/// The epicentre a ring grew from: the mean of its vertices is close enough for a fan.
fn ring_center(ring: &[[f64; 2]]) -> [f32; 2] {
    let n = ring.len().max(1) as f64;
    let (mut lon, mut lat) = (0.0, 0.0);
    for p in ring {
        lon += p[0];
        lat += p[1];
    }
    scene::rel(lon / n, lat / n)
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
