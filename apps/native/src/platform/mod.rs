//! What differs per operating system, from trem_gfx's platform layer with this app's names:
//! notifications, speech, the tray, and app lifecycle. A browser gets trem_gfx's browser
//! version of each.

pub mod lifecycle;
pub mod notify;
pub mod speech;
pub mod tray;
