//! The app's place in the system: starting at login, one instance, the Dock, the clipboard.

pub use trem_gfx::platform::lifecycle::*;
use trem_gfx::platform::lifecycle::{self as gfx, AutostartConfig};

/// The login item: launched to the tray.
const AUTOSTART: AutostartConfig = AutostartConfig {
    name: "TREM-Lite Native",
    args: &["--start"],
};

pub fn set_autostart(on: bool) -> Result<(), String> {
    gfx::set_autostart(&AUTOSTART, on)
}

/// Keep the login item aligned with the setting.
pub fn sync_autostart(on: bool) {
    gfx::sync_autostart(&AUTOSTART, on);
}

/// The single-instance lock: its own port, apart from other TREM apps'.
#[cfg(not(target_arch = "wasm32"))]
const INSTANCE: InstanceConfig = InstanceConfig {
    port: 47_931,
    hello: b"TREM-Lite-native",
};

/// Ask for the lock, or tell the running app to show itself.
#[cfg(not(target_arch = "wasm32"))]
pub fn claim_instance() -> Option<Instance> {
    gfx::claim_instance(&INSTANCE)
}

/// A second launch knocks here, and the running app shows itself.
#[cfg(not(target_arch = "wasm32"))]
pub fn serve_instance(listener: std::net::TcpListener, post: crate::app::Post) {
    gfx::serve_instance(&INSTANCE, listener, move || {
        post(crate::app::Msg::SecondInstance)
    });
}
