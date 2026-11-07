//! One instanced draw per run of the same material. Quads are SDF; text and
//! images sample a texture. The instance buffer grows and is reused.

use super::gpu::Gpu;

const INSTANCE_FLOATS: usize = 56;
const INSTANCE_BYTES: u64 = (INSTANCE_FLOATS * 4) as u64;

#[repr(C, align(16))]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Instance {
    rect: [f32; 4],
    quad: [f32; 4],
    radii: [f32; 4],
    color0: [f32; 4],
    color1: [f32; 4],
    border: [f32; 4],
    shadow: [f32; 4],
    params: [f32; 4],
    shadow_off: [f32; 4],
    clip: [f32; 4],
    round_box: [f32; 4],
    round_radii: [f32; 4],
    uv: [f32; 4],
    tint: [f32; 4],
}

#[derive(Clone, Copy, Debug)]
pub struct ClipPx {
    pub aabb: [f32; 4],
    pub round_box: [f32; 4],
    pub round_radii: [f32; 4],
}

impl ClipPx {
    pub fn screen(width: f32, height: f32) -> Self {
        Self {
            aabb: [0.0, 0.0, width, height],
            round_box: [0.0; 4],
            round_radii: [0.0; 4],
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct QuadDesc {
    pub rect: [f32; 4],
    pub radii: [f32; 4],
    pub color0: [f32; 4],
    pub color1: [f32; 4],
    pub angle: f32,
    pub border_w: f32,
    pub border: [f32; 4],
    pub shadow: [f32; 4],
    pub shadow_off: [f32; 2],
    pub blur: f32,
    pub spread: f32,
    pub clip: ClipPx,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BatchKind {
    Rect,
    Text,
    Image(u32),
}

struct Batch {
    kind: BatchKind,
    start: u32,
    count: u32,
}

struct GpuImage {
    // Kept alive for the bind group. The view is what the group samples.
    _texture: wgpu::Texture,
    _view: wgpu::TextureView,
    bind: wgpu::BindGroup,
}

pub struct UiPass {
    pub format: wgpu::TextureFormat,
    group0_layout: wgpu::BindGroupLayout,
    group1_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    rect_pipeline: wgpu::RenderPipeline,
    text_pipeline: wgpu::RenderPipeline,
    image_pipeline: wgpu::RenderPipeline,
    uniform: wgpu::Buffer,
    storage: wgpu::Buffer,
    storage_cap: u64,
    group0: wgpu::BindGroup,
    instances: Vec<Instance>,
    batches: Vec<Batch>,
    images: Vec<GpuImage>,
}

impl UiPass {
    pub fn new(gpu: &Gpu, format: wgpu::TextureFormat) -> Result<Self, String> {
        let scope = gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let shader = gpu
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("ui"),
                source: wgpu::ShaderSource::Wgsl(include_str!("shaders/ui.wgsl").into()),
            });
        let group0_layout = gpu
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("ui-globals"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: wgpu::BufferSize::new(16),
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: true },
                            has_dynamic_offset: false,
                            min_binding_size: wgpu::BufferSize::new(INSTANCE_BYTES),
                        },
                        count: None,
                    },
                ],
            });
        let group1_layout = gpu
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("ui-texture"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            });
        let rect_layout = gpu
            .device
            .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("ui-rect"),
                bind_group_layouts: &[Some(&group0_layout)],
                immediate_size: 0,
            });
        let textured_layout = gpu
            .device
            .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("ui-textured"),
                bind_group_layouts: &[Some(&group0_layout), Some(&group1_layout)],
                immediate_size: 0,
            });
        let sampler = gpu.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("ui"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let rect_pipeline = pipeline(gpu, &shader, &rect_layout, format, "fs_rect");
        let text_pipeline = pipeline(gpu, &shader, &textured_layout, format, "fs_text");
        let image_pipeline = pipeline(gpu, &shader, &textured_layout, format, "fs_image");
        let err = pollster::block_on(scope.pop());
        if let Some(err) = err {
            return Err(format!("UI pipeline 建立失敗：{err}"));
        }

        let uniform = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("ui-uniform"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let storage_cap = storage_bytes(64);
        let storage = storage_buffer(gpu, storage_cap);
        let group0 = group0_bind(gpu, &group0_layout, &uniform, &storage);
        Ok(Self {
            format,
            group0_layout,
            group1_layout,
            sampler,
            rect_pipeline,
            text_pipeline,
            image_pipeline,
            uniform,
            storage,
            storage_cap,
            group0,
            instances: Vec::new(),
            batches: Vec::new(),
            images: Vec::new(),
        })
    }

    pub fn group1_layout(&self) -> &wgpu::BindGroupLayout {
        &self.group1_layout
    }

    pub fn sampler(&self) -> &wgpu::Sampler {
        &self.sampler
    }

    pub fn image_count(&self) -> usize {
        self.images.len()
    }

    pub fn begin_frame(&mut self) {
        self.instances.clear();
        self.batches.clear();
    }

    pub fn quad(&mut self, desc: &QuadDesc) {
        let rect = desc.rect;
        if rect[2] <= 0.0 || rect[3] <= 0.0 {
            return;
        }
        let (quad, shadow_a) = expand_quad(desc);
        self.push(
            BatchKind::Rect,
            Instance {
                rect,
                quad,
                radii: desc.radii,
                color0: desc.color0,
                color1: desc.color1,
                border: desc.border,
                shadow: [desc.shadow[0], desc.shadow[1], desc.shadow[2], shadow_a],
                params: [desc.border_w, desc.angle, desc.blur, desc.spread],
                shadow_off: [desc.shadow_off[0], desc.shadow_off[1], 0.0, 0.0],
                clip: desc.clip.aabb,
                round_box: desc.clip.round_box,
                round_radii: desc.clip.round_radii,
                uv: [0.0; 4],
                tint: [1.0; 4],
            },
        );
    }

    pub fn image(&mut self, id: u32, dest: [f32; 4], tint: [f32; 4], clip: ClipPx) {
        if dest[2] <= 0.0 || dest[3] <= 0.0 || self.images.get(id as usize).is_none() {
            return;
        }
        self.push(
            BatchKind::Image(id),
            textured_instance(dest, [0.0, 0.0, 1.0, 1.0], tint, clip),
        );
    }

    pub fn glyph(&mut self, dest: [f32; 4], uv: [f32; 4], tint: [f32; 4], clip: ClipPx) {
        if dest[2] <= 0.0 || dest[3] <= 0.0 {
            return;
        }
        self.push(BatchKind::Text, textured_instance(dest, uv, tint, clip));
    }

    pub fn upload_rgba(&mut self, gpu: &Gpu, width: u32, height: u32, data: &[u8]) -> Option<u32> {
        let pixels = width as usize * height as usize * 4;
        if width == 0 || height == 0 || data.len() < pixels {
            log::warn!("圖片資料長度不夠，略過");
            return None;
        }
        let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("ui-image"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &data[..pixels],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let bind = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("ui-image"),
            layout: &self.group1_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        });
        let id = self.images.len() as u32;
        self.images.push(GpuImage {
            _texture: texture,
            _view: view,
            bind,
        });
        Some(id)
    }

    pub fn encode(
        &mut self,
        gpu: &Gpu,
        view: &wgpu::TextureView,
        encoder: &mut wgpu::CommandEncoder,
        clear: wgpu::Color,
        screen: [f32; 2],
        text_bind: Option<&wgpu::BindGroup>,
    ) {
        if screen[0] < 1.0 || screen[1] < 1.0 {
            return;
        }
        if !self.instances.is_empty() {
            self.ensure_storage(gpu);
            let globals = [screen[0], screen[1], 0.0, 0.0];
            gpu.queue
                .write_buffer(&self.uniform, 0, bytemuck::cast_slice(&globals));
            gpu.queue
                .write_buffer(&self.storage, 0, bytemuck::cast_slice(&self.instances));
        }
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("ui"),
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
        for batch in &self.batches {
            match batch.kind {
                BatchKind::Rect => {
                    pass.set_pipeline(&self.rect_pipeline);
                    pass.set_bind_group(0, &self.group0, &[]);
                }
                BatchKind::Text => {
                    let Some(bind) = text_bind else {
                        continue;
                    };
                    pass.set_pipeline(&self.text_pipeline);
                    pass.set_bind_group(0, &self.group0, &[]);
                    pass.set_bind_group(1, bind, &[]);
                }
                BatchKind::Image(id) => {
                    let Some(image) = self.images.get(id as usize) else {
                        continue;
                    };
                    pass.set_pipeline(&self.image_pipeline);
                    pass.set_bind_group(0, &self.group0, &[]);
                    pass.set_bind_group(1, &image.bind, &[]);
                }
            }
            let end = batch.start + batch.count;
            pass.draw(0..6, batch.start..end);
        }
    }

    fn push(&mut self, kind: BatchKind, instance: Instance) {
        if let Some(batch) = self.batches.last_mut().filter(|batch| batch.kind == kind) {
            batch.count += 1;
        } else {
            self.batches.push(Batch {
                kind,
                start: self.instances.len() as u32,
                count: 1,
            });
        }
        self.instances.push(instance);
    }

    fn ensure_storage(&mut self, gpu: &Gpu) {
        let needed = self.instances.len() as u64 * INSTANCE_BYTES;
        if needed <= self.storage_cap {
            return;
        }
        self.storage_cap = storage_bytes(self.instances.len() as u64);
        self.storage = storage_buffer(gpu, self.storage_cap);
        self.group0 = group0_bind(gpu, &self.group0_layout, &self.uniform, &self.storage);
    }
}

fn textured_instance(dest: [f32; 4], uv: [f32; 4], tint: [f32; 4], clip: ClipPx) -> Instance {
    Instance {
        rect: dest,
        quad: dest,
        radii: [0.0; 4],
        color0: [0.0; 4],
        color1: [0.0; 4],
        border: [0.0; 4],
        shadow: [0.0; 4],
        params: [0.0; 4],
        shadow_off: [0.0; 4],
        clip: clip.aabb,
        round_box: clip.round_box,
        round_radii: clip.round_radii,
        uv,
        tint,
    }
}

fn expand_quad(desc: &QuadDesc) -> ([f32; 4], f32) {
    let mut left = 2.0f32;
    let mut right = 2.0f32;
    let mut top = 2.0f32;
    let mut bottom = 2.0f32;
    let mut shadow_a = 0.0;
    if desc.shadow[3] > 0.0 {
        shadow_a = desc.shadow[3];
        let tail = desc.blur * 2.0 + desc.spread;
        let ox = desc.shadow_off[0];
        let oy = desc.shadow_off[1];
        left = left.max(tail - ox);
        right = right.max(tail + ox);
        top = top.max(tail - oy);
        bottom = bottom.max(tail + oy);
    }
    let rect = desc.rect;
    (
        [
            rect[0] - left,
            rect[1] - top,
            rect[2] + left + right,
            rect[3] + top + bottom,
        ],
        shadow_a,
    )
}

fn storage_bytes(instances: u64) -> u64 {
    (instances.max(1) * INSTANCE_BYTES)
        .next_power_of_two()
        .max(256)
}

fn storage_buffer(gpu: &Gpu, size: u64) -> wgpu::Buffer {
    gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("ui-instances"),
        size,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

fn group0_bind(
    gpu: &Gpu,
    layout: &wgpu::BindGroupLayout,
    uniform: &wgpu::Buffer,
    storage: &wgpu::Buffer,
) -> wgpu::BindGroup {
    gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("ui-globals"),
        layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: storage.as_entire_binding(),
            },
        ],
    })
}

fn pipeline(
    gpu: &Gpu,
    shader: &wgpu::ShaderModule,
    layout: &wgpu::PipelineLayout,
    format: wgpu::TextureFormat,
    fragment: &str,
) -> wgpu::RenderPipeline {
    gpu.device
        .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(fragment),
            layout: Some(layout),
            vertex: wgpu::VertexState {
                module: shader,
                entry_point: Some("vs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: shader,
                entry_point: Some(fragment),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        })
}
