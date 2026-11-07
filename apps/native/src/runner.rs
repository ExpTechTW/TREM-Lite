//! The windows and the event loop. The app sleeps until a timer is due, a message arrives or
//! input comes; it draws a window only when what that window shows has changed.

use std::net::TcpListener;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::{Duration, Instant};

use winit::application::ApplicationHandler;
use winit::dpi::{LogicalPosition, LogicalSize};
use winit::event::{ElementState, MouseButton, MouseScrollDelta, TouchPhase, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::keyboard::{Key, NamedKey};
use winit::window::{CursorIcon, UserAttentionType, Window, WindowId, WindowLevel};

use crate::app::{App, Msg, Post};
use crate::features::window::WindowCommand;
use crate::map::{MapEngine, MapEvent};
use crate::platform::{lifecycle, speech::Speech, tray};
use crate::render::{Gpu, GpuSurface};
use crate::ui::icons::IconCache;
use crate::ui::main_view::{Action, MainView};
use crate::ui::settings::SettingsView;
use crate::ui::{clear_color, CursorKind, InputState, Ui};
use crate::Args;

/// The report list's replay flash needs only this many frames.
const SLOW_ANIMATION: Duration = Duration::from_millis(33);

/// One window and what it takes to draw it.
struct Win {
    window: Arc<Window>,
    surface: Option<GpuSurface>,
    input: InputState,
    occluded: bool,
    pointer: (f32, f32),
    mouse_down: bool,
    pressed_edge: bool,
    released_edge: bool,
    wheel: f32,
    cursor: CursorIcon,
    retried_outdated: bool,
    /// Something it shows has changed.
    dirty: bool,
}

impl Win {
    fn new(window: Window) -> Self {
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

    fn scale(&self) -> f32 {
        let scale = self.window.scale_factor() as f32;
        if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        }
    }

    fn logical(&self) -> (f32, f32) {
        let size = self.window.inner_size();
        let scale = self.scale();
        (size.width as f32 / scale, size.height as f32 / scale)
    }

    fn take_edges(&mut self) -> (bool, bool, bool, f32) {
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

enum Acquire {
    Frame(wgpu::SurfaceTexture, bool),
    Skip,
}

fn acquire(gpu: &Gpu, win: &mut Win) -> Acquire {
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

fn cursor_icon(kind: CursorKind) -> CursorIcon {
    match kind {
        CursorKind::Default => CursorIcon::Default,
        CursorKind::Pointer => CursorIcon::Pointer,
    }
}

struct Runner {
    gpu: Gpu,
    app: App,
    ui: Option<Ui>,
    icons: IconCache,
    main: Option<Win>,
    pip: Option<Win>,
    settings: Option<Win>,
    main_view: MainView,
    settings_view: Option<SettingsView>,
    post: Post,
    tray: Option<tray::Tray>,
    start_hidden: bool,
    started: bool,
    trimmed: bool,
    next_clock: Instant,
    next_slow_frame: Option<Instant>,
    map_dragging: bool,
    quitting: bool,
    gave_up_on_device: bool,
}

pub fn run(
    rt: &tokio::runtime::Runtime,
    args: &Args,
    listener: Option<TcpListener>,
) -> Result<(), String> {
    let event_loop = EventLoop::<Msg>::with_user_event()
        .build()
        .map_err(|err| format!("無法建立事件迴圈：{err}"))?;
    event_loop.set_control_flow(ControlFlow::Wait);
    let proxy: EventLoopProxy<Msg> = event_loop.create_proxy();
    let proxy = std::sync::Mutex::new(proxy);
    let post: Post = Arc::new(move |msg| {
        if let Ok(proxy) = proxy.lock() {
            let _ = proxy.send_event(msg);
        }
    });
    if let Some(listener) = listener {
        lifecycle::serve_instance(listener, post.clone());
    }

    let gpu = Gpu::new().ok_or("沒有可用的 GPU")?;
    let cache = crate::paths::cache_dir().ok_or("找不到快取目錄")?;
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let net = Arc::new(crate::net::ProxyState::new(&cache)?);
    if !crate::net::fixture::active() {
        if let Some(dir) = crate::paths::local_data_dir() {
            rt.spawn(crate::backend::ml_intensity::prepare(
                dir.join("models"),
                net.client(),
            ));
        }
    }
    let wake = post.clone();
    let map = MapEngine::new(
        crate::map::tile_fetch(rt.handle().clone(), Arc::clone(&net)),
        Arc::new(move || wake(Msg::Wake)),
        (1280.0, 815.0),
    );
    let speech = Speech::new(post.clone());
    let host = crate::host::Host::live(rt.handle().clone(), post.clone(), net);
    let app = App::new(host, crate::backend::config::load(), map, speech);
    let mut runner = Runner {
        gpu,
        app,
        ui: None,
        icons: IconCache::default(),
        main: None,
        pip: None,
        settings: None,
        main_view: MainView::new(1280.0),
        settings_view: None,
        post,
        tray: None,
        start_hidden: args.start_hidden,
        started: false,
        trimmed: false,
        next_clock: Instant::now(),
        next_slow_frame: None,
        map_dragging: false,
        quitting: false,
        gave_up_on_device: false,
    };
    event_loop
        .run_app(&mut runner)
        .map_err(|err| format!("事件迴圈結束：{err}"))
}

impl ApplicationHandler<Msg> for Runner {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.main.is_some() {
            return;
        }
        let mut attrs = Window::default_attributes()
            .with_title("TREM Lite")
            .with_inner_size(LogicalSize::new(1280.0, 815.0))
            .with_min_inner_size(LogicalSize::new(900.0, 680.0))
            .with_visible(false);
        attrs = attrs.with_window_icon(tray::window_icon());
        if let Some(monitor) = event_loop.primary_monitor() {
            let scale = monitor.scale_factor();
            let size = monitor.size().to_logical::<f64>(scale);
            let origin = monitor.position().to_logical::<f64>(scale);
            attrs = attrs.with_position(LogicalPosition::new(
                origin.x + ((size.width - 1280.0) / 2.0).max(0.0),
                origin.y + ((size.height - 815.0) / 2.0).max(0.0),
            ));
        }
        let window = match event_loop.create_window(attrs) {
            Ok(window) => window,
            Err(err) => {
                log::error!(target: "window", "無法開視窗：{err}");
                event_loop.exit();
                return;
            }
        };
        let (w, h) = {
            let size = window.inner_size();
            let scale = window.scale_factor();
            (
                f64::from(size.width) / scale,
                f64::from(size.height) / scale,
            )
        };
        self.main_view = MainView::new(w as f32);
        self.app.map.resize(w, h);
        if self.start_hidden {
            log::info!(target: "app", "隱藏啟動（開機自動啟動或更新後重啟）：只在系統匣");
            lifecycle::set_dock(false);
        } else {
            window.set_visible(true);
        }
        self.main = Some(Win::new(window));
        self.tray = tray::create(
            self.post.clone(),
            &crate::backend::version::label(env!("CARGO_PKG_VERSION")),
        );
        if self.tray.is_none() {
            log::warn!(target: "tray", "沒有系統匣圖示：關閉主視窗會直接結束程式");
        }
        lifecycle::sync_autostart(self.app.config.checked("other-auto-start"));
        if !self.started {
            self.started = true;
            self.app.start(!self.start_hidden);
        }
        self.request_redraws();
    }

    fn user_event(&mut self, _event_loop: &ActiveEventLoop, msg: Msg) {
        let ran = std::panic::catch_unwind(AssertUnwindSafe(|| self.app.on_msg(msg)));
        if ran.is_err() {
            log::error!(target: "app", "處理訊息時出錯，其他功能照常");
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        self.sync_main_state();
        let now = Instant::now();
        while let Some((_, task)) = self.app.timers.pop_due(now) {
            let ran = std::panic::catch_unwind(AssertUnwindSafe(|| self.app.run_task(task)));
            if ran.is_err() {
                log::error!(target: "app", "計時工作出錯，其他功能照常");
            }
        }
        self.recover_lost_device();
        self.run_commands(event_loop);
        self.trim_if_hidden();

        // The clock turns over each second, shown only while there is a window to show it.
        if now >= self.next_clock {
            let ms = chrono::Utc::now().timestamp_millis();
            self.next_clock = now + Duration::from_millis(1000 - (ms % 1000) as u64);
            if let Some(main) = &mut self.main {
                main.dirty = true;
            }
        }
        if self.app.dirty {
            self.app.dirty = false;
            for win in [&mut self.main, &mut self.pip].into_iter().flatten() {
                win.dirty = true;
            }
        }
        if self.app.map.needs_frame() {
            if let Some(main) = &mut self.main {
                main.dirty = true;
            }
        }
        self.request_redraws();

        let mut wake = self.app.timers.next_deadline();
        let keep = |wake: &mut Option<Instant>, at: Instant| {
            *wake = Some(wake.map_or(at, |w| w.min(at)));
        };
        if self.main_visible() {
            keep(&mut wake, self.next_clock);
        }
        if let Some(at) = self.next_slow_frame {
            keep(&mut wake, at);
        }
        event_loop.set_control_flow(wake.map_or(ControlFlow::Wait, ControlFlow::WaitUntil));
        if self.quitting {
            event_loop.exit();
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        if self.main.as_ref().is_some_and(|w| w.window.id() == id) {
            self.main_event(event_loop, event);
        } else if self.pip.as_ref().is_some_and(|w| w.window.id() == id) {
            self.pip_event(event);
        } else if self.settings.as_ref().is_some_and(|w| w.window.id() == id) {
            self.settings_event(event);
        }
    }
}

/// What every window handles alike. True when the event is consumed.
fn common_event(win: &mut Win, event: &WindowEvent) -> bool {
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
            let scale = win.scale().max(0.001);
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
                MouseScrollDelta::PixelDelta(pos) => -pos.y as f32 / win.scale(),
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

impl Runner {
    fn main_visible(&self) -> bool {
        self.app.window.main_shown && self.main.as_ref().is_some_and(|w| !w.occluded)
    }

    /// The window's state, as the 500 ms check reads it.
    fn sync_main_state(&mut self) {
        if let Some(main) = &self.main {
            let visible = main.window.is_visible().unwrap_or(false);
            let minimized = main.window.is_minimized().unwrap_or(false);
            self.app.window.main_shown = visible && !minimized;
        }
    }

    /// A lost GPU device does not come back: a new process gets a new one, at most once in
    /// ten minutes, so a failing GPU cannot loop. Without it alerts still sound.
    fn recover_lost_device(&mut self) {
        const RESTART_EVERY: Duration = Duration::from_secs(600);
        if !crate::render::device_lost() || self.gave_up_on_device {
            return;
        }
        let marker = crate::paths::cache_dir().map(|d| d.join("gpu-restart-at"));
        let recent = marker
            .as_ref()
            .and_then(|path| {
                std::fs::metadata(path)
                    .ok()?
                    .modified()
                    .ok()?
                    .elapsed()
                    .ok()
            })
            .is_some_and(|age| age < RESTART_EVERY);
        self.gave_up_on_device = true;
        if recent {
            log::error!(target: "window", "GPU device 遺失，而 10 分鐘內已經為此重新啟動過：畫面維持停用，其他功能照常");
            return;
        }
        if let Some(path) = marker {
            let _ = std::fs::write(path, "");
        }
        log::warn!(target: "window", "GPU device 遺失：重新啟動以取得新的 device");
        self.app.commands.push(WindowCommand::Restart {
            hidden: self.app.window.main_unavailable,
        });
    }

    /// While nothing can be seen, the GPU's memory goes back.
    fn trim_if_hidden(&mut self) {
        let hidden = !self.app.window.main_shown;
        if hidden && !self.trimmed {
            self.trimmed = true;
            self.app.map.trim();
            if let Some(main) = &mut self.main {
                main.surface = None;
            }
            if self.pip.is_none() && self.settings.is_none() {
                if let Some(ui) = &mut self.ui {
                    ui.release_atlas();
                }
            }
            lifecycle::return_free_memory();
        } else if !hidden {
            self.trimmed = false;
        }
    }

    fn request_redraws(&mut self) {
        let main_shown = self.app.window.main_shown;
        let now = Instant::now();
        let slow_due = self.next_slow_frame.is_some_and(|at| now >= at);
        if slow_due {
            self.next_slow_frame = None;
        }
        if let Some(main) = &mut self.main {
            if slow_due {
                main.dirty = true;
            }
            if main.dirty && main_shown && !main.occluded {
                main.window.request_redraw();
            }
        }
        for win in [&mut self.pip, &mut self.settings].into_iter().flatten() {
            if win.dirty && !win.occluded {
                win.window.request_redraw();
            }
        }
    }

    fn ensure_ui(&mut self, format: wgpu::TextureFormat, logical: (f32, f32), scale: f32) -> bool {
        if let Some(ui) = &mut self.ui {
            if let Err(err) = ui.recreate_pipelines(&self.gpu, format) {
                log::error!(target: "window", "重建繪圖器失敗：{err}");
                return false;
            }
            return true;
        }
        match Ui::new(&self.gpu, format, logical, scale) {
            Ok(ui) => {
                self.ui = Some(ui);
                true
            }
            Err(err) => {
                log::error!(target: "window", "無法建立繪圖器：{err}");
                false
            }
        }
    }

    fn run_commands(&mut self, event_loop: &ActiveEventLoop) {
        for command in std::mem::take(&mut self.app.commands) {
            match command {
                WindowCommand::ShowPip => self.show_pip(event_loop),
                WindowCommand::HidePip => {
                    if self.pip.take().is_some() {
                        log::info!(target: "window", "隱藏 PiP 小視窗");
                    }
                }
                WindowCommand::HideSettings => self.close_settings(),
                WindowCommand::OpenSettings => self.open_settings(event_loop),
                WindowCommand::FocusMain { critical } => self.focus_main(critical),
                WindowCommand::ToggleMain => {
                    if self.app.window.main_shown {
                        log::info!(target: "tray", "點擊圖示：收起主視窗");
                        self.hide_main();
                    } else {
                        log::info!(target: "tray", "點擊圖示：叫出主視窗");
                        self.focus_main(false);
                    }
                }
                WindowCommand::Restart { hidden } => self.restart(hidden),
                WindowCommand::Quit => self.quitting = true,
            }
        }
    }

    fn hide_main(&mut self) {
        if let Some(main) = &self.main {
            main.window.set_visible(false);
        }
        lifecycle::set_dock(false);
        self.app.window.main_shown = false;
    }

    /// Unminimize, show, focus. The attention request is what reaches a user elsewhere.
    fn focus_main(&mut self, critical: bool) {
        lifecycle::set_dock(true);
        if let Some(main) = &mut self.main {
            log::info!(
                target: "window",
                "要求使用者注意（{}）：工作列閃爍／Dock 跳動",
                if critical { "緊急" } else { "一般" }
            );
            main.window.set_minimized(false);
            main.window.set_visible(true);
            main.window.focus_window();
            main.window.request_user_attention(Some(if critical {
                UserAttentionType::Critical
            } else {
                UserAttentionType::Informational
            }));
            main.dirty = true;
        }
        lifecycle::activate_app();
        self.app.window.main_shown = true;
    }

    /// Created when needed and drawn before it is shown, so it never flashes empty.
    fn show_pip(&mut self, event_loop: &ActiveEventLoop) {
        if self.pip.is_none() {
            log::info!(target: "window", "建立 PiP 小視窗（先畫好警報內容再顯示）");
            let attrs = Window::default_attributes()
                .with_title("TREM Lite PiP")
                .with_inner_size(LogicalSize::new(276.0, 147.0))
                .with_min_inner_size(LogicalSize::new(276.0, 147.0))
                .with_max_inner_size(LogicalSize::new(276.0, 147.0))
                .with_position(LogicalPosition::new(0.0, 0.0))
                .with_decorations(false)
                .with_resizable(false)
                .with_enabled_buttons(winit::window::WindowButtons::empty())
                .with_window_level(WindowLevel::AlwaysOnTop)
                .with_visible(false);
            #[cfg(target_os = "windows")]
            let attrs = {
                use winit::platform::windows::WindowAttributesExtWindows;
                attrs.with_skip_taskbar(true)
            };
            match event_loop.create_window(attrs) {
                Ok(window) => {
                    lifecycle::pin_to_all_spaces(&window);
                    self.pip = Some(Win::new(window));
                }
                Err(err) => {
                    log::error!(target: "window", "PiP 小視窗建立失敗：{err}");
                    self.app.window.pip_shown = false;
                    return;
                }
            }
        }
        self.paint_pip();
        if let Some(pip) = &self.pip {
            log::info!(target: "window", "顯示 PiP 小視窗");
            pip.window.set_visible(true);
        }
    }

    fn open_settings(&mut self, event_loop: &ActiveEventLoop) {
        if let Some(win) = &self.settings {
            log::info!(target: "window", "設定視窗已開著，帶到前面");
            win.window.focus_window();
            return;
        }
        log::info!(target: "window", "開啟設定視窗");
        let mut attrs = Window::default_attributes()
            .with_title("TREM-Lite 設定")
            .with_inner_size(LogicalSize::new(970.0, 590.0))
            .with_resizable(false)
            .with_decorations(false);
        if let Some(monitor) = event_loop.primary_monitor() {
            let scale = monitor.scale_factor();
            let size = monitor.size().to_logical::<f64>(scale);
            let origin = monitor.position().to_logical::<f64>(scale);
            attrs = attrs.with_position(LogicalPosition::new(
                origin.x + ((size.width - 970.0) / 2.0).max(0.0),
                origin.y + ((size.height - 590.0) / 2.0).max(0.0),
            ));
        }
        match event_loop.create_window(attrs) {
            Ok(window) => {
                self.settings = Some(Win::new(window));
                self.settings_view = Some(SettingsView::new(&self.app));
            }
            Err(err) => log::error!(target: "window", "設定視窗建立失敗：{err}"),
        }
    }

    fn close_settings(&mut self) {
        if self.settings.take().is_some() {
            log::info!(target: "window", "關閉設定視窗");
        }
        self.settings_view = None;
    }

    /// Start again, and let this process go. The new one waits for the lock.
    fn restart(&mut self, hidden: bool) {
        log::info!(target: "app", "重新啟動{}", if hidden { "（隱藏）" } else { "" });
        let spawned = std::env::current_exe().and_then(|exe| {
            let mut command = std::process::Command::new(exe);
            command.arg("--restarted");
            if hidden {
                command.arg("--start");
            }
            command.spawn()
        });
        match spawned {
            Ok(_) => self.quitting = true,
            Err(err) => log::error!(target: "app", "無法重新啟動：{err}"),
        }
    }

    fn set_cursor(win: &mut Win, cursor: CursorIcon) {
        if win.cursor != cursor {
            win.cursor = cursor;
            win.window.set_cursor(cursor);
        }
    }

    fn main_event(&mut self, event_loop: &ActiveEventLoop, event: WindowEvent) {
        let Some(win) = &mut self.main else {
            return;
        };
        common_event(win, &event);
        match &event {
            WindowEvent::CloseRequested => {
                if self.tray.is_none() {
                    event_loop.exit();
                    return;
                }
                log::info!(target: "window", "關閉主視窗：縮到系統匣，繼續監測");
                self.hide_main();
            }
            WindowEvent::Resized(size) if size.width > 0 && size.height > 0 => {
                let (w, h) = win.logical();
                self.app.map_resized(f64::from(w), f64::from(h));
            }
            WindowEvent::ScaleFactorChanged { .. } => {
                let (w, h) = win.logical();
                self.app.map_resized(f64::from(w), f64::from(h));
            }
            WindowEvent::RedrawRequested => {
                let ran = std::panic::catch_unwind(AssertUnwindSafe(|| self.paint_main()));
                if ran.is_err() {
                    log::error!(target: "window", "繪製發生 panic，這一幀略過");
                }
            }
            WindowEvent::CursorMoved { .. } => self.main_pointer_moved(),
            WindowEvent::MouseInput {
                state,
                button: MouseButton::Left,
                ..
            } => self.main_button(*state),
            WindowEvent::MouseWheel { delta, .. } => {
                let delta = *delta;
                self.main_wheel(delta);
            }
            WindowEvent::PinchGesture { delta, .. } => {
                let (x, y) = win.pointer;
                for ev in self.app.map.pinch(*delta, f64::from(x), f64::from(y)) {
                    self.app.focus_on_map_event(ev);
                }
            }
            WindowEvent::Touch(touch) => {
                let scale = win.scale().max(0.001);
                let (x, y) = (
                    f64::from(touch.location.x as f32 / scale),
                    f64::from(touch.location.y as f32 / scale),
                );
                match touch.phase {
                    TouchPhase::Started => {
                        self.app.focus_on_map_event(MapEvent::TouchStart);
                        for ev in self.app.map.pointer_down(x, y) {
                            self.app.focus_on_map_event(ev);
                        }
                        self.map_dragging = true;
                    }
                    TouchPhase::Moved => {
                        if let Some(ev) = self.app.map.pointer_move(x, y) {
                            self.app.focus_on_map_event(ev);
                        }
                    }
                    TouchPhase::Ended | TouchPhase::Cancelled => {
                        for ev in self.app.map.pointer_up(x, y) {
                            self.app.focus_on_map_event(ev);
                        }
                        self.map_dragging = false;
                    }
                }
            }
            WindowEvent::KeyboardInput { event: key, .. } if key.state == ElementState::Pressed => {
                self.main_key(&key.logical_key);
            }
            _ => {}
        }
    }

    /// MapLibre's keyboard handler: arrows pan by 100 px, plus and minus zoom by one.
    fn main_key(&mut self, key: &Key) {
        let (dx, dy, dz) = match key {
            Key::Named(NamedKey::ArrowLeft) => (100.0, 0.0, 0.0),
            Key::Named(NamedKey::ArrowRight) => (-100.0, 0.0, 0.0),
            Key::Named(NamedKey::ArrowUp) => (0.0, 100.0, 0.0),
            Key::Named(NamedKey::ArrowDown) => (0.0, -100.0, 0.0),
            Key::Character(c) if c.as_str() == "=" || c.as_str() == "+" => (0.0, 0.0, 1.0),
            Key::Character(c) if c.as_str() == "-" || c.as_str() == "_" => (0.0, 0.0, -1.0),
            _ => return,
        };
        self.app.map.key_move(dx, dy, dz);
        self.app.focus_on_map_event(MapEvent::UserMove);
    }

    fn main_pointer_moved(&mut self) {
        let Some(win) = &mut self.main else {
            return;
        };
        let (x, y) = win.pointer;
        if self.map_dragging {
            if let Some(ev) = self.app.map.pointer_move(f64::from(x), f64::from(y)) {
                self.app.focus_on_map_event(ev);
            }
            win.dirty = true;
            return;
        }
        // Over what is under the pointer changed? Only then a frame.
        let Some(ui) = &mut self.ui else {
            return;
        };
        ui.swap_input(&mut win.input);
        let hover_now = ui.hover_at(x, y);
        let hover_before = ui.current_hover();
        ui.swap_input(&mut win.input);
        if hover_now != hover_before {
            win.dirty = true;
        }
        if hover_now.is_none() {
            Self::set_cursor(win, CursorIcon::Grab);
        }
    }

    fn main_button(&mut self, state: ElementState) {
        let Some(win) = &mut self.main else {
            return;
        };
        let (x, y) = win.pointer;
        match state {
            ElementState::Pressed => {
                let over_ui = match &mut self.ui {
                    Some(ui) => {
                        ui.swap_input(&mut win.input);
                        let over = ui.hover_at(x, y).is_some();
                        ui.swap_input(&mut win.input);
                        over
                    }
                    None => false,
                };
                if !over_ui {
                    self.map_dragging = true;
                    Self::set_cursor(win, CursorIcon::Grabbing);
                    for ev in self.app.map.pointer_down(f64::from(x), f64::from(y)) {
                        self.app.focus_on_map_event(ev);
                    }
                }
            }
            ElementState::Released => {
                if self.map_dragging {
                    self.map_dragging = false;
                    Self::set_cursor(win, CursorIcon::Grab);
                    for ev in self.app.map.pointer_up(f64::from(x), f64::from(y)) {
                        self.app.focus_on_map_event(ev);
                    }
                }
            }
        }
    }

    fn main_wheel(&mut self, delta: MouseScrollDelta) {
        let Some(win) = &mut self.main else {
            return;
        };
        let (x, y) = win.pointer;
        let over_ui = match &mut self.ui {
            Some(ui) => {
                ui.swap_input(&mut win.input);
                let over = ui.hover_at(x, y).is_some();
                ui.swap_input(&mut win.input);
                over
            }
            None => false,
        };
        if over_ui {
            return;
        }
        let (value, pixels) = match delta {
            MouseScrollDelta::LineDelta(_, y) => (-f64::from(y) * 100.0, false),
            MouseScrollDelta::PixelDelta(pos) => (-pos.y / f64::from(win.scale()), true),
        };
        if value == 0.0 || !value.is_finite() {
            return;
        }
        for ev in self
            .app
            .map
            .wheel(value, pixels, f64::from(x), f64::from(y))
        {
            self.app.focus_on_map_event(ev);
        }
    }

    fn paint_main(&mut self) {
        let Some(win) = &mut self.main else {
            return;
        };
        if !self.app.window.main_shown || win.occluded {
            return;
        }
        let Acquire::Frame(frame, suboptimal) = acquire(&self.gpu, win) else {
            return;
        };
        let Some(format) = win.surface.as_ref().map(|s| s.format) else {
            return;
        };
        let scale = win.scale();
        let logical = win.logical();
        win.dirty = false;
        if !self.ensure_ui(format, logical, scale) {
            return;
        }
        let (Some(win), Some(ui)) = (&mut self.main, &mut self.ui) else {
            return;
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("main-frame"),
            });
        self.app
            .map
            .resize(f64::from(logical.0), f64::from(logical.1));
        let map_ok = match self.app.map.prepare(&self.gpu, format) {
            Ok(()) => {
                self.app
                    .map
                    .encode(&self.gpu, &view, &mut encoder, f64::from(scale));
                true
            }
            Err(err) => {
                log::error!(target: "map", "{err}");
                false
            }
        };

        let (down, pressed, released, wheel) = win.take_edges();
        ui.swap_input(&mut win.input);
        ui.resize(logical, scale);
        ui.begin();
        ui.set_pointer(win.pointer.0, win.pointer.1);
        ui.set_buttons(down, pressed, released);
        ui.add_wheel(wheel);
        let mut actions = Vec::new();
        self.main_view
            .draw(ui, &self.gpu, &mut self.icons, &mut self.app, &mut actions);
        let cursor = ui.cursor();
        let over_ui = ui.hover_at(win.pointer.0, win.pointer.1).is_some();
        ui.end();
        ui.render(
            &self.gpu,
            &view,
            &mut encoder,
            if map_ok { None } else { Some(clear_color()) },
        );
        ui.swap_input(&mut win.input);
        self.gpu.queue.submit([encoder.finish()]);
        self.gpu.queue.present(frame);
        if suboptimal {
            if let Some(surface) = &win.surface {
                surface.reconfigure(&self.gpu.device);
            }
        }
        // The cursor: the map's when over it.
        let icon = if self.map_dragging {
            CursorIcon::Grabbing
        } else if over_ui {
            cursor_icon(cursor)
        } else {
            CursorIcon::Grab
        };
        Self::set_cursor(win, icon);

        for action in actions {
            match action {
                Action::OpenSettings => self.app.commands.push(WindowCommand::OpenSettings),
                Action::FocusReset => self.app.focus_reset(true),
                Action::RestartForUpdate => self.app.restart_for_update(),
                Action::OpenReport(item) => self.app.open_report_url(&item),
                Action::Replay(item) => self.app.replay_report(&item),
            }
        }

        // Keep moving what moves.
        if self.app.map.wants_animation() {
            win.dirty = true;
            win.window.request_redraw();
        }
        if self.main_view.animating(&self.app) {
            let fast = self.main_view.transitioning();
            if fast {
                win.dirty = true;
                win.window.request_redraw();
            } else {
                self.next_slow_frame = Some(Instant::now() + SLOW_ANIMATION);
            }
        }
    }

    fn pip_event(&mut self, event: WindowEvent) {
        let Some(win) = &mut self.pip else {
            return;
        };
        common_event(win, &event);
        match event {
            WindowEvent::CloseRequested => {
                self.pip = None;
                self.app.window.pip_shown = false;
            }
            WindowEvent::RedrawRequested => self.paint_pip(),
            WindowEvent::CursorMoved { .. } | WindowEvent::CursorEntered { .. } => {
                win.dirty = true;
            }
            WindowEvent::MouseInput {
                state: ElementState::Pressed,
                button: MouseButton::Left,
                ..
            } => Self::drag_if_over(win, self.ui.as_mut(), &[crate::ui::pip::ID_SHELL]),
            _ => {}
        }
    }

    /// A press on a window's own surface moves it. Asked for during the press: the system
    /// reads the event being handled. It keeps the release, so the press ends here.
    fn drag_if_over(win: &mut Win, ui: Option<&mut Ui>, ids: &[crate::ui::WidgetId]) {
        let Some(ui) = ui else {
            return;
        };
        ui.swap_input(&mut win.input);
        let over = ui.hover_at(win.pointer.0, win.pointer.1);
        ui.swap_input(&mut win.input);
        if over.is_some_and(|id| ids.contains(&id)) {
            let _ = win.window.drag_window();
            win.mouse_down = false;
            win.pressed_edge = false;
            win.released_edge = false;
        }
    }

    fn paint_pip(&mut self) {
        let Some(win) = &mut self.pip else {
            return;
        };
        let Acquire::Frame(frame, _) = acquire(&self.gpu, win) else {
            return;
        };
        let Some(format) = win.surface.as_ref().map(|s| s.format) else {
            return;
        };
        let (scale, logical) = (win.scale(), win.logical());
        win.dirty = false;
        if !self.ensure_ui(format, logical, scale) {
            return;
        }
        let (Some(win), Some(ui)) = (&mut self.pip, &mut self.ui) else {
            return;
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("pip-frame"),
            });
        let (down, pressed, released, wheel) = win.take_edges();
        ui.swap_input(&mut win.input);
        ui.resize(logical, scale);
        ui.begin();
        ui.set_pointer(win.pointer.0, win.pointer.1);
        ui.set_buttons(down, pressed, released);
        ui.add_wheel(wheel);
        let outcome = crate::ui::pip::draw(
            ui,
            &self.gpu,
            &mut self.icons,
            self.app.ui.current_eew.as_ref(),
            self.app.ui.current_trigger.as_ref(),
        );
        let cursor = ui.cursor();
        ui.end();
        ui.render(&self.gpu, &view, &mut encoder, Some(clear_color()));
        ui.swap_input(&mut win.input);
        self.gpu.queue.submit([encoder.finish()]);
        self.gpu.queue.present(frame);
        Self::set_cursor(win, cursor_icon(cursor));
        if outcome.back_to_main {
            self.pip = None;
            self.app.window.pip_shown = false;
            self.app
                .commands
                .push(WindowCommand::FocusMain { critical: false });
        } else if outcome.close {
            self.pip = None;
            self.app.window.pip_shown = false;
        }
    }

    fn settings_event(&mut self, event: WindowEvent) {
        let Some(win) = &mut self.settings else {
            return;
        };
        common_event(win, &event);
        match event {
            WindowEvent::CloseRequested => self.close_settings(),
            WindowEvent::RedrawRequested => self.paint_settings(),
            WindowEvent::CursorMoved { .. } => win.dirty = true,
            WindowEvent::MouseInput {
                state: ElementState::Pressed,
                button: MouseButton::Left,
                ..
            } => Self::drag_if_over(
                win,
                self.ui.as_mut(),
                &[
                    crate::ui::settings::DRAG_SIDEBAR,
                    crate::ui::settings::DRAG_HEADER,
                ],
            ),
            WindowEvent::KeyboardInput { event: key, .. }
                if key.state == ElementState::Pressed
                    && key.logical_key == Key::Named(NamedKey::Escape) =>
            {
                if let Some(view) = &mut self.settings_view {
                    view.on_escape();
                }
                win.dirty = true;
            }
            _ => {}
        }
    }

    fn paint_settings(&mut self) {
        let Some(win) = &mut self.settings else {
            return;
        };
        let Acquire::Frame(frame, _) = acquire(&self.gpu, win) else {
            return;
        };
        let Some(format) = win.surface.as_ref().map(|s| s.format) else {
            return;
        };
        let (scale, logical) = (win.scale(), win.logical());
        win.dirty = false;
        if !self.ensure_ui(format, logical, scale) {
            return;
        }
        let (Some(win), Some(ui), Some(view_state)) =
            (&mut self.settings, &mut self.ui, &mut self.settings_view)
        else {
            return;
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("settings-frame"),
            });
        let (down, pressed, released, wheel) = win.take_edges();
        ui.swap_input(&mut win.input);
        ui.resize(logical, scale);
        ui.begin();
        ui.set_pointer(win.pointer.0, win.pointer.1);
        ui.set_buttons(down, pressed, released);
        ui.add_wheel(wheel);
        let outcome = view_state.draw(ui, &self.gpu, &mut self.icons, &mut self.app);
        let cursor = ui.cursor();
        ui.end();
        ui.render(&self.gpu, &view, &mut encoder, Some(clear_color()));
        ui.swap_input(&mut win.input);
        self.gpu.queue.submit([encoder.finish()]);
        self.gpu.queue.present(frame);
        Self::set_cursor(win, cursor_icon(cursor));
        if outcome.minimize {
            win.window.set_minimized(true);
        }
        if view_state.animating() {
            win.dirty = true;
            win.window.request_redraw();
        }
        if outcome.close {
            self.close_settings();
        }
    }
}
