//! The always-on-top window (features/pip/PipView.tsx), drawing the same card as the main
//! window's. It fills its window, so it needs no transparent margin.

use super::icons::{Icon, IconCache};
use super::main_view::{
    eew_details, heading, report_number, state_color, trigger_grid, DetailSizes,
};
use super::widgets::{right, style, text_in, LIGHT};
use super::{Color, CursorKind, QuadStyle, Rect, Ui, WidgetId};
use crate::render::Gpu;
use crate::variable::{EewDisplay, TriggerDisplay};

const PIP_DETAILS: DetailSizes = DetailSizes {
    badge_w: 55.0,
    badge_h: 55.0,
    badge_font: 35.0,
    wrap_w: 72.0,
    label_gap: 5.0,
    badge_top: 12.75,
    more_top: 0.0,
    gap: 8.0,
    loc: 18.0,
    time: 12.0,
    label: 24.0,
    label_top: 0.0,
    value: 20.0,
    value_top: 7.0,
    prefix: 20.0,
    suffix: 17.0,
    suffix_gap: 2.0,
};

const ID_BACK: WidgetId = WidgetId(1);
const ID_CLOSE: WidgetId = WidgetId(2);
/// A press on the card moves the window.
pub const ID_SHELL: WidgetId = WidgetId(3);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PipOutcome {
    pub back_to_main: bool,
    pub close: bool,
}

pub fn draw(
    ui: &mut Ui,
    gpu: &Gpu,
    icons: &mut IconCache,
    eew: Option<&EewDisplay>,
    trigger: Option<&TriggerDisplay>,
) -> PipOutcome {
    let (w, h) = (ui.width(), ui.height());
    let mut outcome = PipOutcome::default();
    ui.hit(ID_SHELL, Rect::new(0.0, 0.0, w, h));

    let fill = state_color(eew, trigger).unwrap_or(Color::rgba_u8(80, 80, 80, 255));
    ui.quad(Rect::new(0.0, 0.0, w, h), &QuadStyle::solid(fill));
    let s = style(14.0, 700);
    let title_x = 5.0 + 8.0;
    text_in(ui, &heading(eew, trigger), title_x, 5.0, 21.0, LIGHT, &s);
    if let Some(eew) = eew {
        text_in(
            ui,
            &report_number(eew),
            w - 8.0,
            5.0,
            21.0,
            LIGHT,
            &right(s),
        );
    }
    let body = Rect::new(10.0, 34.0, w - 20.0, h - 34.0 - 10.0);
    ui.quad(
        body,
        &QuadStyle::solid(Color::rgba_u8(56, 56, 56, 230)).radius(10.0),
    );
    let (cx, cy) = (body.x + 5.0, body.y + 5.0);
    if let Some(eew) = eew {
        eew_details(ui, eew, cx, cy, body.w - 10.0, &PIP_DETAILS);
    } else if let Some(t) = trigger {
        trigger_grid(ui, t, cx, cy, body.w - 10.0);
    }

    // The controls, only while the pointer is over the window.
    let (px, py) = ui.pointer();
    if Rect::new(0.0, 0.0, w, h).contains(px, py) {
        ui.quad(
            Rect::new(0.0, 0.0, w, h),
            &QuadStyle::solid(Color::rgba_u8(0, 0, 0, 189)).radius(4.0),
        );
        for (id, icon, x, tip) in [
            (ID_BACK, Icon::ExternalLink, 0.0, "返回主視窗"),
            (ID_CLOSE, Icon::X, w - 35.0, "關閉子母畫面"),
        ] {
            let rect = Rect::new(x, 0.0, 35.0, 35.0);
            let hit = ui.hit(id, rect);
            icons.draw(
                ui,
                gpu,
                icon,
                Rect::new(rect.x + 5.0, 5.0, 25.0, 25.0),
                LIGHT,
            );
            if hit.hovered {
                ui.set_cursor(CursorKind::Pointer);
                ui.set_tooltip(tip);
            }
            if hit.clicked {
                if id == ID_BACK {
                    outcome.back_to_main = true;
                } else {
                    outcome.close = true;
                }
            }
        }
    }
    super::widgets::draw_tooltip(ui);
    outcome
}
