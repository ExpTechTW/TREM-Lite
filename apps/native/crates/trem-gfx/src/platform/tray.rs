//! The tray: the app's menu, and a click that toggles the main window. On Linux, where
//! tray-icon would need a GTK loop beside winit's, ksni speaks to the desktop over D-Bus.

use std::sync::Arc;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrayCommand {
    Show,
    Toggle,
    Restart,
    Quit,
}

/// One line of the tray's menu.
#[derive(Clone, Debug)]
pub enum TrayItem {
    /// Text that does nothing: the app's name and version.
    Label(String),
    Separator,
    /// A line that sends its command; the label is also what the log says.
    Command(&'static str, TrayCommand),
}

/// The tray's icon and menu.
#[derive(Clone, Debug)]
pub struct TrayConfig {
    /// What the desktop knows the tray by (Linux).
    pub id: &'static str,
    /// The tooltip, and the title on Linux.
    pub title: &'static str,
    pub icon_png: &'static [u8],
    pub menu: Vec<TrayItem>,
}

/// Where the tray's commands go: a menu line, or a click on the icon (`Toggle`). Called
/// on whatever thread the system delivers the event on.
pub type OnCommand = Arc<dyn Fn(TrayCommand) + Send + Sync>;

fn icon_rgba(png: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let image = image::load_from_memory_with_format(png, image::ImageFormat::Png).ok()?;
    let rgba = image.into_rgba8();
    let (w, h) = rgba.dimensions();
    Some((rgba.into_raw(), w, h))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub struct Tray {
    _icon: tray_icon::TrayIcon,
}

/// Build the tray. On macOS this must run on the main thread, once the loop has started.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn create(config: TrayConfig, on_command: OnCommand) -> Option<Tray> {
    use tray_icon::menu::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem};
    use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let menu = Menu::new();
    let mut commands: Vec<(MenuId, &'static str, TrayCommand)> = Vec::new();
    for item in &config.menu {
        let appended = match item {
            TrayItem::Label(text) => menu.append(&MenuItem::new(text, false, None)),
            TrayItem::Separator => menu.append(&PredefinedMenuItem::separator()),
            TrayItem::Command(label, command) => {
                let line = MenuItem::new(*label, true, None);
                commands.push((line.id().clone(), label, *command));
                menu.append(&line)
            }
        };
        if let Err(err) = appended {
            log::warn!(target: "tray", "系統匣選單建立失敗：{err}");
            return None;
        }
    }
    let menu_command = Arc::clone(&on_command);
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let Some((_, label, command)) = commands.iter().find(|(id, ..)| *id == event.id) else {
            return;
        };
        log::info!(target: "tray", "{label}");
        menu_command(*command);
    }));
    TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            on_command(TrayCommand::Toggle);
        }
    }));

    let (rgba, w, h) = icon_rgba(config.icon_png)?;
    let icon = Icon::from_rgba(rgba, w, h).ok()?;
    match TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_tooltip(config.title)
        .with_icon(icon)
        .with_menu_on_left_click(false)
        .build()
    {
        Ok(icon) => Some(Tray { _icon: icon }),
        Err(err) => {
            log::warn!(target: "tray", "系統匣圖示建立失敗：{err}");
            None
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub struct Tray {
    _handle: ksni::blocking::Handle<LinuxTray>,
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub struct LinuxTray {
    on_command: OnCommand,
    config: TrayConfig,
    icon: Vec<ksni::Icon>,
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl ksni::Tray for LinuxTray {
    fn id(&self) -> String {
        self.config.id.to_string()
    }

    fn title(&self) -> String {
        self.config.title.to_string()
    }

    fn icon_pixmap(&self) -> Vec<ksni::Icon> {
        self.icon.clone()
    }

    fn activate(&mut self, _x: i32, _y: i32) {
        (self.on_command)(TrayCommand::Toggle);
    }

    fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
        use ksni::menu::StandardItem;
        self.config
            .menu
            .iter()
            .map(|item| match item {
                TrayItem::Label(text) => ksni::MenuItem::Standard(StandardItem {
                    label: text.clone(),
                    enabled: false,
                    ..Default::default()
                }),
                TrayItem::Separator => ksni::MenuItem::Separator,
                TrayItem::Command(label, command) => {
                    let command = *command;
                    ksni::MenuItem::Standard(StandardItem {
                        label: label.to_string(),
                        activate: Box::new(move |tray: &mut Self| (tray.on_command)(command)),
                        ..Default::default()
                    })
                }
            })
            .collect()
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn create(config: TrayConfig, on_command: OnCommand) -> Option<Tray> {
    use ksni::blocking::TrayMethods;
    let (rgba, w, h) = icon_rgba(config.icon_png)?;
    // ksni's pixmaps are ARGB in network order.
    let mut argb = rgba;
    for px in argb.chunks_exact_mut(4) {
        px.rotate_right(1);
    }
    let tray = LinuxTray {
        on_command,
        config,
        icon: vec![ksni::Icon {
            width: w as i32,
            height: h as i32,
            data: argb,
        }],
    };
    match tray.spawn() {
        Ok(handle) => Some(Tray { _handle: handle }),
        Err(err) => {
            log::warn!(target: "tray", "系統匣圖示建立失敗：{err}");
            None
        }
    }
}
