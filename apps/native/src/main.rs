//! TREM-Lite native. This round is the drawing core: one shared GPU device,
//! an SDF UI pass, and an offscreen screenshot path.

#[allow(dead_code)]
mod backend;
#[allow(dead_code)]
mod net;
#[allow(dead_code)]
mod paths;
mod render;
mod ui;

use std::panic::AssertUnwindSafe;
use std::path::PathBuf;

use render::{capture, Gpu, GpuSurface, OFFSCREEN_FORMAT};
use ui::{CursorKind, DebugPage, Ui};
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::window::{CursorIcon, Window, WindowId};

const HELP: &str = "\
trem-lite-native --screenshot out.png --size 1280x815 --scale 1 --page debug

  --screenshot PATH   離屏畫完就結束，不開視窗
  --size WxH          邏輯像素，預設 1280x815
  --scale N           截圖用的 DPI scale，預設 1
  --page debug        目前只移植 debug
  --preview STATE     先忽略
  --settings-tab ID   先忽略
";

struct Args {
    help: bool,
    screenshot: Option<PathBuf>,
    width: f32,
    height: f32,
    scale: f32,
    page: String,
}

fn main() {
    let args = match Args::from_env() {
        Ok(args) => args,
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(2);
        }
    };
    if args.help {
        println!("{HELP}");
        return;
    }
    init_log();
    if args.page != "debug" {
        log::error!("尚未移植：{}", args.page);
        std::process::exit(2);
    }
    let Some(gpu) = Gpu::new() else {
        std::process::exit(1);
    };
    if let Some(path) = args.screenshot.as_deref() {
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| screenshot(&gpu, &args, path)));
        match result {
            Ok(Ok((w, h))) => {
                log::info!("截圖已寫入 {}（{w}x{h}）", path.display());
            }
            Ok(Err(err)) => {
                log::error!("{err}");
                std::process::exit(1);
            }
            Err(_) => {
                log::error!("繪製發生 panic，這一幀略過");
                std::process::exit(1);
            }
        }
        return;
    }
    if let Err(err) = run_window(gpu) {
        log::error!("{err}");
        std::process::exit(1);
    }
}

fn screenshot(gpu: &Gpu, args: &Args, path: &std::path::Path) -> Result<(u32, u32), String> {
    let mut ui = Ui::new(gpu, OFFSCREEN_FORMAT, (args.width, args.height), args.scale)?;
    let mut page = DebugPage::new();
    capture(
        gpu,
        args.width,
        args.height,
        args.scale,
        path,
        |view, encoder| {
            ui.begin();
            page.draw(&mut ui, gpu);
            ui.end();
            ui.render(gpu, view, encoder);
        },
    )
}

fn run_window(gpu: Gpu) -> Result<(), String> {
    let event_loop = EventLoop::new().map_err(|err| format!("無法建立事件迴圈：{err}"))?;
    event_loop.set_control_flow(ControlFlow::Wait);
    let mut app = WindowApp {
        gpu,
        window: None,
        surface: None,
        ui: None,
        page: DebugPage::new(),
        occluded: false,
        retried_outdated: false,
        scale: 1.0,
        pointer: (-1.0e6, -1.0e6),
        mouse_down: false,
        pressed_edge: false,
        released_edge: false,
        wheel: 0.0,
        cursor: CursorKind::Default,
    };
    event_loop
        .run_app(&mut app)
        .map_err(|err| format!("事件迴圈結束：{err}"))
}

struct WindowApp {
    gpu: Gpu,
    window: Option<std::sync::Arc<Window>>,
    surface: Option<GpuSurface>,
    ui: Option<Ui>,
    page: DebugPage,
    occluded: bool,
    retried_outdated: bool,
    scale: f32,
    pointer: (f32, f32),
    mouse_down: bool,
    pressed_edge: bool,
    released_edge: bool,
    wheel: f32,
    cursor: CursorKind,
}

impl ApplicationHandler for WindowApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let attrs = Window::default_attributes()
            .with_title("TREM-Lite")
            .with_inner_size(LogicalSize::new(1280.0, 815.0))
            .with_min_inner_size(LogicalSize::new(900.0, 680.0));
        let window = match event_loop.create_window(attrs) {
            Ok(window) => std::sync::Arc::new(window),
            Err(err) => {
                log::error!("無法開視窗：{err}");
                event_loop.exit();
                return;
            }
        };
        let scale = window.scale_factor() as f32;
        let size = window.inner_size();
        self.scale = if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        };
        let logical = logical_size(size.width, size.height, self.scale);
        match self.gpu.create_surface(
            std::sync::Arc::clone(&window),
            size.width.max(1),
            size.height.max(1),
        ) {
            Ok(surface) => match Ui::new(&self.gpu, surface.format, logical, self.scale) {
                Ok(ui) => {
                    self.ui = Some(ui);
                    self.surface = Some(surface);
                    window.request_redraw();
                }
                Err(err) => {
                    log::error!("無法建立繪圖器：{err}");
                    event_loop.exit();
                }
            },
            Err(err) => {
                log::error!("無法建立 surface：{err}");
                event_loop.exit();
            }
        }
        self.window = Some(window);
    }

    fn new_events(&mut self, event_loop: &ActiveEventLoop, _cause: winit::event::StartCause) {
        event_loop.set_control_flow(ControlFlow::Wait);
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(size) => {
                let logical = logical_size(size.width, size.height, self.scale);
                if let Some(ui) = &mut self.ui {
                    ui.resize(logical, self.scale);
                }
                if size.width > 0 && size.height > 0 {
                    if let Some(surface) = &mut self.surface {
                        surface.resize(&self.gpu.device, size.width, size.height);
                    }
                    if let Some(window) = &self.window {
                        window.request_redraw();
                    }
                }
            }
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                self.scale = if scale_factor.is_finite() && scale_factor > 0.0 {
                    scale_factor as f32
                } else {
                    self.scale
                };
                if let Some(window) = &self.window {
                    let size = window.inner_size();
                    let logical = logical_size(size.width, size.height, self.scale);
                    if let Some(ui) = &mut self.ui {
                        ui.resize(logical, self.scale);
                    }
                    window.request_redraw();
                }
            }
            WindowEvent::Occluded(true) => {
                self.occluded = true;
                if let Some(ui) = &mut self.ui {
                    ui.release_atlas();
                }
            }
            WindowEvent::Occluded(false) => {
                self.occluded = false;
                if let Some(window) = &self.window {
                    window.request_redraw();
                }
            }
            WindowEvent::RedrawRequested => {
                if !self.occluded {
                    let result = std::panic::catch_unwind(AssertUnwindSafe(|| self.paint()));
                    if result.is_err() {
                        log::error!("繪製發生 panic，這一幀略過");
                    }
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                let scale = self.scale.max(0.001);
                self.pointer = (position.x as f32 / scale, position.y as f32 / scale);
            }
            WindowEvent::MouseInput { state, button, .. } => {
                if button == MouseButton::Left {
                    match state {
                        ElementState::Pressed => {
                            self.mouse_down = true;
                            self.pressed_edge = true;
                        }
                        ElementState::Released => {
                            self.mouse_down = false;
                            self.released_edge = true;
                        }
                    }
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let dy = match delta {
                    MouseScrollDelta::LineDelta(_, y) => -y * 16.0,
                    MouseScrollDelta::PixelDelta(pos) => -pos.y as f32,
                };
                if dy.is_finite() {
                    self.wheel += dy;
                }
            }
            _ => {}
        }
    }
}

impl WindowApp {
    fn paint(&mut self) {
        let Some(window) = self.window.clone() else {
            return;
        };
        let size = window.inner_size();
        if size.width == 0 || size.height == 0 || self.occluded {
            return;
        }
        let frame = match self.acquire(size.width, size.height) {
            Acquire::Frame(frame, suboptimal) => (frame, suboptimal),
            Acquire::Lost => {
                log::error!("畫面的 GPU surface 遺失：先停用這一幀並嘗試重建，其他功能照常");
                self.rebuild_surface();
                return;
            }
            Acquire::Skip => return,
        };
        let (frame, suboptimal) = frame;
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("frame"),
            });
        let scale = window.scale_factor() as f32;
        if scale.is_finite() && scale > 0.0 {
            self.scale = scale;
        }
        let logical = logical_size(size.width, size.height, self.scale);
        if let Some(ui) = &mut self.ui {
            ui.resize(logical, self.scale);
            ui.begin();
            ui.set_pointer(self.pointer.0, self.pointer.1);
            ui.set_buttons(self.mouse_down, self.pressed_edge, self.released_edge);
            ui.add_wheel(self.wheel);
            self.page.draw(ui, &self.gpu);
            ui.end();
            ui.render(&self.gpu, &view, &mut encoder);
            let cursor = ui.cursor();
            if cursor != self.cursor {
                self.cursor = cursor;
                window.set_cursor(cursor_icon(cursor));
            }
        }
        self.pressed_edge = false;
        self.released_edge = false;
        self.wheel = 0.0;
        self.gpu.queue.submit([encoder.finish()]);
        self.gpu.queue.present(frame);
        if suboptimal {
            if let Some(surface) = &self.surface {
                surface.reconfigure(&self.gpu.device);
            }
        }
    }

    fn acquire(&mut self, width: u32, height: u32) -> Acquire {
        let Some(surface) = self.surface.as_mut() else {
            self.rebuild_surface();
            return Acquire::Skip;
        };
        surface.resize(&self.gpu.device, width, height);
        match surface.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame) => {
                self.retried_outdated = false;
                Acquire::Frame(frame, false)
            }
            wgpu::CurrentSurfaceTexture::Suboptimal(frame) => {
                self.retried_outdated = false;
                Acquire::Frame(frame, true)
            }
            wgpu::CurrentSurfaceTexture::Outdated => {
                log::warn!("畫面的 GPU surface 過期：重新設定後略過這一幀");
                surface.reconfigure(&self.gpu.device);
                if !self.retried_outdated {
                    self.retried_outdated = true;
                    if let Some(window) = &self.window {
                        window.request_redraw();
                    }
                }
                Acquire::Skip
            }
            wgpu::CurrentSurfaceTexture::Lost => Acquire::Lost,
            wgpu::CurrentSurfaceTexture::Occluded => {
                self.occluded = true;
                if let Some(ui) = &mut self.ui {
                    ui.release_atlas();
                }
                Acquire::Skip
            }
            wgpu::CurrentSurfaceTexture::Timeout => {
                log::warn!("這一幀沒有拿到 surface（逾時）");
                Acquire::Skip
            }
            wgpu::CurrentSurfaceTexture::Validation => {
                log::warn!("這一幀沒有拿到 surface（驗證失敗）");
                Acquire::Skip
            }
        }
    }

    fn rebuild_surface(&mut self) {
        self.surface = None;
        let Some(window) = self.window.clone() else {
            return;
        };
        let size = window.inner_size();
        let format = match self.gpu.create_surface(
            std::sync::Arc::clone(&window),
            size.width.max(1),
            size.height.max(1),
        ) {
            Ok(surface) => {
                let format = surface.format;
                self.surface = Some(surface);
                format
            }
            Err(err) => {
                log::error!("無法重建 surface：{err}");
                return;
            }
        };
        let logical = logical_size(size.width, size.height, self.scale);
        if let Some(ui) = &mut self.ui {
            if let Err(err) = ui.recreate_pipelines(&self.gpu, format) {
                log::error!("重建繪圖器失敗：{err}");
            }
        } else {
            match Ui::new(&self.gpu, format, logical, self.scale) {
                Ok(ui) => self.ui = Some(ui),
                Err(err) => log::error!("無法建立繪圖器：{err}"),
            }
        }
        window.request_redraw();
    }
}

enum Acquire {
    Frame(wgpu::SurfaceTexture, bool),
    Lost,
    Skip,
}

fn logical_size(width: u32, height: u32, scale: f32) -> (f32, f32) {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    (width as f32 / scale, height as f32 / scale)
}

fn cursor_icon(kind: CursorKind) -> CursorIcon {
    match kind {
        CursorKind::Default => CursorIcon::Default,
        CursorKind::Pointer => CursorIcon::Pointer,
        CursorKind::Text => CursorIcon::Text,
    }
}

impl Args {
    fn from_env() -> Result<Self, String> {
        let mut args = std::env::args().skip(1);
        let mut parsed = Self {
            help: false,
            screenshot: None,
            width: 1280.0,
            height: 815.0,
            scale: 1.0,
            page: "debug".to_string(),
        };
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--help" | "-h" => parsed.help = true,
                "--screenshot" => {
                    let path = args.next().ok_or("--screenshot 需要路徑")?;
                    parsed.screenshot = Some(PathBuf::from(path));
                }
                "--size" => {
                    let value = args.next().ok_or("--size 需要 WxH")?;
                    let (w, h) = parse_size(&value).ok_or("--size 格式要是 WxH")?;
                    parsed.width = w;
                    parsed.height = h;
                }
                "--scale" => {
                    let value = args.next().ok_or("--scale 需要數字")?;
                    parsed.scale = parse_scale(&value).ok_or("--scale 要是正數")?;
                }
                "--page" => {
                    parsed.page = args.next().ok_or("--page 需要名稱")?;
                }
                "--preview" | "--settings-tab" => {
                    if args.next().is_none() {
                        return Err(format!("{arg} 需要參數"));
                    }
                }
                other => return Err(format!("不認識的參數：{other}")),
            }
        }
        Ok(parsed)
    }
}

fn parse_size(text: &str) -> Option<(f32, f32)> {
    let (w, h) = text.split_once('x').or_else(|| text.split_once('X'))?;
    let w: f32 = w.parse().ok()?;
    let h: f32 = h.parse().ok()?;
    if w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0 {
        Some((w, h))
    } else {
        None
    }
}

fn parse_scale(text: &str) -> Option<f32> {
    let scale: f32 = text.parse().ok()?;
    if scale.is_finite() && scale > 0.0 {
        Some(scale)
    } else {
        None
    }
}

fn init_log() {
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Info);
}

static LOGGER: Logger = Logger;

struct Logger;

impl log::Log for Logger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            eprintln!("[{}] {}", record.level(), record.args());
        }
    }

    fn flush(&self) {}
}
