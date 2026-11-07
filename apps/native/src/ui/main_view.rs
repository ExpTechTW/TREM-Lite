//! The main window's overlays over the map (overlays/*.tsx, styles/globals.css). The sizes
//! are the stylesheet's; `narrow` is its `max-width: 980px` block.

use std::rc::Rc;

use super::icons::{Icon, IconCache};
use super::widgets::{
    badge, centered, draw_tooltip, line_baseline, magnitude_mark, right, style, text_cut, text_in,
    text_normal, Transition, LIGHT, NORMAL_LINE_HAN, PANEL_BG, PANEL_BORDER, WARNING,
};
use super::{Color, CursorKind, QuadStyle, Rect, Ui, WidgetId};
use crate::app::App;
use crate::domain::constants::{intensity_color, intensity_text, INTENSITY_LIST};
use crate::domain::types::ReportListItem;
use crate::domain::utils::{extract_location, format_report_time, format_time};
use crate::render::Gpu;
use crate::variable::{EewDisplay, EewStatus, TriggerDisplay};

const WARN: Color = Color::rgba_u8(0xff, 0xaa, 0x00, 0xff);
const ALERT: Color = Color::rgba_u8(0xff, 0x00, 0x00, 0xff);
const CANCEL: Color = Color::rgba_u8(0, 0, 0, 0xff);
const TRIGGER_LOW: Color = Color::rgba_u8(0x1e, 0x96, 0x32, 0xff);
const TRIGGER_MIDDLE: Color = Color::rgba_u8(0xff, 0xc8, 0x00, 0xff);
const TRIGGER_HIGH: Color = Color::rgba_u8(0xc0, 0x00, 0x00, 0xff);

const ID_REPORT_TOGGLE: WidgetId = WidgetId(1);
const ID_REPORT_PANEL: WidgetId = WidgetId(2);
const ID_REPORT_LIST: WidgetId = WidgetId(3);
const ID_NAV_SETTINGS: WidgetId = WidgetId(4);
const ID_NAV_FOCUS: WidgetId = WidgetId(5);
const ID_UPDATE: WidgetId = WidgetId(6);
const ID_LIGHT_EEW: WidgetId = WidgetId(7);
const ID_LIGHT_RTS: WidgetId = WidgetId(8);
const ID_REPORT_CARD: u64 = 1000;
const ID_REPORT_OPEN: u64 = 2000;
const ID_REPORT_REPLAY: u64 = 3000;

/// What was clicked. Carried out after the frame.
pub enum Action {
    OpenSettings,
    FocusReset,
    RestartForUpdate,
    OpenReport(Rc<ReportListItem>),
    Replay(Rc<ReportListItem>),
}

pub struct MainView {
    report_open: bool,
    panel_shift: Transition,
    side_shift: Transition,
}

impl MainView {
    /// Below 1080 px the panel starts collapsed, so it does not cover most of the map.
    pub fn new(width: f32) -> Self {
        let open = width >= 1080.0;
        let closed = if open { 0.0 } else { 1.0 };
        Self {
            report_open: open,
            panel_shift: Transition::new(closed, 0.2, (0.3, 0.0, 0.8, 0.15)),
            side_shift: Transition::new(closed, 0.6, (0.25, 0.1, 0.25, 1.0)),
        }
    }

    pub fn draw(
        &mut self,
        ui: &mut Ui,
        gpu: &Gpu,
        icons: &mut IconCache,
        app: &mut App,
        actions: &mut Vec<Action>,
    ) {
        let narrow = ui.width() <= 980.0;
        draw_legend(ui);
        draw_max(ui, app, narrow);
        draw_station(ui, app, narrow);
        self.draw_report_panel(ui, gpu, icons, app, narrow, actions);
        let closed = self.side_shift.value();
        draw_rts_list(ui, app, narrow, closed);
        draw_warnings(ui, gpu, icons, app, narrow, closed);
        draw_nav(ui, gpu, icons, app, actions);
        draw_version(ui, narrow, closed);
        let eew = app.ui.current_eew.clone();
        let trigger = app.ui.current_trigger.clone();
        eew_panel(ui, eew.as_ref(), trigger.as_ref(), narrow);
        draw_tooltip(ui);
    }

    /// Something is moving: another frame soon.
    pub fn animating(&self, app: &App) -> bool {
        self.transitioning() || app.active_replay_report().is_some()
    }

    /// The drawer is moving: every frame, not only a few.
    pub fn transitioning(&self) -> bool {
        self.panel_shift.running() || self.side_shift.running()
    }

    fn draw_report_panel(
        &mut self,
        ui: &mut Ui,
        gpu: &Gpu,
        icons: &mut IconCache,
        app: &mut App,
        narrow: bool,
        actions: &mut Vec<Action>,
    ) {
        let width = ui.width();
        let height = ui.height();
        let (panel_w, shift_pct) = if narrow { (292.0, 0.92) } else { (340.0, 0.93) };
        let x = width - panel_w + panel_w * shift_pct * self.panel_shift.value();
        let panel = Rect::new(x, 0.0, panel_w, height);
        ui.hit(ID_REPORT_PANEL, panel);

        // The list.
        let (list_w, list_right) = if narrow { (275.0, -13.0) } else { (310.0, 0.0) };
        let list = Rect::new(x + panel_w - list_right - list_w, 0.0, list_w, height);
        ui.quad(
            list,
            &QuadStyle::solid(Color::rgba_u8(0x46, 0x46, 0x46, 0xd9)),
        );
        let reports = app.var.data.report.clone();
        let survey = (app.var.cache.intensity_time != 0.0)
            .then_some((app.var.cache.intensity_time, app.var.cache.intensity_max));
        let inner = Rect::new(list.x + 3.0, list.y + 2.0, list.w - 6.0, list.h - 5.0);
        let card_w = if narrow { inner.w * 0.95 } else { inner.w };
        let featured_h = if narrow { 113.4 } else { 125.4 };
        const ROW_H: f32 = 52.0;
        const GAP: f32 = 4.0;
        let total = survey.map_or(0.0, |_| featured_h + GAP)
            + reports
                .iter()
                .enumerate()
                .map(|(i, _)| {
                    if i == 0 && survey.is_none() {
                        featured_h + GAP
                    } else {
                        ROW_H + GAP
                    }
                })
                .sum::<f32>();
        let list_hit = ui.hit(ID_REPORT_LIST, list);
        let max_scroll = (total - inner.h).max(0.0);
        let scroll = ui.scroll_offset(ID_REPORT_LIST, list, max_scroll);
        ui.push_clip(list);
        let mut y = inner.y - scroll;
        if let Some((time, max)) = survey {
            survey_card(ui, inner.x, y, card_w, featured_h, time, max, narrow);
            y += featured_h + GAP;
        }
        let active = app.active_replay_report().map(str::to_string);
        for (index, report) in reports.iter().enumerate() {
            let is_featured = index == 0 && survey.is_none();
            let h = if is_featured { featured_h } else { ROW_H };
            // Only what the list shows is laid out.
            if y + h >= 0.0 && y <= height {
                let rect = Rect::new(inner.x, y, card_w, h);
                let flashing = active.as_deref() == Some(report.id.as_str());
                if flashing {
                    flash_ring(ui, rect);
                }
                if is_featured {
                    featured_card(ui, rect, report, narrow);
                } else {
                    compact_card(ui, rect, report, narrow);
                }
                card_actions(ui, rect, report, index as u64, actions);
            }
            y += h + GAP;
        }
        ui.pop_clip();
        // A thin scrollbar while the pointer is over the list.
        if max_scroll > 0.0 && list_hit.hovered {
            let track = Rect::new(list.x + list.w - 6.0, 0.0, 6.0, height);
            ui.quad(
                track,
                &QuadStyle::solid(Color::rgba_u8(0x46, 0x46, 0x46, 0xff)),
            );
            let thumb_h = (height * height / (total + 5.0)).max(24.0);
            let thumb_y = (height - thumb_h) * (scroll / max_scroll);
            ui.quad(
                Rect::new(track.x + 1.0, thumb_y, 4.0, thumb_h),
                &QuadStyle::solid(Color::rgba_u8(0xaa, 0xaa, 0xaa, 0xff)).radius(2.0),
            );
        }

        // The toggle, above the list's left edge.
        let toggle = Rect::new(x, 5.0, 20.0, 20.0);
        let hit = ui.hit(ID_REPORT_TOGGLE, toggle);
        if hit.hovered {
            ui.set_cursor(CursorKind::Pointer);
            ui.set_tooltip("地震報告");
        }
        if hit.clicked {
            self.report_open = !self.report_open;
            let closed = if self.report_open { 0.0 } else { 1.0 };
            self.panel_shift.set(closed);
            self.side_shift.set(closed);
        }
        ui.quad(toggle, &QuadStyle::solid(LIGHT));
        let chevron = if self.report_open {
            Icon::ChevronRight
        } else {
            Icon::ChevronLeft
        };
        icons.draw(
            ui,
            gpu,
            chevron,
            Rect::new(x + 2.0, 7.0, 16.0, 16.0),
            Color::rgba_u8(0x46, 0x46, 0x46, 0xff),
        );
    }
}

/// `legacy-report-flash`: a 3 px ring pulsing every 1.5 s.
fn flash_ring(ui: &mut Ui, rect: Rect) {
    let phase = (chrono::Utc::now().timestamp_millis() % 1500) as f32 / 1500.0;
    let t = if phase < 0.5 {
        phase * 2.0
    } else {
        (1.0 - phase) * 2.0
    };
    let eased = super::widgets::cubic_bezier(0.25, 0.1, 0.25, 1.0, t);
    let ring = Rect::new(rect.x - 3.0, rect.y - 3.0, rect.w + 6.0, rect.h + 6.0);
    ui.quad(
        ring,
        &QuadStyle::solid(Color::rgba_u8(0xff, 0xca, 0x00, (eased * 255.0) as u8)).radius(18.0),
    );
}

fn card_frame(ui: &mut Ui, rect: Rect) {
    ui.quad(
        rect,
        &QuadStyle::solid(Color::rgba_u8(0x29, 0x29, 0x29, 0xff))
            .radius(15.0)
            .border(1.0, Color::rgba_u8(255, 255, 255, 0x38)),
    );
}

fn is_numbered(item: &ReportListItem) -> bool {
    !item.id.split('-').next().unwrap_or("").contains("000")
}

fn mag_text(item: &ReportListItem) -> String {
    if item.mag == 0.0 {
        "--".to_string()
    } else {
        format!("{:.1}", item.mag)
    }
}

/// The featured card's left column: the badge and its label.
fn featured_badge(ui: &mut Ui, x: f32, y: f32, i: i32, narrow: bool) -> f32 {
    let (size, font) = if narrow { (78.0, 40.0) } else { (80.0, 48.0) };
    // The label is wider than the badge, which centres over it.
    let label = "觀測最大震度";
    let s = centered(style(13.0, 700));
    let width = 78.0_f32.max(size);
    badge(
        ui,
        Rect::new(x + (width - size) / 2.0, y, size, size),
        i,
        12.0,
        font,
        false,
    );
    text_in(ui, label, x + width / 2.0, y + size + 3.9, 19.5, LIGHT, &s);
    width
}

#[allow(clippy::too_many_arguments)]
fn survey_card(ui: &mut Ui, x: f32, y: f32, w: f32, h: f32, time: f64, max: i32, narrow: bool) {
    let rect = Rect::new(x, y, w, h);
    card_frame(ui, rect);
    let pad = if narrow { 7.0 } else { 11.0 };
    let (cx, cy) = (rect.x + pad, rect.y + pad);
    let left = featured_badge(ui, cx, cy, max, narrow);
    let tx = cx + left + 16.0;
    let tw = rect.x + rect.w - pad - tx;
    text_cut(ui, "震源調查中", tx, cy, 35.0, tw, LIGHT, &style(28.0, 700));
    text_in(
        ui,
        &format_report_time(time),
        tx,
        cy + 35.0,
        19.5,
        LIGHT,
        &style(13.0, 700),
    );
}

fn featured_card(ui: &mut Ui, rect: Rect, report: &ReportListItem, narrow: bool) {
    card_frame(ui, rect);
    let pad = if narrow { 7.0 } else { 11.0 };
    let (cx, cy) = (rect.x + pad, rect.y + pad);
    let left = featured_badge(ui, cx, cy, report.int, narrow);
    let tx = cx + left + 16.0;
    let tw = rect.x + rect.w - pad - tx;
    let loc = extract_location(&report.loc);
    text_cut(ui, &loc, tx, cy, 35.0, tw, LIGHT, &style(28.0, 700));
    text_in(
        ui,
        &format_report_time(report.time),
        tx,
        cy + 35.0,
        19.5,
        LIGHT,
        &style(13.0, 700),
    );
    // The bottom row sits on one baseline at the column's foot.
    let baseline = rect.y + rect.h - pad - 11.0;
    let mag_color = if is_numbered(report) { WARNING } else { LIGHT };
    let prefix = style(30.0, 700);
    let prefix_w = magnitude_mark(ui, tx, baseline, mag_color, &prefix);
    ui.text(
        &mag_text(report),
        tx + prefix_w + 4.0,
        baseline,
        mag_color,
        &prefix,
    );
    let end = rect.x + rect.w - pad;
    let km = style(14.0, 400);
    let km_w = ui.measure("km", &km);
    ui.text("km", end - km_w, baseline, LIGHT, &km);
    let depth = right(style(24.0, 700));
    ui.text(
        &report.depth.to_string(),
        end - km_w - 4.0,
        baseline,
        LIGHT,
        &depth,
    );
}

fn compact_card(ui: &mut Ui, rect: Rect, item: &ReportListItem, narrow: bool) {
    card_frame(ui, rect);
    let inner_y = rect.y + 1.0;
    badge(
        ui,
        Rect::new(rect.x + 1.0, inner_y, 55.0, 50.0),
        item.int,
        12.0,
        30.0,
        false,
    );
    let tx = rect.x + 1.0 + 55.0 + 8.0;
    let end = rect.x + rect.w - 1.0 - 4.8;
    let loc = extract_location(&item.loc);
    let block = inner_y + (50.0 - 45.75) / 2.0;
    let loc_w = (end - 60.0 - tx).min(180.0);
    let loc_size = if narrow { 19.0 } else { 21.0 };
    text_cut(
        ui,
        &loc,
        tx,
        block,
        26.25,
        loc_w,
        LIGHT,
        &style(loc_size, 700),
    );
    text_in(
        ui,
        &format_report_time(item.time),
        tx,
        block + 26.25,
        19.5,
        LIGHT,
        &style(13.0, 700),
    );
    let color = if is_numbered(item) { WARNING } else { LIGHT };
    let mag = style(20.0, 700);
    let number = mag_text(item);
    let number_w = ui.measure(&number, &mag);
    let prefix_w = ui.measure("𝖬", &mag);
    let line_top = inner_y + 10.0;
    text_in(ui, &number, end - number_w, line_top, 30.0, color, &mag);
    magnitude_mark(
        ui,
        end - number_w - 4.0 - prefix_w,
        line_baseline(line_top, 30.0, mag.size),
        color,
        &mag,
    );
}

/// The two buttons over a hovered card.
fn card_actions(
    ui: &mut Ui,
    rect: Rect,
    item: &Rc<ReportListItem>,
    index: u64,
    actions: &mut Vec<Action>,
) {
    let card = ui.hit(WidgetId(ID_REPORT_CARD + index), rect);
    let open_id = WidgetId(ID_REPORT_OPEN + index);
    let replay_id = WidgetId(ID_REPORT_REPLAY + index);
    let (mouse_x, mouse_y) = ui.pointer();
    let over = rect.contains(mouse_x, mouse_y);
    if !(over || card.hovered) {
        return;
    }
    ui.set_cursor(CursorKind::Pointer);
    ui.quad(
        rect,
        &QuadStyle::solid(Color::rgba_u8(0x29, 0x29, 0x29, 0xc4)).radius(15.0),
    );
    let s = style(16.0, 400);
    let open_label = if item.trem != 0.0 { "檢知" } else { "報告" };
    let w = |ui: &mut Ui, text: &str| ui.measure(text, &s) + 8.0;
    let (open_w, replay_w) = (w(ui, open_label), w(ui, "重播"));
    // `space-evenly`.
    let gap = (rect.w - open_w - replay_w) / 3.0;
    let y = rect.y + (rect.h - 22.0) / 2.0;
    let open = Rect::new(rect.x + gap, y, open_w, 22.0);
    let replay = Rect::new(open.x + open_w + gap, y, replay_w, 22.0);
    for (id, button, label, is_open) in [
        (open_id, open, open_label, true),
        (replay_id, replay, "重播", false),
    ] {
        let hit = ui.hit(id, button);
        ui.quad(
            button,
            &QuadStyle::solid(if hit.hovered {
                Color::rgba_u8(0x25, 0x24, 0x24, 0xff)
            } else {
                Color::rgba_u8(0x50, 0x50, 0x50, 0xff)
            })
            .radius(5.0)
            .border(1.0, Color::rgba_u8(255, 255, 255, 0x47)),
        );
        text_in(ui, label, button.x + 4.0, button.y - 1.0, 24.0, LIGHT, &s);
        if hit.clicked {
            actions.push(if is_open {
                Action::OpenReport(Rc::clone(item))
            } else {
                Action::Replay(Rc::clone(item))
            });
        }
    }
}

/// The intensity scale at the left (overlays/IntensityLegend.tsx).
fn draw_legend(ui: &mut Ui) {
    let bottom = ui.height() - 40.0 - 16.0;
    let list_h = 210.0;
    let top = bottom - list_h;
    let row = list_h / 9.0;
    let s = style(13.0, 400);
    let dim = Color::rgba_u8(255, 255, 255, 0x91);
    let border = Color::rgba_u8(0x2b, 0x2b, 0x2b, 0xff);
    let text_x = 33.0;
    for (i, label) in INTENSITY_LIST.iter().enumerate().skip(1) {
        let k = 9 - i;
        let li_top = top + k as f32 * row;
        // A continuous strip: each level fades into the one below.
        let strip_top = li_top + 8.0;
        let strip = Rect::new(5.0, strip_top, 12.0, row);
        ui.quad(strip, &QuadStyle::solid(border));
        let top_color = intensity_color(i as u8);
        let bottom_color = intensity_color(i as u8 - 1);
        ui.quad(
            Rect::new(6.0, strip_top, 10.0, row),
            &QuadStyle::solid(top_color).gradient(bottom_color, 180.0),
        );
        ui.quad(Rect::new(17.0, strip_top, 5.0, 1.0), &QuadStyle::solid(dim));
        text_in(ui, label, text_x, li_top, 19.5, dim, &s);
    }
    ui.quad(
        Rect::new(5.0, top + 8.0 - 1.0, 12.0, 1.0),
        &QuadStyle::solid(border),
    );
    ui.quad(
        Rect::new(5.0, top + 8.0 + list_h, 12.0, 1.0),
        &QuadStyle::solid(border),
    );
}

fn card_style() -> QuadStyle {
    QuadStyle::solid(PANEL_BG)
        .radius(5.0)
        .border(1.0, PANEL_BORDER)
}

/// overlays/MaxIntensity.tsx.
fn draw_max(ui: &mut Ui, app: &App, narrow: bool) {
    let (max_i, pga, pga_i) = (
        app.ui.max_intensity.0,
        app.ui.max_pga,
        app.ui.max_pga_intensity.clamp(0, 9) as u8,
    );
    let pga_text = format!("{pga:.2} gal");
    if narrow {
        // Column-reverse: the PGA first, then the intensity under it, side by side.
        let top = 228.0;
        let left = 4.0;
        // PGA: content 70 × 35, shifted right 4.5 rem.
        let pga_rect = Rect::new(left + 72.0, top - 1.0, 72.0, 37.0);
        ui.quad(pga_rect, &card_style());
        let title = centered(style(12.0, 500));
        let center = pga_rect.x + pga_rect.w / 2.0;
        // The column is taller than the 35 px inside it, and overflows evenly.
        text_normal(ui, "最大加速度", center, pga_rect.y - 1.5, LIGHT, &title);
        let band = Rect::new(pga_rect.x + 1.0, pga_rect.y + 21.0, 70.0, 20.0);
        ui.quad(
            band,
            &QuadStyle::solid(intensity_color(pga_i)).radii(0.0, 0.0, 5.0, 5.0),
        );
        text_in(
            ui,
            &pga_text,
            center,
            band.y,
            20.0,
            intensity_text(pga_i),
            &centered(style(12.0, 500)),
        );
        // Intensity: content 72 wide, padding 3.
        let int_rect = Rect::new(left, top + 36.0 + 4.0, 80.0, 75.5);
        ui.quad(int_rect, &card_style());
        let center = int_rect.x + int_rect.w / 2.0;
        text_normal(ui, "最大觀測震度", center, int_rect.y + 4.0, LIGHT, &title);
        badge(
            ui,
            Rect::new(center - 22.5, int_rect.y + 4.0 + 17.5 + 5.0, 45.0, 45.0),
            max_i,
            12.0,
            27.0,
            true,
        );
        return;
    }
    let (x, y) = (4.0, 164.0);
    let card = Rect::new(x, y, 103.0, 128.0);
    ui.quad(card, &card_style());
    let center = x + 103.0 / 2.0;
    let title = centered(style(14.0, 500));
    let title_top = y + 1.0 + 8.0;
    let line = text_normal(ui, "最大觀測震度", center, title_top, LIGHT, &title);
    badge(
        ui,
        Rect::new(center - 42.5, title_top + line + 5.0, 85.0, 85.0),
        max_i,
        12.0,
        50.0,
        true,
    );
    let pga_rect = Rect::new(x, y + 128.0 + 3.0, 103.0, 48.0);
    ui.quad(pga_rect, &card_style());
    // A column centred in the 46 px inside: the title, 5 px, then the 20 px band.
    let block = 14.0 * NORMAL_LINE_HAN + 5.0 + 20.0;
    let block_top = pga_rect.y + 1.0 + (46.0 - block) / 2.0;
    text_normal(ui, "最大加速度", center, block_top, LIGHT, &title);
    let band = Rect::new(
        pga_rect.x + 1.0,
        block_top + 14.0 * NORMAL_LINE_HAN + 5.0,
        101.0,
        20.0,
    );
    ui.quad(
        band,
        &QuadStyle::solid(intensity_color(pga_i)).radii(0.0, 0.0, 5.0, 5.0),
    );
    text_in(
        ui,
        &pga_text,
        center,
        band.y,
        20.0,
        intensity_text(pga_i),
        &centered(style(12.0, 500)),
    );
}

/// overlays/StationReadout.tsx.
fn draw_station(ui: &mut Ui, app: &App, narrow: bool) {
    let station = app.ui.current_station.as_ref();
    let (left, top, content_w, content_h) = if narrow {
        (4.8, 176.8 + 1.0, 175.0, 40.0)
    } else {
        (110.4, 160.0 + 5.0, 224.0, 47.5)
    };
    let card = Rect::new(left, top, content_w + 6.0, content_h + 6.0);
    ui.quad(card, &card_style());
    let (content_x, content_y) = (card.x + 3.0, card.y + 3.0);
    let (badge_size, badge_font) = if narrow { (40.0, 25.0) } else { (45.0, 25.0) };
    badge(
        ui,
        Rect::new(content_x, content_y, badge_size, badge_size),
        station.map_or(0, |s| s.i),
        5.0,
        badge_font,
        false,
    );
    let (info_w, info_right) = if narrow { (130.0, 0.0) } else { (160.0, 3.0) };
    let info_x = content_x + content_w - info_right - info_w;
    let (loc_size, row_size) = if narrow { (14.0, 12.0) } else { (17.0, 14.0) };
    let loc = station
        .map(|s| s.loc.as_str())
        .filter(|l| !l.is_empty())
        .unwrap_or("---");
    let line = text_normal(ui, loc, info_x, content_y, LIGHT, &style(loc_size, 700));
    let row = style(row_size, 700);
    let raw = station.map_or_else(|| "---".to_string(), |s| format!("{:.1}", s.raw_i));
    let pga = station.map_or_else(|| "---".to_string(), |s| format!("{:.2}", s.pga));
    let row_top = content_y + line;
    let label_w = ui.measure("震度", &row);
    text_normal(ui, "震度", info_x, row_top, LIGHT, &row);
    text_normal(ui, &raw, info_x + label_w + 4.0, row_top, LIGHT, &row);
    let right_text = right(row.clone());
    let end = info_x + info_w;
    let pga_w = ui.measure(&pga, &row);
    text_normal(ui, &pga, end, row_top, LIGHT, &right_text);
    text_normal(ui, "加速度", end - pga_w - 4.0, row_top, LIGHT, &right_text);

    // level / trigger.
    let info_h = if narrow { 35.0 } else { 30.0 };
    let info_top = card.y + card.h + 3.0;
    let info = Rect::new(left, info_top, 67.0, info_h + 2.0);
    ui.quad(info, &card_style());
    let s = style(11.0, 500);
    let line_h = 11.0 * 1.366;
    let block_top = info_top + 1.0 + (info_h - 2.0 * line_h) / 2.0;
    for (n, (label, value)) in [("level", app.ui.rts_level), ("trigger", app.ui.rts_trigger)]
        .iter()
        .enumerate()
    {
        let y = block_top + n as f32 * line_h;
        let baseline = y + 1.066 * 11.0;
        ui.text(label, info.x + 5.0, baseline, LIGHT, &s);
        ui.text(
            &value.to_string(),
            info.x + info.w - 5.0,
            baseline,
            LIGHT,
            &right(s.clone()),
        );
    }
}

/// overlays/RtsIntensityList.tsx: each town's 60 s peak.
fn draw_rts_list(ui: &mut Ui, app: &App, narrow: bool, closed: f32) {
    let rows = &app.ui.rts_intensity_rows;
    if rows.is_empty() {
        return;
    }
    let (right_gap, bottom_gap, width) = if narrow {
        (264.0, 2.0, 125.0)
    } else {
        (312.0 + 8.0, 3.0, 145.0)
    };
    let shift = closed * 2.16 * width;
    let x = ui.width() - right_gap - width + shift;
    let row_h = 26.0;
    let inner_h = 20.0 + 5.0 + rows.len() as f32 * row_h + (rows.len() - 1) as f32 * 4.0;
    let mut h = inner_h + 12.0;
    if narrow {
        h = h.min(100.0);
    } else {
        h = h.min(300.0);
    }
    let y = ui.height() - bottom_gap - h;
    let card = Rect::new(x, y, width, h);
    ui.quad(card, &QuadStyle::solid(PANEL_BG).radius(5.0));
    ui.push_clip(card);
    text_in(
        ui,
        "各地震度排序",
        x + width / 2.0,
        y + 6.0,
        20.0,
        LIGHT,
        &centered(style(14.0, 700)),
    );
    let mut row_y = y + 6.0 + 20.0 + 5.0;
    for row in rows {
        let rect = Rect::new(x + 6.0, row_y, width - 12.0, row_h);
        ui.quad(
            rect,
            &QuadStyle::solid(Color::rgba_u8(0x38, 0x38, 0x38, 0xff))
                .radius(5.0)
                .border(1.0, Color::rgba_u8(0x27, 0x27, 0x27, 0x78)),
        );
        badge(
            ui,
            Rect::new(rect.x + 1.0, rect.y + 1.0, 26.0, 24.0),
            row.i,
            5.0,
            16.0,
            false,
        );
        let name_center = rect.x + 27.0 + (rect.w - 28.0) / 2.0;
        text_in(
            ui,
            &row.name,
            name_center,
            rect.y + 1.0,
            24.0,
            LIGHT,
            &centered(style(14.0, 700)),
        );
        row_y += row_h + 4.0;
    }
    ui.pop_clip();
}

/// overlays/WarningBanners.tsx.
fn draw_warnings(
    ui: &mut Ui,
    gpu: &Gpu,
    icons: &mut IconCache,
    app: &App,
    narrow: bool,
    closed: f32,
) {
    if !app.ui.internet_error && !app.ui.unstable {
        return;
    }
    let rest = if narrow { 45.0 } else { 0.0 };
    let shift = rest + (315.0 - rest) * closed;
    // The column's right edge: 315 from the window's, inside its 5 px padding.
    let right_edge = ui.width() - 315.0 - 5.0 + shift;
    let mut y = 30.0 + 5.0;
    let mut banner = |ui: &mut Ui,
                      icons: &mut IconCache,
                      icon: Icon,
                      title: &str,
                      lines: [&str; 2],
                      accent: Color| {
        let h = 2.0 + 5.0 + 25.0 + 3.0 + 42.0 + 5.0 + 2.0;
        let body = style(14.0, 400);
        let w = lines
            .iter()
            .map(|line| ui.measure(line, &body))
            .fold(0.0_f32, f32::max)
            .max(25.0 + 8.0 + 30.0)
            + 24.0;
        let w = w.max(160.0);
        let rect = Rect::new(right_edge - w, y, w, h);
        ui.quad(
            rect,
            &QuadStyle::solid(PANEL_BG)
                .radius(5.0)
                .border(2.0, Color::rgba_u8(0, 0, 0, 0xab)),
        );
        let inner = Rect::new(rect.x + 2.0, rect.y + 2.0, w - 4.0, h - 4.0);
        ui.quad(
            inner,
            &QuadStyle::solid(Color::rgba_u8(0, 0, 0, 0xab)).radius(5.0),
        );
        let top = inner.y + 5.0;
        icons.draw(
            ui,
            gpu,
            icon,
            Rect::new(inner.x + 10.0, top, 25.0, 25.0),
            accent,
        );
        text_in(
            ui,
            title,
            inner.x + 10.0 + 25.0 + 8.0,
            top + 1.25,
            22.5,
            accent,
            &style(15.0, 700),
        );
        let mut line_y = top + 25.0 + 3.0;
        for line in lines {
            text_in(ui, line, inner.x + 10.0, line_y, 21.0, LIGHT, &body);
            line_y += 21.0;
        }
        y += h + 5.0;
    };
    if app.ui.internet_error {
        banner(
            ui,
            icons,
            Icon::WifiOff,
            "網路異常",
            ["網路連線異常", "請待稍後重試"],
            TRIGGER_HIGH,
        );
    }
    if app.ui.unstable {
        banner(
            ui,
            icons,
            Icon::TriangleAlert,
            "不穩定",
            ["受地震活動的影響", "觀測點可能不穩定"],
            TRIGGER_MIDDLE,
        );
    }
}

/// overlays/NavBar.tsx and overlays/TimeBar.tsx.
fn draw_nav(
    ui: &mut Ui,
    gpu: &Gpu,
    icons: &mut IconCache,
    app: &mut App,
    actions: &mut Vec<Action>,
) {
    let height = 32.5;
    let top = ui.height() - 5.0 - height;
    let mut x = 3.0;
    let locked = app.focus.lock;
    for (id, icon, tip, color) in [
        (ID_NAV_SETTINGS, Icon::Settings, "設定".to_string(), LIGHT),
        (
            ID_NAV_FOCUS,
            Icon::Crosshair,
            if locked {
                "定位（自動追蹤已暫停，點按恢復）".to_string()
            } else {
                "定位".to_string()
            },
            if locked {
                Color::rgba_u8(0xff, 0x4d, 0x4d, 0xff)
            } else {
                LIGHT
            },
        ),
    ] {
        let rect = Rect::new(x, top + 1.25, 30.0, 30.0);
        let hit = ui.hit(id, rect);
        let (fill, border) = if hit.hovered {
            (
                Color::rgba_u8(0x25, 0x24, 0x24, 0xc7),
                Color::rgba_u8(255, 255, 255, 0x47),
            )
        } else {
            (PANEL_BG, Color::rgba_u8(0, 0, 0, 8))
        };
        ui.quad(
            rect,
            &QuadStyle::solid(fill).radius(5.0).border(1.0, border),
        );
        icons.draw(
            ui,
            gpu,
            icon,
            Rect::new(rect.x + 5.0, rect.y + 5.0, 20.0, 20.0),
            color,
        );
        if hit.hovered {
            ui.set_cursor(CursorKind::Pointer);
            ui.set_tooltip(&tip);
        }
        if hit.clicked {
            actions.push(if id == ID_NAV_SETTINGS {
                Action::OpenSettings
            } else {
                Action::FocusReset
            });
        }
        x += 33.0;
    }

    // The clock. Disconnected, it stops at the last data, in red.
    let replay = app.var.play_mode == 2 || app.var.play_mode == 3;
    let error = app.ui.internet_error;
    let lost = app.var.cache.last_data_time;
    let color = if error {
        Color::rgba_u8(0xce, 0x33, 0x33, 0xff)
    } else if replay {
        WARNING
    } else {
        LIGHT
    };
    let shown = if error && lost != 0.0 {
        lost
    } else {
        app.var.now()
    };
    let text = format_time(shown);
    let s = style(15.0, 700);
    let text_w = ui.measure(&text, &s);
    let pill_w = (text_w + 10.0).max(145.0);
    let pill = Rect::new(x, top, pill_w, height);
    ui.quad(
        pill,
        &QuadStyle::solid(PANEL_BG)
            .radius(5.0)
            .border(2.0, Color::rgba_u8(0, 0, 0, 8)),
    );
    text_in(
        ui,
        &text,
        pill.x + (pill_w - text_w) / 2.0,
        top + 5.0,
        22.5,
        color,
        &s,
    );

    // The note above it: an update waits for a restart.
    if !app.ui.update_ready.is_empty() {
        let note = format!("新版本 {} 已下載・點此重新啟動", app.ui.update_ready);
        let ns = style(11.0, 500);
        let nw = ui.measure(&note, &ns) + 10.0;
        let rect = Rect::new(pill.x, top - 3.0 - 18.5, nw, 18.5);
        let hit = ui.hit(ID_UPDATE, rect);
        ui.quad(rect, &QuadStyle::solid(PANEL_BG).radius(4.0));
        let color = if hit.hovered {
            Color::rgba_u8(255, 255, 255, 255)
        } else {
            Color::rgba_u8(0x8f, 0xd1, 0x8f, 0xff)
        };
        text_in(ui, &note, rect.x + 5.0, rect.y + 1.0, 16.5, color, &ns);
        if hit.hovered {
            ui.set_cursor(CursorKind::Pointer);
            ui.set_tooltip("重新啟動以完成更新");
        }
        if hit.clicked {
            actions.push(Action::RestartForUpdate);
        }
    }

    // The lights: which stream works, small and dim.
    let (eew_ok, eew_why) = app.data_state.eew_health.status();
    let (rts_ok, rts_why) = app.data_state.trem_health.status();
    let rts_why = if rts_ok {
        if error {
            "超過 3 秒沒有即時測站資料".to_string()
        } else {
            String::new()
        }
    } else {
        rts_why
    };
    let lights = [
        (ID_LIGHT_EEW, "EEW", eew_ok, eew_why),
        (ID_LIGHT_RTS, "RTS", rts_why.is_empty(), rts_why),
    ];
    let mut lx = pill.x + pill_w + 3.0 + 3.0;
    let ls = style(9.0, 600);
    for (id, label, ok, why) in lights {
        let (dot, text_color) = if replay {
            (
                Color::rgba_u8(0x8e, 0x8e, 0x93, 140),
                Color::rgba_u8(0xf4, 0xf4, 0xf5, 140),
            )
        } else if ok {
            (
                Color::rgba_u8(0x34, 0xc7, 0x59, 140),
                Color::rgba_u8(0xf4, 0xf4, 0xf5, 140),
            )
        } else {
            (
                Color::rgba_u8(0xff, 0x3b, 0x30, 0xff),
                Color::rgba_u8(0xff, 0x6b, 0x61, 0xff),
            )
        };
        let mid = top + height / 2.0;
        let w = ui.measure(label, &ls) + 0.02 * 9.0 * label.len() as f32;
        let hit = ui.hit(id, Rect::new(lx, mid - 7.0, 5.0 + 3.0 + w, 14.0));
        ui.quad(
            Rect::new(lx, mid - 2.5, 5.0, 5.0),
            &QuadStyle::solid(dot).radius(2.5),
        );
        text_in(ui, label, lx + 8.0, mid - 6.75, 13.5, text_color, &ls);
        if hit.hovered {
            let tip = if replay {
                format!("重播中，{label} 即時連線暫停")
            } else if ok {
                format!("{label} 連線正常")
            } else {
                format!("{label} 異常：{why}")
            };
            ui.set_tooltip(&tip);
        }
        lx += 5.0 + 3.0 + w + 6.0;
    }
}

/// overlays/VersionBadge.tsx.
fn draw_version(ui: &mut Ui, narrow: bool, closed: f32) {
    let label = crate::backend::version::label(env!("CARGO_PKG_VERSION"));
    let rest = if narrow { 50.0 } else { 0.0 };
    let shift = rest + (320.0 - rest) * closed;
    let s = right(style(15.0, 400));
    text_normal(
        ui,
        &label,
        ui.width() - 350.0 + shift,
        4.5,
        Color::rgba_u8(255, 255, 255, 0x4f),
        &s,
    );
}

pub fn unit_prefix(eew: &EewDisplay) -> &'static str {
    match eew.status {
        EewStatus::Alert => "緊急地震速報 ",
        EewStatus::Cancel => "取消報 ",
        EewStatus::Warn => "地震速報 ",
    }
}

pub fn report_number(eew: &EewDisplay) -> String {
    let suffix = if eew.status == EewStatus::Cancel {
        "(取消)"
    } else if eew.is_final {
        "(最終報)"
    } else {
        ""
    };
    format!("第{}報{suffix}", eew.serial)
}

pub fn trigger_label(max: i32) -> &'static str {
    if max > 3 {
        "強震檢測"
    } else if max > 1 {
        "震動檢測"
    } else {
        "弱反應"
    }
}

/// The card's state colour, or None when idle.
pub fn state_color(eew: Option<&EewDisplay>, trigger: Option<&TriggerDisplay>) -> Option<Color> {
    if let Some(eew) = eew {
        return Some(match eew.status {
            EewStatus::Warn => WARN,
            EewStatus::Alert => ALERT,
            EewStatus::Cancel => CANCEL,
        });
    }
    trigger.map(|t| {
        if t.max > 3 {
            TRIGGER_HIGH
        } else if t.max > 1 {
            TRIGGER_MIDDLE
        } else {
            TRIGGER_LOW
        }
    })
}

/// The heading of the card.
pub fn heading(eew: Option<&EewDisplay>, trigger: Option<&TriggerDisplay>) -> String {
    match (eew, trigger) {
        (Some(eew), _) => format!("{}{}", unit_prefix(eew), eew.unit_text),
        (None, Some(t)) => trigger_label(t.max).to_string(),
        (None, None) => "暫無生效中的地震預警".to_string(),
    }
}

/// overlays/EewInfoBox.tsx, main variant.
fn eew_panel(
    ui: &mut Ui,
    eew: Option<&EewDisplay>,
    trigger: Option<&TriggerDisplay>,
    narrow: bool,
) {
    let (x, y) = (4.0, 4.0);
    let color = state_color(eew, trigger);
    let (fill, border) = match color {
        Some(c) => (c, c),
        None => (PANEL_BG, PANEL_BORDER),
    };
    if narrow {
        // Content-box: 272 wide inside 8 px of padding and a 1 px border.
        let panel_w = 272.0 + 18.0;
        let title_lh = 21.0;
        let body_top = y + 1.0 + 8.0 + title_lh + 8.0;
        let body_w = 272.0;
        let body_h = eew.map_or(101.0, |_| 124.0);
        let panel_h = 1.0 + 8.0 + title_lh + 8.0 + body_h + 8.0 + 1.0;
        ui.quad(
            Rect::new(x, y, panel_w, panel_h),
            &QuadStyle::solid(fill).radius(5.0).border(1.0, border),
        );
        title_row(
            ui,
            x + 1.0 + 8.0 + 8.0,
            x + panel_w - 9.0 - 8.0 - 5.0,
            y + 9.0,
            title_lh,
            14.0,
            eew,
            trigger,
        );
        ui.quad(
            Rect::new(x + 9.0, body_top, body_w, body_h),
            &QuadStyle::solid(Color::rgba_u8(0x38, 0x38, 0x38, 0xff)).radius(10.0),
        );
        let (cx, cy) = (x + 9.0 + 8.0, body_top + 8.0);
        if let Some(eew) = eew {
            eew_details(ui, eew, cx, cy, body_w - 16.0, &NARROW_DETAILS);
        } else if let Some(t) = trigger {
            trigger_grid(ui, t, cx, cy, body_w - 16.0);
        }
        return;
    }
    let panel = Rect::new(x, y, 336.4, 157.5);
    ui.quad(
        panel,
        &QuadStyle::solid(fill).radius(5.0).border(1.0, border),
    );
    title_row(
        ui,
        x + 9.0 + 8.0,
        panel.x + panel.w - 9.0 - 8.0,
        y + 9.0,
        22.5,
        15.0,
        eew,
        trigger,
    );
    let body = Rect::new(x + 9.0, y + 39.5, 318.4, 109.0);
    ui.quad(
        body,
        &QuadStyle::solid(Color::rgba_u8(0x38, 0x38, 0x38, 0xff)).radius(10.0),
    );
    let (cx, cy) = (body.x + 8.0, body.y + 8.0);
    if let Some(eew) = eew {
        eew_details(ui, eew, cx, cy, 302.4, &WIDE_DETAILS);
    } else if let Some(t) = trigger {
        trigger_grid(ui, t, cx, cy, 302.4);
    }
}

#[allow(clippy::too_many_arguments)]
fn title_row(
    ui: &mut Ui,
    x: f32,
    end: f32,
    top: f32,
    line: f32,
    size: f32,
    eew: Option<&EewDisplay>,
    trigger: Option<&TriggerDisplay>,
) {
    let s = style(size, 700);
    text_in(ui, &heading(eew, trigger), x, top, line, LIGHT, &s);
    if let Some(eew) = eew {
        text_in(ui, &report_number(eew), end, top, line, LIGHT, &right(s));
    }
}

/// `legacy-trigger-grid`: two columns of four rows, filled column by column.
pub fn trigger_grid(ui: &mut Ui, t: &TriggerDisplay, x: f32, y: f32, width: f32) {
    let s = style(14.0, 400);
    for (n, location) in t.locations.iter().enumerate() {
        let col = (n / 4) as f32;
        let row = (n % 4) as f32;
        text_in(
            ui,
            &location.name,
            x + col * width / 2.0,
            y + row * 21.0,
            21.0,
            LIGHT,
            &s,
        );
    }
}

/// The detail block's sizes: the main card's, its narrow form's and PiP's.
pub struct DetailSizes {
    pub badge_w: f32,
    pub badge_h: f32,
    pub badge_font: f32,
    pub wrap_w: f32,
    pub label_gap: f32,
    /// Under the details' top, where the column centres the badge.
    pub badge_top: f32,
    pub more_top: f32,
    pub gap: f32,
    pub loc: f32,
    pub time: f32,
    pub label: f32,
    pub label_top: f32,
    pub value: f32,
    pub value_top: f32,
    pub prefix: f32,
    pub suffix: f32,
    pub suffix_gap: f32,
}

const WIDE_DETAILS: DetailSizes = DetailSizes {
    badge_w: 75.0,
    badge_h: 70.0,
    badge_font: 45.0,
    wrap_w: 75.0,
    label_gap: 5.0,
    badge_top: 0.0,
    more_top: 4.5,
    gap: 1.0,
    loc: 24.0,
    time: 13.0,
    label: 30.0,
    label_top: 0.0,
    value: 26.0,
    value_top: 8.0,
    prefix: 22.0,
    suffix: 22.0,
    suffix_gap: 4.0,
};

const NARROW_DETAILS: DetailSizes = DetailSizes {
    badge_w: 55.0,
    badge_h: 55.0,
    badge_font: 35.0,
    wrap_w: 72.0,
    label_gap: 5.0,
    badge_top: 25.5,
    more_top: 4.5,
    gap: 7.0,
    loc: 18.0,
    time: 13.0,
    label: 24.0,
    label_top: 5.0,
    value: 20.0,
    // 14, and the larger mark beside the number pushes the baseline 2 lower.
    value_top: 16.0,
    prefix: 22.0,
    suffix: 22.0,
    suffix_gap: 4.0,
};

/// `EewDetails`: the badge on the left; the place, the time and the numbers beside it.
pub fn eew_details(ui: &mut Ui, eew: &EewDisplay, x: f32, y: f32, width: f32, d: &DetailSizes) {
    badge(
        ui,
        Rect::new(
            x + (d.wrap_w - d.badge_w) / 2.0,
            y + d.badge_top,
            d.badge_w,
            d.badge_h,
        ),
        eew.max,
        12.0,
        d.badge_font,
        false,
    );
    text_in(
        ui,
        "預估最大震度",
        x + d.wrap_w / 2.0,
        y + d.badge_top + d.badge_h + d.label_gap,
        18.0,
        Color {
            a: LIGHT.a * 0.75,
            ..LIGHT
        },
        &centered(style(12.0, 400)),
    );
    let mx = x + d.wrap_w + 8.0;
    let mw = width - d.wrap_w - 8.0;
    let mut my = y + d.more_top;
    text_in(ui, &eew.loc, mx, my, d.loc * 1.5, LIGHT, &style(d.loc, 700));
    my += d.loc * 1.5 + d.gap;
    let time = style(d.time, 700);
    let stamp = format_time(eew.time);
    text_in(ui, &stamp, mx, my, d.time * 1.5, LIGHT, &time);
    let stamp_w = ui.measure(&stamp, &time);
    text_in(
        ui,
        "發震",
        mx + stamp_w + 5.0,
        my,
        d.time * 1.5,
        LIGHT,
        &time,
    );
    my += d.time * 1.5 + d.gap;
    // 規模 at the left, 深度 at the right: their pale labels behind the values.
    let ghost = Color {
        a: LIGHT.a * 0.1,
        ..LIGHT
    };
    let lab = style(d.label, 700);
    let value = style(d.value, 700);
    let prefix = style(d.prefix, 700);
    let number = format!("{:.1}", eew.mag);
    let prefix_w = ui.measure("𝖬", &prefix);
    let number_w = ui.measure(&number, &value);
    let left_w = (prefix_w + 4.0 + number_w).max(60.0);
    let label_w = ui.measure("規模", &lab);
    text_in(
        ui,
        "規模",
        mx + left_w - label_w,
        my + d.label_top,
        d.label * 1.5,
        ghost,
        &lab,
    );
    let value_top = my + d.value_top;
    let line = d.value * 1.5;
    magnitude_mark(
        ui,
        mx,
        line_baseline(value_top, line, d.value),
        LIGHT,
        &prefix,
    );
    text_in(
        ui,
        &number,
        mx + prefix_w + 4.0,
        value_top,
        line,
        LIGHT,
        &value,
    );
    let depth = eew.depth.to_string();
    let suffix = style(d.suffix, 700);
    let depth_w = ui.measure(&depth, &value);
    let km_w = ui.measure("㎞", &suffix);
    let right_w = (depth_w + d.suffix_gap + km_w).max(60.0);
    let right_x = mx + mw - right_w;
    let label_w = ui.measure("深度", &lab);
    text_in(
        ui,
        "深度",
        right_x + right_w - label_w,
        my + d.label_top,
        d.label * 1.5,
        ghost,
        &lab,
    );
    text_in(ui, &depth, right_x, value_top, line, LIGHT, &value);
    text_in(
        ui,
        "㎞",
        right_x + depth_w + d.suffix_gap,
        value_top,
        line,
        LIGHT,
        &suffix,
    );
}
