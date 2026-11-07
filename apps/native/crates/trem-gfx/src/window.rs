//! A window and what it takes to draw it: its surface, the pointer as the UI wants it,
//! and the events every window handles alike. The app's event loop owns the windows.

use std::sync::Arc;

use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::window::{CursorIcon, Window};

use crate::render::{Gpu, GpuSurface};
use crate::ui::{CursorKind, InputState};

/// One window and what it takes to draw it.
pub struct Win {
    pub window: Arc<Window>,
    pub surface: Option<GpuSurface>,
    pub input: InputState,
    pub occluded: bool,
    pub pointer: (f32, f32),
    pub mouse_down: bool,
    pub pressed_edge: bool,
    pub released_edge: bool,
    pub wheel: f32,
    pub cursor: CursorIcon,
    pub retried_outdated: bool,
    /// Something it shows has changed.
    pub dirty: bool,
}

impl Win {
    pub fn new(window: Window) -> Self {
        Self {
            window: Arc::new(window),
            surface: None,
            input: InputState::default(),
            occluded: false,
            pointer: (-1.0e6, -1.0e6),
            mouse_down: false,
            pressed_edge: false,
            released_edge: false,
            wheel: 0.0,
            cursor: CursorIcon::Default,
            retried_outdated: false,
            dirty: true,
        }
    }

    /// Pixels per logical point, for drawing.
    pub fn scale(&self) -> f32 {
        // In a browser, what the canvas really holds over its CSS size: the logical size is
        // then the CSS size whatever the browser reports as its pixel ratio.
        #[cfg(target_arch = "wasm32")]
        {
            use winit::platform::web::WindowExtWebSys;
            let css = self.window.canvas().map_or(0, |c| c.client_width());
            let physical = self.window.inner_size().width;
            if css > 0 && physical > 0 {
                return physical as f32 / css as f32;
            }
        }
        self.input_scale()
    }

    /// Pixels per logical point in the positions winit reports for input.
    pub fn input_scale(&self) -> f32 {
        let scale = self.window.scale_factor() as f32;
        if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        }
    }

    pub fn logical(&self) -> (f32, f32) {
        let size = self.window.inner_size();
        let scale = self.scale();
        (size.width as f32 / scale, size.height as f32 / scale)
    }

    /// The button's state and this frame's press, release and wheel, which it clears.
    pub fn take_edges(&mut self) -> (bool, bool, bool, f32) {
        let edges = (
            self.mouse_down,
            self.pressed_edge,
            self.released_edge,
            self.wheel,
        );
        self.pressed_edge = false;
        self.released_edge = false;
        self.wheel = 0.0;
        edges
    }
}

/// A window's next frame, or a reason to draw nothing now.
pub enum Acquire {
    Frame(wgpu::SurfaceTexture, bool),
    Skip,
}

/// The window's next frame. Makes the surface on first use and after it was lost, and
/// follows the window's size; `true` with a frame is a suboptimal one.
pub fn acquire(gpu: &Gpu, win: &mut Win) -> Acquire {
    let size = win.window.inner_size();
    if size.width == 0 || size.height == 0 {
        return Acquire::Skip;
    }
    if win.surface.is_none() {
        match gpu.create_surface(Arc::clone(&win.window), size.width, size.height) {
            Ok(surface) => win.surface = Some(surface),
            Err(err) => {
                log::error!(target: "window", "無法建立 surface：{err}");
                return Acquire::Skip;
            }
        }
    }
    let Some(surface) = win.surface.as_mut() else {
        return Acquire::Skip;
    };
    surface.resize(&gpu.device, size.width, size.height);
    match surface.surface.get_current_texture() {
        wgpu::CurrentSurfaceTexture::Success(frame) => {
            win.retried_outdated = false;
            Acquire::Frame(frame, false)
        }
        wgpu::CurrentSurfaceTexture::Suboptimal(frame) => {
            win.retried_outdated = false;
            Acquire::Frame(frame, true)
        }
        wgpu::CurrentSurfaceTexture::Outdated => {
            surface.reconfigure(&gpu.device);
            if !win.retried_outdated {
                win.retried_outdated = true;
                win.window.request_redraw();
            }
            Acquire::Skip
        }
        wgpu::CurrentSurfaceTexture::Lost => {
            log::error!(target: "window", "畫面的 GPU surface 遺失：重建，其他功能照常");
            win.surface = None;
            win.window.request_redraw();
            Acquire::Skip
        }
        wgpu::CurrentSurfaceTexture::Occluded => {
            win.occluded = true;
            Acquire::Skip
        }
        wgpu::CurrentSurfaceTexture::Timeout => Acquire::Skip,
        wgpu::CurrentSurfaceTexture::Validation => {
            log::warn!(target: "window", "這一幀沒有拿到 surface（驗證失敗）");
            Acquire::Skip
        }
    }
}

pub fn cursor_icon(kind: CursorKind) -> CursorIcon {
    match kind {
        CursorKind::Default => CursorIcon::Default,
        CursorKind::Pointer => CursorIcon::Pointer,
    }
}

/// What every window handles alike. True when the event is consumed.
pub fn common_event(win: &mut Win, event: &WindowEvent) -> bool {
    match event {
        WindowEvent::Resized(size) => {
            if size.width > 0 && size.height > 0 {
                win.dirty = true;
            }
            true
        }
        WindowEvent::ScaleFactorChanged { .. } => {
            win.dirty = true;
            true
        }
        WindowEvent::Occluded(occluded) => {
            win.occluded = *occluded;
            if !occluded {
                win.dirty = true;
            }
            true
        }
        WindowEvent::CursorMoved { position, .. } => {
            let scale = win.input_scale().max(0.001);
            win.pointer = (position.x as f32 / scale, position.y as f32 / scale);
            false
        }
        WindowEvent::CursorLeft { .. } => {
            win.pointer = (-1.0e6, -1.0e6);
            win.dirty = true;
            true
        }
        WindowEvent::MouseInput {
            state,
            button: MouseButton::Left,
            ..
        } => {
            match state {
                ElementState::Pressed => {
                    win.mouse_down = true;
                    win.pressed_edge = true;
                }
                ElementState::Released => {
                    win.mouse_down = false;
                    win.released_edge = true;
                }
            }
            win.dirty = true;
            false
        }
        WindowEvent::MouseWheel { delta, .. } => {
            let dy = match delta {
                MouseScrollDelta::LineDelta(_, y) => -y * 40.0,
                MouseScrollDelta::PixelDelta(pos) => -pos.y as f32 / win.input_scale(),
            };
            if dy.is_finite() {
                win.wheel += dy;
            }
            win.dirty = true;
            false
        }
        _ => false,
    }
}

/// A window's icon from a PNG. None in a browser, whose tab has the page's.
#[cfg(not(target_arch = "wasm32"))]
pub fn icon(png: &[u8]) -> Option<winit::window::Icon> {
    let image = image::load_from_memory_with_format(png, image::ImageFormat::Png).ok()?;
    let rgba = image.into_rgba8();
    let (w, h) = rgba.dimensions();
    winit::window::Icon::from_rgba(rgba.into_raw(), w, h).ok()
}

#[cfg(target_arch = "wasm32")]
pub fn icon(_png: &[u8]) -> Option<winit::window::Icon> {
    None
}
