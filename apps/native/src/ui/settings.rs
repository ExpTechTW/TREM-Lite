//! The settings window (features/settings/SettingsApp.tsx, StationPicker.tsx). Every change
//! is saved at once, and the main window follows it.

use trem_core::region;
use web_time::Instant;

use super::icons::{Icon, IconCache};
use super::widgets::{draw_tooltip, right, style, text_cut, text_in, Transition};
use super::{Color, CursorKind, Interaction, QuadStyle, Rect, Ui, WidgetId};
use crate::app::App;
use crate::backend::config::{Config, IdleMap};
use crate::domain::types::StationId;
use crate::render::Gpu;

const REPO: &str = "https://github.com/ExpTechTW/TREM-Lite";
const SHELL_BG: Color = Color::rgba_u8(0x1c, 0x1c, 0x1f, 0xff);
const SIDEBAR_BG: Color = Color::rgba_u8(0x14, 0x14, 0x16, 0xff);
const CARD_BG: Color = Color::rgba_u8(0x26, 0x26, 0x2a, 0xff);
const MUTED: Color = Color::rgba_u8(0xa1, 0xa1, 0xaa, 0xff);
const HINT: Color = Color::rgba_u8(0x8b, 0x8b, 0x94, 0xff);
const FOREGROUND: Color = Color::rgba_u8(0xf4, 0xf4, 0xf5, 0xff);
const PRIMARY: Color = Color::rgba_u8(0xbe, 0xff, 0x0c, 0xff);
const LINE: Color = Color::rgba_u8(255, 255, 255, 0x12);
const FIELD_BORDER: Color = Color::rgba_u8(255, 255, 255, 0x1f);
const DANGER: Color = Color::rgba_u8(0xff, 0x6b, 0x6b, 0xff);

const SIDEBAR_W: f32 = 196.0;
const MENU_MAX_H: f32 = 340.0;
const MENU_COLUMN: f32 = 150.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Tab {
    General,
    Alerts,
    Sound,
    About,
}

const TABS: [(Tab, &str, Icon); 4] = [
    (Tab::General, "一般", Icon::SlidersHorizontal),
    (Tab::Alerts, "警報", Icon::BellRing),
    (Tab::Sound, "音效", Icon::Volume2),
    (Tab::About, "關於", Icon::Info),
];

type Sound = (&'static str, &'static str, &'static str, &'static str);
/// The sound effects by group: config key, name, when it plays, clip.
const SOUNDS: [(&str, &[Sound]); 3] = [
    (
        "地震預警",
        &[
            ("sound-effects-EEW", "地震預警", "收到地震預警時", "EEW"),
            (
                "sound-effects-EEW2",
                "緊急地震速報",
                "預警升級為警報時",
                "ALERT",
            ),
            (
                "sound-effects-Update",
                "預警更新",
                "預警內容更新時",
                "UPDATE",
            ),
        ],
    ),
    (
        "地震檢知",
        &[
            (
                "sound-effects-Shindo0",
                "檢知・弱",
                "測站偵測到搖晃",
                "SHINDO0",
            ),
            (
                "sound-effects-Shindo1",
                "檢知・中",
                "測站震度 2 以上",
                "SHINDO1",
            ),
            (
                "sound-effects-Shindo2",
                "檢知・強",
                "測站震度 4 以上",
                "SHINDO2",
            ),
            (
                "sound-effects-PGA1",
                "加速度・中",
                "測站加速度超過 8 gal",
                "PGA1",
            ),
            (
                "sound-effects-PGA2",
                "加速度・強",
                "測站加速度超過 200 gal",
                "PGA2",
            ),
        ],
    ),
    (
        "報告",
        &[
            (
                "sound-effects-PAlert",
                "震度速報",
                "收到震度速報或長週期地震動時",
                "INTENSITY",
            ),
            (
                "sound-effects-Report",
                "地震報告",
                "收到地震報告時",
                "REPORT",
            ),
        ],
    ),
];

const WINDOW_EVENTS: [(&str, &str); 4] = [
    ("show-window-eew", "地震預警"),
    ("show-window-detect", "地震檢知"),
    ("show-window-rts-intensity", "震度速報"),
    ("show-window-report", "地震報告"),
];

/// A place's stations, in the region table's order (north to south).
struct TownStations {
    town: &'static str,
    ids: Vec<StationId>,
}

struct CityStations {
    city: &'static str,
    towns: Vec<TownStations>,
}

/// Only those the server takes data from; the chosen one is listed even so.
fn stations_by_place(app: &App) -> Vec<CityStations> {
    let Some(stations) = &app.var.station else {
        return Vec::new();
    };
    let chosen = StationId::new(&app.config.station_id);
    let mut by_town: std::collections::HashMap<(&str, &str), Vec<StationId>> =
        std::collections::HashMap::new();
    for (id, s) in stations.iter() {
        if s.work == Some(false) && Some(*id) != chosen {
            continue;
        }
        let Some(town) = region::town_of(s.code) else {
            continue;
        };
        by_town.entry((town.city, town.town)).or_default().push(*id);
    }
    let mut out: Vec<CityStations> = Vec::new();
    for town in region::towns() {
        let Some(mut ids) = by_town.remove(&(town.city, town.town)) else {
            continue;
        };
        ids.sort();
        let entry = TownStations {
            town: town.town,
            ids,
        };
        match out.iter_mut().find(|c| c.city == town.city) {
            Some(city) => city.towns.push(entry),
            None => out.push(CityStations {
                city: town.city,
                towns: vec![entry],
            }),
        }
    }
    out
}

/// A toggle row's words and state.
struct ToggleSpec<'a> {
    key: &'a str,
    label: &'a str,
    hint: Option<&'a str>,
    checked: bool,
}

/// What the view asks of the window it lives in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SettingsOutcome {
    pub minimize: bool,
    pub close: bool,
}

/// A press on these moves the window: the sidebar and the header.
pub const DRAG_SIDEBAR: WidgetId = WidgetId(90);
pub const DRAG_HEADER: WidgetId = WidgetId(91);

struct Menu {
    place: Rect,
    city: Option<&'static str>,
    town: Option<&'static str>,
}

pub struct SettingsView {
    tab: Tab,
    status: Option<(String, Instant)>,
    confirm_reset: bool,
    tree: Vec<CityStations>,
    menu: Option<Menu>,
    select_open: bool,
    select_field: Rect,
    /// A press outside a popup only closes it.
    swallow_click: bool,
    knobs: Vec<(String, Transition)>,
    next_id: u64,
    system: String,
}

fn tab_file() -> Option<std::path::PathBuf> {
    crate::paths::PATHS
        .data_dir()
        .map(|d| d.join("setting-tab"))
}

impl SettingsView {
    pub fn new(app: &App) -> Self {
        let saved = tab_file()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .unwrap_or_default();
        let tab = match saved.trim() {
            "alerts" => Tab::Alerts,
            "sound" => Tab::Sound,
            "about" => Tab::About,
            _ => Tab::General,
        };
        Self {
            tab,
            status: None,
            confirm_reset: false,
            tree: stations_by_place(app),
            menu: None,
            select_open: false,
            select_field: Rect::ZERO,
            swallow_click: false,
            knobs: Vec::new(),
            next_id: 100,
            system: crate::platform::lifecycle::system_description(),
        }
    }

    /// For screenshots.
    pub fn select_tab_named(&mut self, name: &str) {
        self.tab = match name {
            "警報" | "alerts" => Tab::Alerts,
            "音效" | "sound" => Tab::Sound,
            "關於" | "about" => Tab::About,
            _ => Tab::General,
        };
    }

    fn select_tab(&mut self, tab: Tab) {
        self.tab = tab;
        self.confirm_reset = false;
        let name = match tab {
            Tab::General => "general",
            Tab::Alerts => "alerts",
            Tab::Sound => "sound",
            Tab::About => "about",
        };
        if let Some(path) = tab_file() {
            let _ = std::fs::write(path, name);
        }
    }

    fn say(&mut self, text: impl Into<String>) {
        self.status = Some((text.into(), Instant::now()));
    }

    /// Something is moving, or will change by itself: another frame soon.
    pub fn animating(&self) -> bool {
        self.knobs.iter().any(|(_, k)| k.running()) || self.status.is_some()
    }

    fn id(&mut self) -> WidgetId {
        self.next_id += 1;
        WidgetId(self.next_id)
    }

    pub fn draw(
        &mut self,
        ui: &mut Ui,
        gpu: &Gpu,
        icons: &mut IconCache,
        app: &mut App,
    ) -> SettingsOutcome {
        self.next_id = 100;
        let mut outcome = SettingsOutcome::default();
        let (w, h) = (ui.width(), ui.height());
        if let Some((_, at)) = &self.status {
            if at.elapsed().as_secs_f32() > 3.5 {
                self.status = None;
            }
        }
        ui.quad(Rect::new(0.0, 0.0, w, h), &QuadStyle::solid(SHELL_BG));

        // The whole window drags, under everything that takes a click.
        ui.hit(DRAG_SIDEBAR, Rect::new(0.0, 0.0, SIDEBAR_W, h));
        ui.hit(DRAG_HEADER, Rect::new(SIDEBAR_W, 0.0, w - SIDEBAR_W, 50.0));

        // The sidebar.
        ui.quad(
            Rect::new(0.0, 0.0, SIDEBAR_W, h),
            &QuadStyle::solid(SIDEBAR_BG),
        );
        ui.quad(
            Rect::new(SIDEBAR_W - 1.0, 0.0, 1.0, h),
            &QuadStyle::solid(LINE),
        );
        text_in(
            ui,
            "TREM Lite",
            12.0 + 10.0,
            22.0,
            25.5,
            FOREGROUND,
            &style(17.0, 800),
        );
        let mut y = 66.0;
        for (tab, label, icon) in TABS {
            let rect = Rect::new(12.0, y, SIDEBAR_W - 25.0, 39.0);
            let id = self.id();
            let hit = ui.hit(id, rect);
            let active = self.tab == tab;
            if active || hit.hovered {
                let alpha = if active { 0x17 } else { 0x0d };
                ui.quad(
                    rect,
                    &QuadStyle::solid(Color::rgba_u8(255, 255, 255, alpha)).radius(8.0),
                );
            }
            let color = if active || hit.hovered {
                FOREGROUND
            } else {
                MUTED
            };
            icons.draw(
                ui,
                gpu,
                icon,
                Rect::new(rect.x + 10.0, rect.y + 11.0, 17.0, 17.0),
                color,
            );
            text_in(
                ui,
                label,
                rect.x + 37.0,
                rect.y + 9.0,
                21.0,
                color,
                &style(14.0, 600),
            );
            if hit.hovered {
                ui.set_cursor(CursorKind::Pointer);
            }
            if hit.clicked && !self.swallow_click {
                self.select_tab(tab);
            }
            y += 41.0;
        }

        // The header.
        let main_x = SIDEBAR_W;
        let title = TABS.iter().find(|t| t.0 == self.tab).map_or("", |t| t.1);
        text_in(
            ui,
            title,
            main_x + 32.0,
            18.0,
            33.0,
            FOREGROUND,
            &style(22.0, 800),
        );
        let mut cx = w - 20.0 - 30.0;
        for (icon, is_close, tip) in [(Icon::X, true, "關閉"), (Icon::Minus, false, "最小化")]
        {
            let rect = Rect::new(cx, 18.0, 30.0, 30.0);
            let id = self.id();
            let hit = ui.hit(id, rect);
            if hit.hovered {
                ui.quad(
                    rect,
                    &QuadStyle::solid(Color::rgba_u8(255, 255, 255, 0x14)).radius(7.0),
                );
                ui.set_cursor(CursorKind::Pointer);
                ui.set_tooltip(tip);
            }
            icons.draw(
                ui,
                gpu,
                icon,
                Rect::new(rect.x + 7.0, rect.y + 7.0, 16.0, 16.0),
                if hit.hovered { FOREGROUND } else { MUTED },
            );
            if hit.clicked {
                if is_close {
                    outcome.close = true;
                } else {
                    outcome.minimize = true;
                }
            }
            cx -= 34.0;
        }

        // The page.
        let scroll_top = 18.0 + 33.0 + 6.0;
        let view = Rect::new(main_x, scroll_top, w - main_x, h - scroll_top);
        let scroll_id = WidgetId(92);
        ui.hit(scroll_id, view);
        let content_w = view.w - 64.0;
        let total = self.page_height(ui, content_w);
        let max_scroll = (total + 8.0 + 32.0 - view.h).max(0.0);
        // Over a popup, the wheel is the popup's.
        let (px, py) = ui.pointer();
        let area = if self.menu_rect().is_some_and(|m| m.contains(px, py)) {
            Rect::ZERO
        } else {
            view
        };
        let scroll = ui.scroll_offset(scroll_id, area, max_scroll);
        ui.push_clip(view);
        let x = view.x + 32.0;
        let top = view.y + 8.0 - scroll;
        match self.tab {
            Tab::General => self.page_general(ui, gpu, icons, app, x, top, content_w),
            Tab::Alerts => self.page_alerts(ui, app, x, top, content_w),
            Tab::Sound => self.page_sound(ui, gpu, icons, app, x, top, content_w),
            Tab::About => self.page_about(ui, gpu, icons, app, x, top, content_w),
        }
        ui.pop_clip();

        // The toast.
        if let Some((text, _)) = self.status.clone() {
            let s = style(13.0, 400);
            let tw = ui.measure(&text, &s);
            let box_w = tw + 28.0;
            let rect = Rect::new(w - 20.0 - box_w, h - 20.0 - 39.5, box_w, 39.5);
            ui.quad(
                rect,
                &QuadStyle::solid(Color::rgba_u8(0x2c, 0x2c, 0x31, 0xff))
                    .radius(10.0)
                    .border(1.0, FIELD_BORDER)
                    .shadow(0.0, 8.0, 24.0, Color::rgba_u8(0, 0, 0, 0x66)),
            );
            text_in(
                ui,
                &text,
                rect.x + 14.0,
                rect.y + 10.0,
                19.5,
                FOREGROUND,
                &s,
            );
        }

        self.draw_select_popup(ui, app);
        self.draw_menu(ui, gpu, icons, app);
        draw_tooltip(ui);
        outcome
    }

    fn menu_rect(&self) -> Option<Rect> {
        self.menu.as_ref().map(|menu| {
            let columns = 1 + usize::from(menu.city.is_some()) + usize::from(menu.town.is_some());
            Rect::new(
                menu.place.x,
                menu.place.y,
                MENU_COLUMN * columns as f32 + 2.0,
                menu.place.h,
            )
        })
    }

    fn page_height(&self, _ui: &mut Ui, _width: f32) -> f32 {
        match self.tab {
            Tab::General => 410.0,
            Tab::Alerts => 340.0,
            Tab::Sound => {
                let mut h = 0.0;
                for (i, (_, sounds)) in SOUNDS.iter().enumerate() {
                    if i > 0 {
                        h += 24.0;
                    }
                    h += 28.0 + 2.0 + sounds.len() as f32 * 57.75;
                }
                h
            }
            Tab::About => 780.0,
        }
    }

    /// A titled group's card, around the height the body says it needs. Returns the y under it.
    #[allow(clippy::too_many_arguments)]
    fn group(
        &mut self,
        ui: &mut Ui,
        title: &str,
        note: Option<&str>,
        x: f32,
        y: f32,
        width: f32,
        rows_h: f32,
    ) -> (Rect, f32) {
        text_in(ui, title, x + 4.0, y, 19.5, MUTED, &style(13.0, 700));
        let top = y + 19.5 + 8.0;
        let card = Rect::new(x, top, width, rows_h + 2.0);
        ui.quad(
            card,
            &QuadStyle::solid(CARD_BG).radius(12.0).border(1.0, LINE),
        );
        let mut bottom = card.y + card.h;
        if let Some(note) = note {
            let s = style(12.5, 400);
            let h = ui.text_wrapped(note, x + 4.0, bottom + 8.0 + 14.0, width - 8.0, HINT, &s);
            bottom += 8.0 + h.max(18.75);
        }
        (card, bottom)
    }

    fn row_divider(ui: &mut Ui, card: Rect, y: f32) {
        ui.quad(
            Rect::new(card.x + 1.0, y, card.w - 2.0, 1.0),
            &QuadStyle::solid(Color::rgba_u8(255, 255, 255, 0x0d)),
        );
    }

    /// A `Toggle` row: its label and hint, and the switch at the right, easing over 150 ms.
    /// Returns the row's interaction and where the switch starts, for a button beside it.
    fn toggle_row(&mut self, ui: &mut Ui, rect: Rect, row: &ToggleSpec<'_>) -> (Interaction, f32) {
        let id = self.id();
        let hit = ui.hit(id, rect);
        let mid = rect.y + rect.h / 2.0;
        let lx = rect.x + 16.0;
        if let Some(hint) = row.hint {
            let top = mid - (21.0 + 2.0 + 18.75) / 2.0;
            text_in(ui, row.label, lx, top, 21.0, FOREGROUND, &style(14.0, 600));
            text_in(ui, hint, lx, top + 23.0, 18.75, HINT, &style(12.5, 500));
        } else {
            text_in(
                ui,
                row.label,
                lx,
                mid - 10.5,
                21.0,
                FOREGROUND,
                &style(14.0, 600),
            );
        }
        let switch = Rect::new(rect.x + rect.w - 16.0 - 42.0, mid - 12.0, 42.0, 24.0);
        let target = if row.checked { 1.0 } else { 0.0 };
        let slot = match self.knobs.iter().position(|(k, _)| k == row.key) {
            Some(slot) => slot,
            None => {
                self.knobs.push((
                    row.key.to_string(),
                    Transition::new(target, 0.15, (0.25, 0.1, 0.25, 1.0)),
                ));
                self.knobs.len() - 1
            }
        };
        self.knobs[slot].1.set(target);
        let t = self.knobs[slot].1.value();
        let off = Color::rgba_u8(0x3f, 0x3f, 0x46, 0xff);
        let on = Color::rgba_u8(0x34, 0xc7, 0x59, 0xff);
        let fill = Color {
            r: off.r + (on.r - off.r) * t,
            g: off.g + (on.g - off.g) * t,
            b: off.b + (on.b - off.b) * t,
            a: 1.0,
        };
        ui.quad(switch, &QuadStyle::solid(fill).radius(12.0));
        ui.quad(
            Rect::new(switch.x + 3.0 + 18.0 * t, switch.y + 3.0, 18.0, 18.0),
            &QuadStyle::solid(FOREGROUND).radius(9.0),
        );
        (hit, switch.x)
    }

    /// The new value when the row was clicked. A click on a button beside it is the button's.
    fn toggled(
        &self,
        ui: &mut Ui,
        hit: Interaction,
        beside_hovered: bool,
        checked: bool,
    ) -> Option<bool> {
        if hit.hovered && !beside_hovered {
            ui.set_cursor(CursorKind::Pointer);
        }
        (hit.clicked && !beside_hovered && !self.swallow_click).then_some(!checked)
    }

    /// A plain `Toggle`.
    fn toggle(&mut self, ui: &mut Ui, rect: Rect, row: &ToggleSpec<'_>) -> Option<bool> {
        let (hit, _) = self.toggle_row(ui, rect, row);
        self.toggled(ui, hit, false, row.checked)
    }

    /// 試聽, left of a sound's switch: plays the clip once. True while hovered.
    #[allow(clippy::too_many_arguments)]
    fn preview_button(
        &mut self,
        ui: &mut Ui,
        gpu: &Gpu,
        icons: &mut IconCache,
        switch_x: f32,
        mid: f32,
        clip: &str,
        app: &mut App,
    ) -> bool {
        // `.settings-row > button` outranks `.settings-preview` where they differ.
        let s = style(12.5, 600);
        let label_w = ui.measure("試聽", &s);
        let bw = 26.0 + 11.0 + 6.0 + label_w;
        let button = Rect::new(switch_x - 16.0 - bw, mid - 17.375, bw, 34.75);
        let id = self.id();
        let hit = ui.hit(id, button);
        let bg = if hit.hovered { 0x1a } else { 0x0f };
        ui.quad(
            button,
            &QuadStyle::solid(Color::rgba_u8(255, 255, 255, bg))
                .radius(8.0)
                .border(1.0, FIELD_BORDER),
        );
        let color = if hit.hovered {
            Color::rgba_u8(255, 255, 255, 255)
        } else {
            Color::rgba_u8(0xd4, 0xd4, 0xd8, 0xff)
        };
        icons.draw(
            ui,
            gpu,
            Icon::Play,
            Rect::new(button.x + 13.0, mid - 5.5, 11.0, 11.0),
            color,
        );
        text_in(
            ui,
            "試聽",
            button.x + 30.0,
            button.y + 8.0,
            18.75,
            color,
            &s,
        );
        if hit.hovered {
            ui.set_cursor(CursorKind::Pointer);
        }
        if hit.clicked {
            app.audio_preview(clip);
        }
        hit.hovered
    }

    #[allow(clippy::too_many_arguments)]
    fn page_general(
        &mut self,
        ui: &mut Ui,
        gpu: &Gpu,
        icons: &mut IconCache,
        app: &mut App,
        x: f32,
        y: f32,
        w: f32,
    ) {
        // 我的測站. The list arrives after the window may have opened.
        if self.tree.is_empty() {
            self.tree = stations_by_place(app);
        }
        let row_h = if self.tree.is_empty() { 48.0 } else { 53.0 };
        let (card, bottom) = self.group(
            ui,
            "我的測站",
            Some("主畫面顯示這個測站的即時震度與加速度。"),
            x,
            y,
            w,
            row_h,
        );
        let row = Rect::new(card.x + 1.0, card.y + 1.0, card.w - 2.0, row_h);
        self.station_row(ui, gpu, icons, app, row);

        // 地圖.
        let y = bottom + 24.0;
        let (card, bottom) = self.group(ui, "地圖", None, x, y, w, 57.75 * 2.0 + 1.0);
        let row = Rect::new(card.x + 1.0, card.y + 1.0, card.w - 2.0, 57.75);
        self.select_row(ui, gpu, icons, app, row);
        Self::row_divider(ui, card, row.y + row.h);
        let row = Rect::new(row.x, row.y + row.h + 1.0, row.w, 57.75);
        let checked = !app.config.checked("graphics-block-auto-zoom");
        let spec = ToggleSpec {
            key: "graphics-block-auto-zoom",
            label: "自動縮放到事件",
            hint: Some("有地震預警、檢知或報告時，地圖自動移到相關區域"),
            checked,
        };
        if let Some(on) = self.toggle(ui, row, &spec) {
            set_check(app, "graphics-block-auto-zoom", !on);
        }

        // 系統.
        let y = bottom + 24.0;
        let (card, _) = self.group(ui, "系統", None, x, y, w, 57.75);
        let row = Rect::new(card.x + 1.0, card.y + 1.0, card.w - 2.0, 57.75);
        let checked = app.config.checked("other-auto-start");
        let spec = ToggleSpec {
            key: "other-auto-start",
            label: "開機時自動啟動",
            hint: Some("登入後在背景啟動，縮在系統匣"),
            checked,
        };
        if let Some(on) = self.toggle(ui, row, &spec) {
            match crate::platform::lifecycle::set_autostart(on) {
                Ok(()) => set_check(app, "other-auto-start", on),
                Err(err) => self.say(format!("開機啟動設定失敗：{err}")),
            }
        }
    }

    fn page_alerts(&mut self, ui: &mut Ui, app: &mut App, x: f32, y: f32, w: f32) {
        let rows = 48.0 * WINDOW_EVENTS.len() as f32 + (WINDOW_EVENTS.len() - 1) as f32;
        let (card, bottom) = self.group(
            ui,
            "跳出主視窗",
            Some("主視窗縮小或隱藏時，發生以下事件會把它叫回前景。"),
            x,
            y,
            w,
            rows,
        );
        let mut ry = card.y + 1.0;
        for (i, (key, label)) in WINDOW_EVENTS.iter().enumerate() {
            if i > 0 {
                Self::row_divider(ui, card, ry);
                ry += 1.0;
            }
            let row = Rect::new(card.x + 1.0, ry, card.w - 2.0, 48.0);
            let checked = app.config.checked(key);
            let spec = ToggleSpec {
                key,
                label,
                hint: None,
                checked,
            };
            if let Some(on) = self.toggle(ui, row, &spec) {
                set_check(app, key, on);
            }
            ry += 48.0;
        }
        let y = bottom + 24.0;
        let (card, _) = self.group(ui, "語音", None, x, y, w, 57.75);
        let row = Rect::new(card.x + 1.0, card.y + 1.0, card.w - 2.0, 57.75);
        let checked = app.config.checked("other-tts");
        let spec = ToggleSpec {
            key: "other-tts",
            label: "語音播報",
            hint: Some("朗讀地震預警、震度速報與地震報告的內容"),
            checked,
        };
        if let Some(on) = self.toggle(ui, row, &spec) {
            set_check(app, "other-tts", on);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn page_sound(
        &mut self,
        ui: &mut Ui,
        gpu: &Gpu,
        icons: &mut IconCache,
        app: &mut App,
        x: f32,
        y: f32,
        w: f32,
    ) {
        let mut y = y;
        for (group, sounds) in SOUNDS {
            let rows = 57.75 * sounds.len() as f32 + (sounds.len() - 1) as f32;
            let (card, bottom) = self.group(ui, group, None, x, y, w, rows);
            let mut ry = card.y + 1.0;
            for (i, (key, label, hint, clip)) in sounds.iter().enumerate() {
                if i > 0 {
                    Self::row_divider(ui, card, ry);
                    ry += 1.0;
                }
                let row = Rect::new(card.x + 1.0, ry, card.w - 2.0, 57.75);
                let checked = app.config.checked(key);
                let spec = ToggleSpec {
                    key,
                    label,
                    hint: Some(hint),
                    checked,
                };
                let (hit, switch_x) = self.toggle_row(ui, row, &spec);
                let mid = row.y + row.h / 2.0;
                let beside = self.preview_button(ui, gpu, icons, switch_x, mid, clip, app);
                if let Some(on) = self.toggled(ui, hit, beside, checked) {
                    set_check(app, key, on);
                }
                ry += 57.75;
            }
            y = bottom + 24.0;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn action_button(
        &mut self,
        ui: &mut Ui,
        gpu: &Gpu,
        icons: &mut IconCache,
        end: f32,
        mid: f32,
        label: &str,
        icon: Option<Icon>,
        danger: bool,
    ) -> (bool, f32) {
        let s = style(14.0, 600);
        let tw = ui.measure(label, &s);
        // Nothing sizes an icon here: lucide's own 24 px.
        let icon_w = if icon.is_some() { 24.0 + 6.0 } else { 0.0 };
        let bh = if icon.is_some() { 40.0 } else { 37.0 };
        let bw = 26.0 + icon_w + tw;
        let rect = Rect::new(end - bw, mid - bh / 2.0, bw, bh);
        let id = self.id();
        let hit = ui.hit(id, rect);
        let bg = if hit.hovered { 0x1a } else { 0x0f };
        let border = if danger {
            Color::rgba_u8(0xff, 0x6b, 0x6b, 0x55)
        } else {
            FIELD_BORDER
        };
        ui.quad(
            rect,
            &QuadStyle::solid(Color::rgba_u8(255, 255, 255, bg))
                .radius(8.0)
                .border(1.0, border),
        );
        let color = if danger { DANGER } else { FOREGROUND };
        let mut tx = rect.x + 13.0;
        if let Some(icon) = icon {
            icons.draw(ui, gpu, icon, Rect::new(tx, mid - 12.0, 24.0, 24.0), color);
            tx += 30.0;
        }
        text_in(ui, label, tx, mid - 10.5, 21.0, color, &s);
        if hit.hovered {
            ui.set_cursor(CursorKind::Pointer);
        }
        (hit.clicked && !self.swallow_click, bw)
    }

    #[allow(clippy::too_many_arguments)]
    fn page_about(
        &mut self,
        ui: &mut Ui,
        gpu: &Gpu,
        icons: &mut IconCache,
        app: &mut App,
        x: f32,
        y: f32,
        w: f32,
    ) {
        let version = trem_core::version::label(env!("CARGO_PKG_VERSION"));
        let label = |ui: &mut Ui, row: Rect, text: &str| {
            text_in(
                ui,
                text,
                row.x + 16.0,
                row.y + row.h / 2.0 - 10.5,
                21.0,
                FOREGROUND,
                &style(14.0, 600),
            );
        };
        let value = |ui: &mut Ui, row: Rect, text: &str| {
            text_in(
                ui,
                text,
                row.x + row.w - 16.0,
                row.y + row.h / 2.0 - 10.5,
                21.0,
                MUTED,
                &right(style(14.0, 400)),
            );
        };
        // 版本.
        let heights = [53.0, 57.75, 48.0, 56.0, 56.0];
        let rows: f32 = heights.iter().sum::<f32>() + 4.0;
        let (card, bottom) = self.group(
            ui,
            "版本",
            Some("原生試用版沒有更新通道：這裡的檢查不會下載，也不會安裝任何東西。"),
            x,
            y,
            w,
            rows,
        );
        let mut ry = card.y + 1.0;
        let next = |ry: &mut f32, h: f32| {
            let row = Rect::new(card.x + 1.0, *ry, card.w - 2.0, h);
            *ry += h;
            row
        };
        let row = next(&mut ry, heights[0]);
        label(ui, row, "TREM Lite");
        let end = row.x + row.w - 16.0;
        let mid = row.y + row.h / 2.0;
        let (clicked, bw) = self.action_button(ui, gpu, icons, end, mid, "檢查更新", None, false);
        if clicked {
            self.say("原生試用版沒有更新通道");
        }
        text_in(
            ui,
            &version,
            end - bw - 12.0,
            mid - 10.5,
            21.0,
            MUTED,
            &right(style(14.0, 400)),
        );
        Self::row_divider(ui, card, ry);
        ry += 1.0;
        let row = next(&mut ry, heights[1]);
        let checked = app.config.checked("update-auto-restart");
        let spec = ToggleSpec {
            key: "update-auto-restart",
            label: "自動重新啟動以完成更新",
            hint: Some("新版本下載後，在沒有地震事件時自動重新啟動並套用；關閉則等下次開啟時套用"),
            checked,
        };
        if let Some(on) = self.toggle(ui, row, &spec) {
            set_check(app, "update-auto-restart", on);
        }
        Self::row_divider(ui, card, ry);
        ry += 1.0;
        let row = next(&mut ry, heights[2]);
        label(ui, row, "系統");
        value(ui, row, &self.system.clone());
        Self::row_divider(ui, card, ry);
        ry += 1.0;
        let row = next(&mut ry, heights[3]);
        label(ui, row, "回報問題時附上版本與系統");
        let (clicked, _) = self.action_button(
            ui,
            gpu,
            icons,
            row.x + row.w - 16.0,
            row.y + row.h / 2.0,
            "複製",
            Some(Icon::Copy),
            false,
        );
        if clicked {
            let text = format!("TREM Lite {version}\n{}", self.system);
            match crate::platform::lifecycle::copy_text(&text) {
                Ok(()) => self.say("已複製版本資訊"),
                Err(_) => self.say("複製失敗"),
            }
        }
        Self::row_divider(ui, card, ry);
        ry += 1.0;
        let row = next(&mut ry, heights[4]);
        label(ui, row, "日誌（最近 7 天，每小時一份）");
        let (clicked, _) = self.action_button(
            ui,
            gpu,
            icons,
            row.x + row.w - 16.0,
            row.y + row.h / 2.0,
            "開啟資料夾",
            Some(Icon::FolderOpen),
            false,
        );
        if clicked && crate::backend::logging::logs_open().is_err() {
            self.say("無法開啟日誌資料夾");
        }

        // 資料來源.
        let y = bottom + 24.0;
        let (card, bottom) = self.group(ui, "資料來源", None, x, y, w, 48.0 * 2.0 + 1.0);
        let row = Rect::new(card.x + 1.0, card.y + 1.0, card.w - 2.0, 48.0);
        label(ui, row, "地震預警、地震報告");
        value(ui, row, "交通部中央氣象署");
        Self::row_divider(ui, card, row.y + 48.0);
        let row = Rect::new(row.x, row.y + 49.0, row.w, 48.0);
        label(ui, row, "即時測站、震度速報");
        value(ui, row, "ExpTech Studio（TREM 測站網）");

        // 連結.
        let y = bottom + 24.0;
        let (card, bottom) = self.group(ui, "連結", None, x, y, w, 48.0 * 2.0 + 1.0);
        let row = Rect::new(card.x + 1.0, card.y + 1.0, card.w - 2.0, 48.0);
        label(ui, row, "原始碼與問題回報");
        self.link(ui, row, "GitHub", REPO.to_string());
        Self::row_divider(ui, card, row.y + 48.0);
        let row = Rect::new(row.x, row.y + 49.0, row.w, 48.0);
        label(ui, row, "貢獻者");
        self.link(ui, row, "查看", format!("{REPO}/graphs/contributors"));

        // 還原.
        let y = bottom + 24.0;
        let (card, _) = self.group(ui, "還原", None, x, y, w, 53.0);
        let row = Rect::new(card.x + 1.0, card.y + 1.0, card.w - 2.0, 53.0);
        label(ui, row, "將所有設定還原為預設值");
        let end = row.x + row.w - 16.0;
        let mid = row.y + row.h / 2.0;
        if self.confirm_reset {
            let (sure, bw) = self.action_button(ui, gpu, icons, end, mid, "確定還原", None, true);
            let (cancel, _) =
                self.action_button(ui, gpu, icons, end - bw - 12.0, mid, "取消", None, false);
            if cancel {
                self.confirm_reset = false;
            }
            if sure {
                self.confirm_reset = false;
                app.reset_config();
                self.say("已還原預設設定");
            }
        } else {
            let (clicked, _) = self.action_button(ui, gpu, icons, end, mid, "還原預設", None, true);
            if clicked {
                self.confirm_reset = true;
            }
        }
    }

    fn link(&mut self, ui: &mut Ui, row: Rect, label: &str, url: String) {
        let s = right(style(14.0, 600));
        let width = ui.measure(label, &s);
        let end = row.x + row.w - 16.0;
        let rect = Rect::new(end - width, row.y + row.h / 2.0 - 11.0, width, 22.0);
        let id = self.id();
        let hit = ui.hit(id, rect);
        text_in(
            ui,
            label,
            end,
            row.y + row.h / 2.0 - 10.5,
            21.0,
            PRIMARY,
            &s,
        );
        if hit.hovered {
            ui.set_cursor(CursorKind::Pointer);
        }
        if hit.clicked && !self.swallow_click {
            if let Err(err) = trem_io::paths::open_url(&url) {
                self.say(format!("打不開連結：{err}"));
            }
        }
    }

    fn select_row(&mut self, ui: &mut Ui, gpu: &Gpu, icons: &mut IconCache, app: &App, rect: Rect) {
        let mid = rect.y + rect.h / 2.0;
        let lx = rect.x + 16.0;
        let top = mid - (21.0 + 2.0 + 18.75) / 2.0;
        text_in(
            ui,
            "無地震時顯示",
            lx,
            top,
            21.0,
            FOREGROUND,
            &style(14.0, 600),
        );
        text_in(
            ui,
            "沒有地震預警、檢知或震度速報時，地圖上預設看到的內容",
            lx,
            top + 23.0,
            18.75,
            HINT,
            &style(12.5, 500),
        );
        let field_w = 14.0 * 11.5 + 42.0;
        let field = Rect::new(rect.x + rect.w - 16.0 - field_w, mid - 18.5, field_w, 37.0);
        let id = self.id();
        let hit = ui.hit(id, field);
        let border = if hit.hovered {
            Color::rgba_u8(255, 255, 255, 0x38)
        } else {
            FIELD_BORDER
        };
        ui.quad(
            field,
            &QuadStyle::solid(SHELL_BG).radius(8.0).border(1.0, border),
        );
        let text = match app.config.idle_map {
            IdleMap::Report => "地震報告",
            IdleMap::Rts => "即時測站（RTS）",
        };
        text_in(
            ui,
            text,
            field.x + 11.0,
            mid - 10.5,
            21.0,
            FOREGROUND,
            &style(14.0, 600),
        );
        icons.draw(
            ui,
            gpu,
            Icon::ChevronDown,
            Rect::new(field.x + field.w - 25.0, mid - 7.5, 15.0, 15.0),
            MUTED,
        );
        if hit.hovered {
            ui.set_cursor(CursorKind::Pointer);
        }
        if hit.clicked && !self.swallow_click {
            self.select_open = !self.select_open;
            self.select_field = field;
        }
        self.select_field = field;
    }

    fn draw_select_popup(&mut self, ui: &mut Ui, app: &mut App) {
        if !self.select_open || self.tab != Tab::General {
            return;
        }
        let field = self.select_field;
        let options = [
            (IdleMap::Report, "地震報告"),
            (IdleMap::Rts, "即時測站（RTS）"),
        ];
        let popup = Rect::new(field.x, field.y + field.h + 4.0, field.w, 8.0 + 2.0 * 34.0);
        ui.quad(
            popup,
            &QuadStyle::solid(CARD_BG)
                .radius(10.0)
                .border(1.0, Color::rgba_u8(255, 255, 255, 0x24))
                .shadow(0.0, 12.0, 32.0, Color::rgba_u8(0, 0, 0, 0xaa)),
        );
        let mut y = popup.y + 4.0;
        let mut picked = false;
        for (value, label) in options {
            let rect = Rect::new(popup.x + 4.0, y, popup.w - 8.0, 34.0);
            let id = self.id();
            let hit = ui.hit(id, rect);
            if hit.hovered {
                ui.quad(
                    rect,
                    &QuadStyle::solid(Color::rgba_u8(255, 255, 255, 0x0d)).radius(6.0),
                );
                ui.set_cursor(CursorKind::Pointer);
            }
            let color = if app.config.idle_map == value {
                PRIMARY
            } else {
                FOREGROUND
            };
            text_in(
                ui,
                label,
                rect.x + 8.0,
                rect.y + 6.5,
                21.0,
                color,
                &style(14.0, 600),
            );
            if hit.clicked {
                picked = true;
                if app.config.idle_map != value {
                    let mut next = app.config.clone();
                    next.idle_map = value;
                    app.write_config(next);
                }
            }
            y += 34.0;
        }
        let (px, py) = ui.pointer();
        if picked
            || (ui.mouse_just_released() && !popup.contains(px, py) && !field.contains(px, py))
        {
            self.select_open = false;
        }
    }

    fn station_row(
        &mut self,
        ui: &mut Ui,
        gpu: &Gpu,
        icons: &mut IconCache,
        app: &App,
        rect: Rect,
    ) {
        let mid = rect.y + rect.h / 2.0;
        if self.tree.is_empty() {
            text_in(
                ui,
                "測站清單載入中，請稍後再開啟設定",
                rect.x + 16.0,
                mid - 10.5,
                21.0,
                FOREGROUND,
                &style(14.0, 600),
            );
            return;
        }
        text_in(
            ui,
            "測站",
            rect.x + 16.0,
            mid - 10.5,
            21.0,
            FOREGROUND,
            &style(14.0, 600),
        );
        let chosen = StationId::new(&app.config.station_id);
        let path = chosen
            .and_then(|id| self.path_of(id))
            .unwrap_or_else(|| "請選擇".to_string());
        let field_x = rect.x + 16.0 + 28.0 + 16.0;
        let s = style(14.0, 400);
        let tw = ui.measure(&path, &s);
        let max_w = rect.x + rect.w - 16.0 - field_x;
        let field_w = (tw + 45.0).min(max_w);
        let field = Rect::new(field_x + max_w - field_w, mid - 18.5, field_w, 37.0);
        let id = self.id();
        let hit = ui.hit(id, field);
        let border = if self.menu.is_some() {
            Color::rgba_u8(0xbe, 0xff, 0x0c, 0x80)
        } else if hit.hovered {
            Color::rgba_u8(255, 255, 255, 0x38)
        } else {
            FIELD_BORDER
        };
        ui.quad(
            field,
            &QuadStyle::solid(SHELL_BG).radius(8.0).border(1.0, border),
        );
        text_cut(
            ui,
            &path,
            field.x + 11.0,
            mid - 10.5,
            21.0,
            field_w - 45.0,
            FOREGROUND,
            &s,
        );
        icons.draw(
            ui,
            gpu,
            Icon::ChevronDown,
            Rect::new(field.x + field.w - 26.0, mid - 7.5, 15.0, 15.0),
            MUTED,
        );
        if hit.hovered {
            ui.set_cursor(CursorKind::Pointer);
        }
        if hit.clicked && !self.swallow_click {
            self.menu = if self.menu.is_some() {
                None
            } else {
                let here = chosen.and_then(|id| self.town_of(id));
                Some(Menu {
                    place: place_by(ui, field),
                    city: here.map(|h| h.0),
                    town: here.filter(|h| h.2 > 1).map(|h| h.1),
                })
            };
        }
    }

    fn town_of(&self, id: StationId) -> Option<(&'static str, &'static str, usize)> {
        for city in &self.tree {
            for town in &city.towns {
                if town.ids.contains(&id) {
                    return Some((city.city, town.town, town.ids.len()));
                }
            }
        }
        None
    }

    fn path_of(&self, id: StationId) -> Option<String> {
        let (city, town, count) = self.town_of(id)?;
        Some(if count > 1 {
            format!("{city} › {town} › {id}")
        } else {
            format!("{city} › {town}")
        })
    }

    /// The cascading menu: cities; beside the one picked, its towns; beside the town
    /// picked, only where it has several, its stations.
    fn draw_menu(&mut self, ui: &mut Ui, gpu: &Gpu, icons: &mut IconCache, app: &mut App) {
        // A swallowed click ends with the button's release.
        if self.swallow_click && ui.mouse_just_released() {
            self.swallow_click = false;
        }
        let Some(menu) = &self.menu else {
            return;
        };
        if self.tab != Tab::General {
            self.menu = None;
            return;
        }
        let place = menu.place;
        let (city, town) = (menu.city, menu.town);
        let chosen = StationId::new(&app.config.station_id);
        let here = chosen.and_then(|id| self.town_of(id));

        let towns: Vec<(&'static str, usize)> = self
            .tree
            .iter()
            .find(|c| Some(c.city) == city)
            .map(|c| c.towns.iter().map(|t| (t.town, t.ids.len())).collect())
            .unwrap_or_default();
        let ids: Vec<StationId> = self
            .tree
            .iter()
            .find(|c| Some(c.city) == city)
            .and_then(|c| c.towns.iter().find(|t| Some(t.town) == town))
            .map(|t| t.ids.clone())
            .unwrap_or_default();

        let columns = 1 + usize::from(city.is_some()) + usize::from(ids.len() > 1);
        let rect = Rect::new(
            place.x,
            place.y,
            MENU_COLUMN * columns as f32 + 2.0,
            place.h,
        );
        ui.hit(WidgetId(93), rect);
        ui.quad(
            rect,
            &QuadStyle::solid(CARD_BG)
                .radius(10.0)
                .border(1.0, Color::rgba_u8(255, 255, 255, 0x24))
                .shadow(0.0, 12.0, 32.0, Color::rgba_u8(0, 0, 0, 0xaa)),
        );
        let mut picked_city = None;
        let mut picked_town = None;
        let mut picked_id = None;

        let cities: Vec<&'static str> = self.tree.iter().map(|c| c.city).collect();
        let col = Rect::new(place.x + 1.0, place.y + 1.0, MENU_COLUMN, place.h - 2.0);
        menu_column(
            ui,
            gpu,
            icons,
            WidgetId(94),
            col,
            "縣市",
            cities.len(),
            |ui, gpu, icons, i, row, hit| {
                let c = cities[i];
                menu_item(
                    ui,
                    row,
                    c,
                    city == Some(c),
                    here.is_some_and(|h| h.0 == c),
                    hit.hovered,
                );
                icons.draw(
                    ui,
                    gpu,
                    Icon::ChevronRight,
                    Rect::new(row.x + row.w - 22.0, row.y + 10.5, 14.0, 14.0),
                    HINT,
                );
                if hit.clicked {
                    picked_city = Some(c);
                }
            },
        );

        if city.is_some() {
            let col = Rect::new(col.x + MENU_COLUMN, col.y, MENU_COLUMN, col.h);
            ui.quad(Rect::new(col.x, col.y, 1.0, col.h), &QuadStyle::solid(LINE));
            menu_column(
                ui,
                gpu,
                icons,
                WidgetId(95),
                col,
                "鄉鎮市區",
                towns.len(),
                |ui, gpu, icons, i, row, hit| {
                    let (t, count) = towns[i];
                    menu_item(
                        ui,
                        row,
                        t,
                        town == Some(t),
                        here.is_some_and(|h| Some(h.0) == city && h.1 == t),
                        hit.hovered,
                    );
                    if count > 1 {
                        icons.draw(
                            ui,
                            gpu,
                            Icon::ChevronRight,
                            Rect::new(row.x + row.w - 22.0, row.y + 10.5, 14.0, 14.0),
                            HINT,
                        );
                        text_in(
                            ui,
                            &format!("{count} 站"),
                            row.x + row.w - 24.0,
                            row.y + 8.5,
                            18.0,
                            HINT,
                            &right(style(12.0, 500)),
                        );
                    }
                    if hit.clicked {
                        picked_town = Some((t, count));
                    }
                },
            );
        }

        if ids.len() > 1 {
            let col = Rect::new(col.x + 2.0 * MENU_COLUMN, col.y, MENU_COLUMN, col.h);
            ui.quad(Rect::new(col.x, col.y, 1.0, col.h), &QuadStyle::solid(LINE));
            menu_column(
                ui,
                gpu,
                icons,
                WidgetId(96),
                col,
                "測站",
                ids.len(),
                |ui, _gpu, _icons, i, row, hit| {
                    let id = ids[i];
                    menu_item(ui, row, id.as_str(), false, Some(id) == chosen, hit.hovered);
                    if hit.clicked {
                        picked_id = Some(id);
                    }
                },
            );
        }

        if let Some(menu) = &mut self.menu {
            if let Some(c) = picked_city {
                if menu.city != Some(c) {
                    menu.city = Some(c);
                    menu.town = None;
                }
            }
        }
        if let Some((t, count)) = picked_town {
            if count == 1 {
                let only = self
                    .tree
                    .iter()
                    .find(|c| Some(c.city) == city)
                    .and_then(|c| c.towns.iter().find(|tw| tw.town == t))
                    .and_then(|tw| tw.ids.first().copied());
                picked_id = only;
            } else if let Some(menu) = &mut self.menu {
                menu.town = Some(t);
            }
        }
        if let Some(id) = picked_id {
            self.menu = None;
            if Some(id) != chosen {
                let mut next = app.config.clone();
                next.station_id = id.to_string();
                app.write_config(next);
            }
            return;
        }
        // A press outside only closes the menu; a click meant for what lies under is
        // not passed on.
        let (px, py) = ui.pointer();
        if ui.mouse_just_pressed() && !rect.contains(px, py) {
            self.menu = None;
            self.swallow_click = true;
        }
    }

    /// Esc closes a popup. Nothing else on this page takes a key.
    pub fn on_escape(&mut self) {
        self.menu = None;
        self.select_open = false;
    }
}

fn menu_item(ui: &mut Ui, row: Rect, text: &str, open: bool, current: bool, hovered: bool) {
    if open || hovered {
        let alpha = if open { 0x1a } else { 0x0d };
        ui.quad(row, &QuadStyle::solid(Color::rgba_u8(255, 255, 255, alpha)));
    }
    let (color, weight) = if current {
        (PRIMARY, 700)
    } else {
        (FOREGROUND, 400)
    };
    text_cut(
        ui,
        text,
        row.x + 12.0,
        row.y + 7.0,
        21.0,
        row.w - 44.0,
        color,
        &style(14.0, weight),
    );
}

/// One column of the menu: its header, and a scrolling list of rows.
#[allow(clippy::too_many_arguments)]
fn menu_column(
    ui: &mut Ui,
    gpu: &Gpu,
    icons: &mut IconCache,
    id: WidgetId,
    rect: Rect,
    title: &str,
    count: usize,
    mut row: impl FnMut(&mut Ui, &Gpu, &mut IconCache, usize, Rect, super::Interaction),
) {
    const HEADER: f32 = 32.0;
    const ROW: f32 = 35.0;
    let list = Rect::new(rect.x, rect.y + HEADER, rect.w, rect.h - HEADER);
    ui.hit(id, list);
    let scroll = ui.scroll_offset(id, list, (count as f32 * ROW - list.h).max(0.0));
    ui.push_clip(rect);
    text_in(
        ui,
        title,
        rect.x + 12.0,
        rect.y + 8.0,
        18.0,
        HINT,
        &style(12.0, 700),
    );
    ui.pop_clip();
    ui.push_clip(list);
    for i in 0..count {
        let y = list.y - scroll + i as f32 * ROW;
        if y + ROW < list.y || y > list.y + list.h {
            continue;
        }
        let r = Rect::new(list.x + 1.0, y, list.w - 1.0, ROW);
        let hit = ui.hit(WidgetId(id.0 * 1000 + i as u64), r);
        if hit.hovered {
            ui.set_cursor(CursorKind::Pointer);
        }
        row(ui, gpu, icons, i, r, hit);
    }
    ui.pop_clip();
}

/// Under the field, or over it when there is more room there. Its left edge is the
/// field's, moved left where three columns would run off the window.
fn place_by(ui: &Ui, field: Rect) -> Rect {
    const GAP: f32 = 6.0;
    const MARGIN: f32 = 8.0;
    let (w, h) = (ui.width(), ui.height());
    let x = field
        .x
        .min(w - MARGIN - 3.0 * MENU_COLUMN - 2.0)
        .max(MARGIN);
    let below = h - (field.y + field.h) - GAP - MARGIN;
    let above = field.y - GAP - MARGIN;
    if below >= MENU_MAX_H.min(240.0) || below >= above {
        Rect::new(x, field.y + field.h + GAP, 0.0, below.min(MENU_MAX_H))
    } else {
        let height = above.min(MENU_MAX_H);
        Rect::new(x, field.y - GAP - height, 0.0, height)
    }
}

fn set_check(app: &mut App, key: &str, value: bool) {
    let mut next: Config = app.config.clone();
    next.check_box.insert(key.to_string(), value);
    app.write_config(next);
}
