//! The app's place in the system: starting at login, one instance, the Dock, the clipboard.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

/// The single-instance lock: a loopback port. A port is what every platform can do
/// without a native lock; another program on it means no lock, and the app runs anyway.
/// Each app needs its own port, or two of them would take each other for themselves.
#[derive(Clone, Copy, Debug)]
pub struct InstanceConfig {
    pub port: u16,
    /// What the two instances say to each other, both ways, to know it is them.
    pub hello: &'static [u8],
}

pub enum Instance {
    First(TcpListener),
    Second,
}

/// Ask for the lock, or tell the running app to show itself.
pub fn claim_instance(config: &InstanceConfig) -> Option<Instance> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, config.port));
    match TcpListener::bind(addr) {
        Ok(listener) => Some(Instance::First(listener)),
        Err(_) => {
            let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500))
            else {
                return None;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
            let _ = stream.write_all(config.hello);
            let mut answer = vec![0; config.hello.len()];
            let confirmed = stream.read_exact(&mut answer).is_ok() && answer == config.hello;
            confirmed.then_some(Instance::Second)
        }
    }
}

/// A second launch knocks here; `second` is called each time, on the listener's thread.
pub fn serve_instance(
    config: &InstanceConfig,
    listener: TcpListener,
    second: impl Fn() + Send + 'static,
) {
    let hello = config.hello;
    std::thread::Builder::new()
        .name("single-instance".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                let mut knock = vec![0; hello.len()];
                if stream.read_exact(&mut knock).is_ok() && knock == hello {
                    let _ = stream.write_all(hello);
                    second();
                }
            }
        })
        .map_err(|err| log::warn!(target: "app", "單一執行個體的監聽起不來：{err}"))
        .ok();
}

/// The login item: under what name, and what it passes the app.
#[cfg(feature = "autostart")]
#[derive(Clone, Copy, Debug)]
pub struct AutostartConfig {
    pub name: &'static str,
    pub args: &'static [&'static str],
}

#[cfg(feature = "autostart")]
fn auto_launch(config: &AutostartConfig) -> Result<auto_launch::AutoLaunch, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = exe.to_string_lossy().into_owned();
    let mut builder = auto_launch::AutoLaunchBuilder::new();
    builder
        .set_app_name(config.name)
        .set_app_path(&path)
        .set_args(config.args);
    #[cfg(target_os = "macos")]
    builder.set_use_launch_agent(true);
    builder.build().map_err(|e| e.to_string())
}

#[cfg(feature = "autostart")]
pub fn set_autostart(config: &AutostartConfig, on: bool) -> Result<(), String> {
    let launch = auto_launch(config)?;
    if on {
        launch.enable().map_err(|e| e.to_string())
    } else if launch.is_enabled().unwrap_or(false) {
        launch.disable().map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

/// Keep the login item aligned with the setting. Rewritten on every launch while enabled:
/// the item records the path the app ran from. A failure must not block monitoring.
#[cfg(feature = "autostart")]
pub fn sync_autostart(config: &AutostartConfig, on: bool) {
    if let Err(err) = set_autostart(config, on) {
        log::debug!(target: "app", "開機啟動同步失敗：{err}");
    }
}

/// `osType osVersion (arch)`, for a bug report.
pub fn system_description() -> String {
    let info = os_info::get();
    format!(
        "{} {} ({})",
        std::env::consts::OS,
        info.version(),
        std::env::consts::ARCH
    )
}

/// Put text on the clipboard with what the system has for it.
pub fn copy_text(text: &str) -> Result<(), String> {
    use std::process::{Command, Stdio};
    #[cfg(target_os = "macos")]
    let candidates: &[(&str, &[&str])] = &[("pbcopy", &[])];
    #[cfg(target_os = "windows")]
    let candidates: &[(&str, &[&str])] = &[("clip", &[])];
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let candidates: &[(&str, &[&str])] = &[
        ("wl-copy", &[]),
        ("xclip", &["-selection", "clipboard"]),
        ("xsel", &["--clipboard", "--input"]),
    ];
    let mut last = "沒有可用的剪貼簿工具".to_string();
    for (program, args) in candidates {
        match Command::new(program)
            .args(*args)
            .stdin(Stdio::piped())
            .spawn()
        {
            Ok(mut child) => {
                if let Some(stdin) = child.stdin.as_mut() {
                    stdin
                        .write_all(text.as_bytes())
                        .map_err(|e| e.to_string())?;
                }
                drop(child.stdin.take());
                return child
                    .wait()
                    .map_err(|e| e.to_string())
                    .and_then(|s| s.success().then_some(()).ok_or_else(|| s.to_string()));
            }
            Err(err) => last = err.to_string(),
        }
    }
    Err(last)
}

/// macOS: the Dock icon follows the main window. Closed to the tray, it has none.
#[cfg(target_os = "macos")]
pub fn set_dock(visible: bool) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let policy = if visible {
        NSApplicationActivationPolicy::Regular
    } else {
        NSApplicationActivationPolicy::Accessory
    };
    let app = NSApplication::sharedApplication(mtm);
    if !app.setActivationPolicy(policy) {
        log::warn!(target: "window", "Dock 圖示切換失敗");
    }
}

#[cfg(not(target_os = "macos"))]
pub fn set_dock(_visible: bool) {}

/// macOS: bring the app forward, whatever else is in front.
#[cfg(target_os = "macos")]
pub fn activate_app() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    if let Some(mtm) = MainThreadMarker::new() {
        NSApplication::sharedApplication(mtm).activate();
    }
}

#[cfg(not(target_os = "macos"))]
pub fn activate_app() {}

/// macOS: a window on every Space, also over full-screen apps. PiP's.
#[cfg(target_os = "macos")]
pub fn pin_to_all_spaces(window: &winit::window::Window) {
    use objc2::rc::Retained;
    use objc2_app_kit::{NSView, NSWindowCollectionBehavior};
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let Ok(handle) = window.window_handle() else {
        return;
    };
    let RawWindowHandle::AppKit(appkit) = handle.as_raw() else {
        return;
    };
    // SAFETY: winit hands out a live NSView, on the main thread, for this window.
    let view: Option<Retained<NSView>> =
        unsafe { Retained::retain(appkit.ns_view.as_ptr().cast()) };
    if let Some(ns_window) = view.and_then(|v| v.window()) {
        ns_window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
    }
}

#[cfg(not(target_os = "macos"))]
pub fn pin_to_all_spaces(_window: &winit::window::Window) {}

/// Give freed pages back to the system. macOS's allocator keeps them for reuse, and they
/// count against the process until memory is short.
#[cfg(target_os = "macos")]
pub fn return_free_memory() {
    extern "C" {
        fn malloc_zone_pressure_relief(zone: *mut std::ffi::c_void, goal: usize) -> usize;
    }
    // SAFETY: a null zone means every zone, and a goal of 0 means as much as possible.
    unsafe {
        malloc_zone_pressure_relief(std::ptr::null_mut(), 0);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn return_free_memory() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_launch_is_answered_only_by_its_own_hello() {
        // A port free for this test alone.
        let port = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .and_then(|l| l.local_addr())
            .expect("a free port")
            .port();
        let ours = InstanceConfig {
            port,
            hello: b"trem-gfx-test",
        };
        let Some(Instance::First(listener)) = claim_instance(&ours) else {
            panic!("the first launch takes the lock");
        };
        let (knocked, heard) = std::sync::mpsc::channel();
        serve_instance(&ours, listener, move || {
            let _ = knocked.send(());
        });
        assert!(matches!(claim_instance(&ours), Some(Instance::Second)));
        heard
            .recv_timeout(Duration::from_secs(2))
            .expect("the first launch is told");
        // Another app on the same port is not taken for this one.
        let theirs = InstanceConfig {
            port,
            hello: b"someone-else!",
        };
        assert!(claim_instance(&theirs).is_none());
        assert!(heard.try_recv().is_err());
    }
}
