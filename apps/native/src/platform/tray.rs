//! The tray: version, show, restart, quit; a click toggles the main window.

use std::sync::Arc;

pub use trem_gfx::platform::tray::{Tray, TrayCommand};
use trem_gfx::platform::tray::{TrayConfig, TrayItem};

use crate::app::{Msg, Post};

const ICON_PNG: &[u8] = include_bytes!("../../assets/icons/32x32.png");

/// The same picture on the window, where the system takes it from the window.
pub fn window_icon() -> Option<winit::window::Icon> {
    trem_gfx::window::icon(ICON_PNG)
}

/// Build the tray. On macOS this must run on the main thread, once the loop has started.
pub fn create(post: Post, version: &str) -> Option<Tray> {
    let config = TrayConfig {
        id: "trem-lite-native",
        title: "TREM Lite",
        icon_png: ICON_PNG,
        menu: vec![
            TrayItem::Label(format!("TREM Lite {version}")),
            TrayItem::Separator,
            TrayItem::Command("顯示視窗", TrayCommand::Show),
            TrayItem::Command("重新啟動", TrayCommand::Restart),
            TrayItem::Command("結束程式", TrayCommand::Quit),
        ],
    };
    trem_gfx::platform::tray::create(config, Arc::new(move |command| post(Msg::Tray(command))))
}
