//! A browser has no tray: the tab is the window.

use crate::app::Post;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrayCommand {
    Show,
    Toggle,
    Restart,
    Quit,
}

pub struct Tray;

pub fn window_icon() -> Option<winit::window::Icon> {
    None
}

pub fn create(_post: Post, _version: &str) -> Option<Tray> {
    None
}
