//! Keeps the app at full speed while its windows are hidden (trem_gfx's `awake`): an
//! earthquake alert comes in, and has to be heard, while the app sits in the tray.

pub use trem_gfx::platform::awake::keep_awake;

/// Writes what [`keep_awake`] did to the log, once the logger is up.
pub fn log_state() {
    match trem_gfx::platform::awake::state() {
        Some(state) => log::info!("背景不降速：{state}"),
        None => log::info!("背景不降速：這個平台沒有可設定的項目"),
    }
}
