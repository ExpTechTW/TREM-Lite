//! Shared GPU device. One `Gpu` can feed several windows and offscreen targets.
//!
//! MapLibre 5 asks for the discrete GPU by default, and on a dual-GPU laptop that
//! keeps the dGPU powered for as long as the surface exists. The integrated GPU
//! renders this UI the same, so the adapter request is `LowPower`.
//!
//! Adapter order, if the previous one cannot open a device: the normal backend,
//! then GL, then a forced software fallback. A total failure is logged and
//! returned. Callers must keep running without a window; this function does not
//! panic.

use std::sync::Arc;

use winit::window::Window;

const FRAME_LATENCY: u32 = 1;

#[cfg(not(target_arch = "wasm32"))]
type AdapterTry = fn() -> Option<(wgpu::Instance, wgpu::Adapter)>;

pub struct Gpu {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
}

pub struct GpuSurface {
    pub surface: wgpu::Surface<'static>,
    pub config: wgpu::SurfaceConfiguration,
    pub format: wgpu::TextureFormat,
}

impl Gpu {
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new() -> Option<Self> {
        let attempts: [(&str, AdapterTry); 3] = [
            ("一般", try_normal),
            ("GL", try_gl),
            ("軟體 fallback", try_software),
        ];
        for (stage, attempt) in attempts {
            if let Some(gpu) = Self::open(stage, attempt) {
                return Some(gpu);
            }
        }
        log::error!(
            "找不到可用的 GPU adapter（一般、GL、軟體 fallback 都失敗）：畫面停用，其他功能照常"
        );
        None
    }

    /// In a browser: WebGPU, asked for without blocking. WebGL2 has no storage buffers and
    /// cannot draw the UI batch, so it is not tried.
    #[cfg(target_arch = "wasm32")]
    pub async fn new_web() -> Option<Self> {
        let mut desc = wgpu::InstanceDescriptor::new_without_display_handle();
        desc.backends = wgpu::Backends::BROWSER_WEBGPU;
        let instance = wgpu::Instance::new(desc);
        let adapter = match instance.request_adapter(&adapter_options(false)).await {
            Ok(adapter) => adapter,
            Err(err) => {
                log::error!("這個瀏覽器沒有 WebGPU：{err}");
                return None;
            }
        };
        if adapter.limits().max_storage_buffers_per_shader_stage == 0 {
            log::error!("WebGPU adapter 沒有 storage buffer，畫不出 UI");
            return None;
        }
        let (device, queue) = match adapter.request_device(&device_descriptor(&adapter)).await {
            Ok(pair) => pair,
            Err(err) => {
                log::error!("WebGPU device 建立失敗：{err}");
                return None;
            }
        };
        let info = adapter.get_info();
        log::info!("GPU adapter：{}（{:?}）", info.name, info.backend);
        install_loss_handler(&device);
        Some(Self {
            instance,
            adapter,
            device,
            queue,
        })
    }

    /// Only the usual backend (Metal, Vulkan or DX12), so it can come up on another thread
    /// while the event loop does; the GL and software fallbacks stay on the main thread.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new_usual() -> Option<Self> {
        Self::open("一般", try_normal)
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn open(stage: &str, attempt: AdapterTry) -> Option<Self> {
        let Some((instance, adapter)) = attempt() else {
            log::warn!("GPU adapter 取得失敗（{stage}）");
            return None;
        };
        // The UI batch lives in a storage buffer shared by the vertex and
        // fragment stages. Adapters without that (WebGL2) cannot draw it.
        if adapter.limits().max_storage_buffers_per_shader_stage == 0 {
            log::warn!("GPU adapter 沒有 storage buffer（{stage}），略過");
            return None;
        }
        match open_device(&adapter) {
            Ok((device, queue)) => {
                let info = adapter.get_info();
                log::info!("GPU adapter：{}（{:?}，{stage}）", info.name, info.backend);
                install_loss_handler(&device);
                Some(Self {
                    instance,
                    adapter,
                    device,
                    queue,
                })
            }
            Err(err) => {
                log::warn!("GPU device 建立失敗（{stage}）：{err}");
                None
            }
        }
    }

    /// A window surface on the shared device. `window` is kept alive by the
    /// surface; the caller can hold its own `Arc` too.
    pub fn create_surface(
        &self,
        window: Arc<Window>,
        width: u32,
        height: u32,
    ) -> Result<GpuSurface, String> {
        // In a browser, straight from the window's canvas.
        #[cfg(target_arch = "wasm32")]
        let target = {
            use winit::platform::web::WindowExtWebSys;
            wgpu::SurfaceTarget::Canvas(window.canvas().ok_or("視窗沒有 canvas")?)
        };
        #[cfg(not(target_arch = "wasm32"))]
        let target = window;
        let surface = self
            .instance
            .create_surface(target)
            .map_err(|err| format!("無法建立 surface：{err}"))?;
        let caps = surface.get_capabilities(&self.adapter);
        let format =
            pick_format(&caps.formats).ok_or_else(|| "surface 沒有可用的顏色格式".to_string())?;
        if !is_gamma_unorm(format) {
            log::warn!("surface 沒有非 sRGB 格式，改用 {format:?}");
        }
        let present_mode = if caps.present_modes.contains(&wgpu::PresentMode::Fifo) {
            wgpu::PresentMode::Fifo
        } else {
            caps.present_modes
                .first()
                .copied()
                .unwrap_or(wgpu::PresentMode::AutoVsync)
        };
        let alpha_mode = caps
            .alpha_modes
            .first()
            .copied()
            .unwrap_or(wgpu::CompositeAlphaMode::Auto);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            // Unorm storage is already sRGB-encoded. `Srgb` tells the compositor
            // that; it does not gamma-encode the write a second time.
            color_space: wgpu::SurfaceColorSpace::Srgb,
            width: width.max(1),
            height: height.max(1),
            present_mode,
            desired_maximum_frame_latency: FRAME_LATENCY,
            alpha_mode,
            view_formats: vec![],
        };
        surface.configure(&self.device, &config);
        Ok(GpuSurface {
            surface,
            config,
            format,
        })
    }
}

impl Gpu {
    /// The usages for a buffer rewritten every frame.
    pub fn dynamic_usage(&self, usage: wgpu::BufferUsages) -> wgpu::BufferUsages {
        if self.writes_in_place() {
            usage | wgpu::BufferUsages::MAP_WRITE
        } else {
            usage | wgpu::BufferUsages::COPY_DST
        }
    }

    fn writes_in_place(&self) -> bool {
        self.device
            .features()
            .contains(wgpu::Features::MAPPABLE_PRIMARY_BUFFERS)
    }

    /// Write a buffer made with [`Self::dynamic_usage`]. In place where the memory is shared,
    /// waiting for a frame still using it; a queued copy elsewhere.
    pub fn write_dynamic(&self, buffer: &wgpu::Buffer, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        if !self.writes_in_place() {
            self.queue.write_buffer(buffer, 0, bytes);
            return;
        }
        let slice = buffer.slice(..bytes.len() as u64);
        slice.map_async(wgpu::MapMode::Write, |_| {});
        if let Err(err) = self.device.poll(wgpu::PollType::wait_indefinitely()) {
            log::warn!("等 GPU 完成時出錯：{err}");
        }
        match slice.get_mapped_range_mut() {
            Ok(mut range) => range.copy_from_slice(bytes),
            Err(err) => log::warn!("緩衝區寫不進去：{err}"),
        }
        buffer.unmap();
    }
}

impl GpuSurface {
    pub fn resize(&mut self, device: &wgpu::Device, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        if self.config.width == width && self.config.height == height {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(device, &self.config);
    }

    pub fn reconfigure(&self, device: &wgpu::Device) {
        self.surface.configure(device, &self.config);
    }
}

static DEVICE_LOST: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The device is gone, and every GPU call from here on does nothing.
pub fn device_lost() -> bool {
    DEVICE_LOST.load(std::sync::atomic::Ordering::SeqCst)
}

fn install_loss_handler(device: &wgpu::Device) {
    device.set_device_lost_callback(|reason, message| {
        // Dropping the device at exit reports here too.
        if reason == wgpu::DeviceLostReason::Destroyed {
            return;
        }
        log::error!("GPU device 遺失（{reason:?}）：{message}。畫面停用，其他功能照常");
        DEVICE_LOST.store(true, std::sync::atomic::Ordering::SeqCst);
    });
    device.on_uncaptured_error(Arc::new(|err| {
        log::error!("GPU 錯誤：{err}");
    }));
}

#[cfg(not(target_arch = "wasm32"))]
fn try_normal() -> Option<(wgpu::Instance, wgpu::Adapter)> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = request(&instance, false)?;
    Some((instance, adapter))
}

#[cfg(not(target_arch = "wasm32"))]
fn try_gl() -> Option<(wgpu::Instance, wgpu::Adapter)> {
    let mut desc = wgpu::InstanceDescriptor::new_without_display_handle();
    desc.backends = wgpu::Backends::GL;
    let instance = wgpu::Instance::new(desc);
    let adapter = request(&instance, false)?;
    Some((instance, adapter))
}

#[cfg(not(target_arch = "wasm32"))]
fn try_software() -> Option<(wgpu::Instance, wgpu::Adapter)> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = request(&instance, true)?;
    Some((instance, adapter))
}

fn adapter_options(force_fallback: bool) -> wgpu::RequestAdapterOptions<'static, 'static> {
    wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::LowPower,
        force_fallback_adapter: force_fallback,
        compatible_surface: None,
        apply_limit_buckets: false,
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn request(instance: &wgpu::Instance, force_fallback: bool) -> Option<wgpu::Adapter> {
    match pollster::block_on(instance.request_adapter(&adapter_options(force_fallback))) {
        Ok(adapter) => Some(adapter),
        Err(err) => {
            log::debug!("request_adapter 失敗：{err}");
            None
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn open_device(adapter: &wgpu::Adapter) -> Result<(wgpu::Device, wgpu::Queue), String> {
    pollster::block_on(adapter.request_device(&device_descriptor(adapter)))
        .map_err(|err| err.to_string())
}

fn device_descriptor(adapter: &wgpu::Adapter) -> wgpu::DeviceDescriptor<'static> {
    let supported = adapter.limits();
    let preferred = wgpu::Limits::default();
    let limits = if preferred.check_limits(&supported) {
        preferred
    } else {
        supported
    };
    // Metal's memory is shared with the CPU, so per-frame data can be written in place. A
    // copy would need a blit encoder, and on Apple GPUs the first one in a while makes the
    // driver hold about 160 MB more until the blits stop for two seconds. Measured on an
    // M4 Max in a plain Metal program: a render encoder holds 243 MB, a blit encoder 160.
    let required_features = if adapter.get_info().backend == wgpu::Backend::Metal {
        adapter.features() & wgpu::Features::MAPPABLE_PRIMARY_BUFFERS
    } else {
        wgpu::Features::empty()
    };
    wgpu::DeviceDescriptor {
        label: Some("trem-lite"),
        required_features,
        required_limits: limits,
        experimental_features: wgpu::ExperimentalFeatures::disabled(),
        memory_hints: wgpu::MemoryHints::MemoryUsage,
        trace: wgpu::Trace::Off,
    }
}

fn pick_format(formats: &[wgpu::TextureFormat]) -> Option<wgpu::TextureFormat> {
    formats
        .iter()
        .copied()
        .find(|format| is_gamma_unorm(*format))
        .or_else(|| formats.first().copied())
}

fn is_gamma_unorm(format: wgpu::TextureFormat) -> bool {
    matches!(
        format,
        wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Rgba8Unorm
    )
}

/// Offscreen targets are plain RGBA8 so a readback is a PNG without a swizzle.
#[cfg(not(target_arch = "wasm32"))]
pub const OFFSCREEN_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
