//! A browser has no tray: the tab is the window.

use std::sync::Arc;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrayCommand {
    Show,
    Toggle,
    Restart,
    Quit,
}

#[derive(Clone, Debug)]
pub enum TrayItem {
    Label(String),
    Separator,
    Command(&'static str, TrayCommand),
}

#[derive(Clone, Debug)]
pub struct TrayConfig {
    pub id: &'static str,
    pub title: &'static str,
    pub icon_png: &'static [u8],
    pub menu: Vec<TrayItem>,
}

pub type OnCommand = Arc<dyn Fn(TrayCommand) + Send + Sync>;

pub struct Tray;

pub fn create(_config: TrayConfig, _on_command: OnCommand) -> Option<Tray> {
    None
}
