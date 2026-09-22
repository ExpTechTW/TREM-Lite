mod audio;
mod config;
mod http_cache;
mod http_proxy;
mod logging;
mod math;
mod ntp;
mod window;

use audio::AudioEngine;
use http_proxy::ProxyState;
#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single-instance must be registered first (desktop only).
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch → focus the existing main window (same as window_focus).
            window::focus_main(app);
        }));
    }

    builder = builder
        .plugin(logging::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init());

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--start"]),
            ));
    }

    builder
        .manage(AudioEngine::new())
        .setup(|app| {
            logging::prune_old_logs(app.handle());
            // Every buffered HTTP request in the app goes through this proxy
            // (ETag revalidation + gzip + 250 MB SQLite LRU). If it can't open
            // its database the app must still run, so failure only logs.
            match ProxyState::new(app.handle()) {
                Ok(proxy) => {
                    app.manage(proxy);
                }
                Err(e) => log::error!("http proxy unavailable: {e}"),
            }
            config::ensure_initialized(app.handle());
            let start_hidden = std::env::args_os().any(|arg| arg == "--start");
            if let Some(window) = app.get_webview_window("main") {
                if start_hidden {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                }
            }
            #[cfg(desktop)]
            {
                let version = MenuItem::with_id(
                    app,
                    "version",
                    format!("TREM Lite v{}", app.package_info().version),
                    false,
                    None::<&str>,
                )?;
                let separator = PredefinedMenuItem::separator(app)?;
                let restart = MenuItem::with_id(app, "restart", "重新啟動", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "結束程式", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&version, &separator, &restart, &quit])?;
                let icon = app
                    .default_window_icon()
                    .cloned()
                    .ok_or("bundled application icon is unavailable")?;

                TrayIconBuilder::new()
                    .icon(icon)
                    .tooltip(format!("TREM Lite v{}", app.package_info().version))
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "restart" => app.restart(),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            if let Some(window) = tray.app_handle().get_webview_window("main") {
                                if window.is_visible().unwrap_or(false) {
                                    let _ = window.hide();
                                } else {
                                    window::focus_main(tray.app_handle());
                                }
                            }
                        }
                    })
                    .build(app)?;
            }
            #[cfg(debug_assertions)]
            {
                if let Some(w) = app.get_webview_window("main") {
                    w.open_devtools();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            audio::audio_enqueue,
            audio::audio_play,
            audio::audio_clear,
            audio::audio_stop_all,
            config::config_get,
            config::config_set,
            config::config_reset,
            http_proxy::http_request,
            http_proxy::http_cache_stats,
            http_proxy::http_cache_clear,
            math::eew_area_pga,
            ntp::ntp_sync,
            window::window_focus,
            window::window_request_attention,
            window::window_hide,
            window::window_show,
            window::pip_show,
            window::pip_hide,
        ])
        .on_window_event(|window, event| {
            // Closing the main window keeps the monitoring process alive in the
            // system tray, matching the legacy Electron lifecycle.
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
