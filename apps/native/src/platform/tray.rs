//! The tray: version, show, restart, quit; a click toggles the main window. On Linux, where
//! tray-icon would need a GTK loop beside winit's, ksni speaks to the desktop over D-Bus.

use crate::app::{Msg, Post};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrayCommand {
    Show,
    Toggle,
    Restart,
    Quit,
}

const ICON_PNG: &[u8] = include_bytes!("../../assets/icons/32x32.png");

fn icon_rgba() -> Option<(Vec<u8>, u32, u32)> {
    let image = image::load_from_memory_with_format(ICON_PNG, image::ImageFormat::Png).ok()?;
    let rgba = image.into_rgba8();
    let (w, h) = rgba.dimensions();
    Some((rgba.into_raw(), w, h))
}

/// The same picture on the window, where the system takes it from the window.
pub fn window_icon() -> Option<winit::window::Icon> {
    let (rgba, w, h) = icon_rgba()?;
    winit::window::Icon::from_rgba(rgba, w, h).ok()
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub struct Tray {
    _icon: tray_icon::TrayIcon,
}

/// Build the tray. On macOS this must run on the main thread, once the loop has started.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn create(post: Post, version: &str) -> Option<Tray> {
    use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
    use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let name = format!("TREM Lite {version}");
    let version_item = MenuItem::new(&name, false, None);
    let show = MenuItem::new("顯示視窗", true, None);
    let restart = MenuItem::new("重新啟動", true, None);
    let quit = MenuItem::new("結束程式", true, None);
    let menu = Menu::new();
    let appended = menu.append_items(&[
        &version_item,
        &PredefinedMenuItem::separator(),
        &show,
        &restart,
        &quit,
    ]);
    if let Err(err) = appended {
        log::warn!(target: "tray", "系統匣選單建立失敗：{err}");
        return None;
    }
    let (show_id, restart_id, quit_id) =
        (show.id().clone(), restart.id().clone(), quit.id().clone());
    let menu_post = post.clone();
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let command = if event.id == show_id {
            log::info!(target: "tray", "顯示視窗");
            TrayCommand::Show
        } else if event.id == restart_id {
            log::info!(target: "tray", "重新啟動");
            TrayCommand::Restart
        } else if event.id == quit_id {
            log::info!(target: "tray", "結束程式");
            TrayCommand::Quit
        } else {
            return;
        };
        menu_post(Msg::Tray(command));
    }));
    TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            post(Msg::Tray(TrayCommand::Toggle));
        }
    }));

    let (rgba, w, h) = icon_rgba()?;
    let icon = Icon::from_rgba(rgba, w, h).ok()?;
    match TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_tooltip("TREM Lite")
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
    post: Post,
    name: String,
    icon: Vec<ksni::Icon>,
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl ksni::Tray for LinuxTray {
    fn id(&self) -> String {
        "trem-lite-native".to_string()
    }

    fn title(&self) -> String {
        "TREM Lite".to_string()
    }

    fn icon_pixmap(&self) -> Vec<ksni::Icon> {
        self.icon.clone()
    }

    fn activate(&mut self, _x: i32, _y: i32) {
        (self.post)(Msg::Tray(TrayCommand::Toggle));
    }

    fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
        use ksni::menu::StandardItem;
        let item = |label: &str, command: TrayCommand| {
            ksni::MenuItem::Standard(StandardItem {
                label: label.to_string(),
                activate: Box::new(move |tray: &mut Self| (tray.post)(Msg::Tray(command))),
                ..Default::default()
            })
        };
        vec![
            ksni::MenuItem::Standard(StandardItem {
                label: self.name.clone(),
                enabled: false,
                ..Default::default()
            }),
            ksni::MenuItem::Separator,
            item("顯示視窗", TrayCommand::Show),
            item("重新啟動", TrayCommand::Restart),
            item("結束程式", TrayCommand::Quit),
        ]
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn create(post: Post, version: &str) -> Option<Tray> {
    use ksni::blocking::TrayMethods;
    let (rgba, w, h) = icon_rgba()?;
    // ksni's pixmaps are ARGB in network order.
    let mut argb = rgba;
    for px in argb.chunks_exact_mut(4) {
        px.rotate_right(1);
    }
    let tray = LinuxTray {
        post,
        name: format!("TREM Lite {version}"),
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
