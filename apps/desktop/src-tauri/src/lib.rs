mod audio;
mod config;
mod logging;
mod math;
mod ntp;
mod window;

use audio::AudioEngine;

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
            config::ensure_initialized(app.handle());
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
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
            math::eew_area_pga,
            ntp::ntp_sync,
            window::window_focus,
            window::window_request_attention,
            window::window_hide,
            window::window_show,
            window::pip_show,
            window::pip_hide,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
