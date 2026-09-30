mod audio;
mod awake;
mod config;
mod endpoints;
mod http_cache;
mod http_proxy;
mod logging;
mod math;
mod ml_intensity;
mod ntp;
#[cfg(desktop)]
mod updater;
#[cfg(not(desktop))]
mod updater {
    // OTA is desktop-only, but `generate_handler!` cannot take a `#[cfg]`.
    #[tauri::command]
    pub fn update_check() -> Result<(), String> {
        Err("updates are desktop-only".into())
    }
    #[tauri::command]
    pub fn update_pending() -> Option<String> {
        None
    }
    #[tauri::command]
    pub fn update_restart() {}
}
mod version;
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
    awake::keep_awake();
    let mut builder = tauri::Builder::default();

    // Single-instance must be registered first (desktop only).
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Second launch → focus the existing main window (same as window_focus).
            log::info!(target: "app", "第二次啟動（參數 {:?}）：叫出已經在跑的主視窗", &args[1.min(args.len())..]);
            window::focus_main(app);
        }));
    }

    builder = builder
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init());

    #[cfg(desktop)]
    {
        builder = builder
            .manage(updater::UpdaterState::default())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--start"]),
            ));
    }

    builder
        .manage(AudioEngine::new())
        .setup(|app| {
            logging::init(app.handle());
            log::info!(
                target: "app",
                "TREM-Lite {} 啟動｜{} {} {}｜語系 {}｜參數 {:?}",
                app.package_info().version,
                tauri_plugin_os::platform(),
                tauri_plugin_os::version(),
                tauri_plugin_os::arch(),
                tauri_plugin_os::locale().unwrap_or_else(|| "?".into()),
                std::env::args().skip(1).collect::<Vec<_>>(),
            );
            awake::log_state();
            // The intensity model: read from the app's data, or downloaded
            // there on first launch, then built ahead of the first EEW.
            match app.path().app_local_data_dir() {
                Ok(dir) => {
                    let client = tauri_plugin_http::reqwest::Client::builder()
                        .user_agent(concat!("TREM-Lite/", env!("CARGO_PKG_VERSION")))
                        .build()
                        .unwrap_or_default();
                    tauri::async_runtime::spawn(ml_intensity::prepare(dir.join("models"), client));
                }
                Err(e) => log::error!("no data dir for the intensity model: {e}"),
            }
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
            #[cfg(desktop)]
            let start_hidden = std::env::args_os().any(|arg| arg == "--start")
                || updater::restart_hidden(app.handle());
            #[cfg(not(desktop))]
            let start_hidden = std::env::args_os().any(|arg| arg == "--start");
            let reveal = move |app: &tauri::AppHandle| {
                #[cfg(desktop)]
                updater::clear_restart_hidden(app);
                if start_hidden {
                    log::info!(target: "app", "隱藏啟動（開機自動啟動或更新後重啟）：只在系統匣");
                    window::hide_main(app);
                } else if let Some(window) = app.get_webview_window("main") {
                    let _ = window.center();
                    let _ = window.show();
                }
            };
            #[cfg(desktop)]
            updater::start(app.handle(), reveal);
            #[cfg(not(desktop))]
            reveal(app.handle());
            #[cfg(desktop)]
            {
                let name = format!(
                    "TREM Lite {}",
                    version::label(&app.package_info().version.to_string())
                );
                let version = MenuItem::with_id(app, "version", &name, false, None::<&str>)?;
                let separator = PredefinedMenuItem::separator(app)?;
                let show = MenuItem::with_id(app, "show", "顯示視窗", true, None::<&str>)?;
                let restart = MenuItem::with_id(app, "restart", "重新啟動", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "結束程式", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&version, &separator, &show, &restart, &quit])?;
                let icon = app
                    .default_window_icon()
                    .cloned()
                    .ok_or("bundled application icon is unavailable")?;

                TrayIconBuilder::new()
                    .icon(icon)
                    .tooltip(&name)
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "show" => {
                            log::info!(target: "tray", "顯示視窗");
                            window::focus_main(app);
                        }
                        "restart" => {
                            log::info!(target: "tray", "重新啟動");
                            app.restart();
                        }
                        "quit" => {
                            log::info!(target: "tray", "結束程式");
                            app.exit(0);
                        }
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
                                    log::info!(target: "tray", "點擊圖示：收起主視窗");
                                    window::hide_main(tray.app_handle());
                                } else {
                                    log::info!(target: "tray", "點擊圖示：叫出主視窗");
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
            audio::audio_preview,
            config::config_get,
            config::config_set,
            config::config_reset,
            http_proxy::http_request,
            http_proxy::http_resolve,
            http_proxy::http_report,
            math::eew_area_intensity,
            ntp::ntp_sync,
            updater::update_check,
            updater::update_pending,
            updater::update_restart,
            logging::log_write,
            logging::logs_open,
            window::window_focus,
            window::window_request_attention,
            window::window_hide,
            window::window_state,
            window::window_show,
            window::pip_show,
            window::pip_hide,
        ])
        .on_window_event(|window, event| {
            // Closing the main window keeps the monitoring process alive in the
            // system tray, matching the legacy Electron lifecycle.
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    log::info!(target: "window", "關閉主視窗：縮到系統匣，繼續監測");
                    api.prevent_close();
                    window::hide_main(window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(on_run_event);
}

/// A click on the Dock icon while the app runs (macOS): the main window comes
/// back, closed to the tray or minimised. macOS leaves it to the app, and the
/// app did nothing, so a hidden window stayed hidden. And the app's end, which
/// is the last line of every run's log.
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
fn on_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            log::info!(target: "app", "點擊 Dock 圖示：叫出主視窗");
            window::focus_main(app);
        }
        tauri::RunEvent::Exit => {
            log::info!(target: "app", "程式結束");
            log::logger().flush();
        }
        _ => {}
    }
}
