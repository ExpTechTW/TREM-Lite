//! `--page debug`: SDF boxes, clips, images, and the embedded font stack.

use super::{Color, CursorKind, ImageId, QuadStyle, Rect, Ui, WidgetId};
use crate::render::{Gpu, HAlign, TextStyle, VAlign};

const PHRASE: &str = "花蓮縣近海 規模 5.8 深度 18 公里 5⁻ 6⁺";

pub struct DebugPage {
    image: Option<ImageId>,
}

impl DebugPage {
    pub fn new() -> Self {
        Self { image: None }
    }

    pub fn draw(&mut self, ui: &mut Ui, gpu: &Gpu) {
        ui.set_cursor(CursorKind::Default);
        let image = self.image_id(ui, gpu);
        let fg = color("#f4f4f5");
        let muted = color("#a9b4bc");
        let card = color("#26272e");
        let line = color("rgba(255, 255, 255, 0.12)");

        ui.text("TREM-Lite", 24.0, 18.0, fg, &style(28.0, 700));
        let mut right = style(13.0, 500);
        right.h_align = HAlign::Right;
        ui.text("右對齊", 1256.0, 18.0, muted, &right);
        ui.text(PHRASE, 24.0, 54.0, muted, &style(15.0, 500));

        let cards = [
            (
                "fill",
                QuadStyle::solid(card).radius(16.0).border(1.0, line),
            ),
            (
                "radii",
                QuadStyle::solid(color("#3f4045")).radii(26.0, 6.0, 18.0, 4.0),
            ),
            (
                "border",
                QuadStyle::solid(color("#1e9632"))
                    .radius(12.0)
                    .border(8.0, color("rgba(255, 170, 0, 0.5)")),
            ),
            (
                "gradient",
                QuadStyle::solid(color("#0064c8"))
                    .radius(12.0)
                    .gradient(color("#beff0c"), 90.0),
            ),
            (
                "shadow",
                QuadStyle::solid(card).radius(12.0).shadow(
                    0.0,
                    10.0,
                    24.0,
                    color("rgba(0, 0, 0, 0.55)"),
                ),
            ),
            (
                "glow",
                QuadStyle::solid(card).radius(12.0).shadow(
                    8.0,
                    6.0,
                    16.0,
                    color("rgba(190, 255, 12, 0.45)"),
                ),
            ),
        ];
        let label_style = style(11.0, 500);
        for (index, (label, look)) in cards.into_iter().enumerate() {
            let x = 24.0 + index as f32 * 208.0;
            let rect = Rect::new(x, 92.0, 196.0, 100.0);
            ui.quad(rect, &look);
            let mut centered = label_style.clone();
            centered.h_align = HAlign::Center;
            let _width = ui.measure(label, &label_style);
            ui.text(label, x + 98.0, 198.0, muted, &centered);
        }

        let clip_box = Rect::new(24.0, 244.0, 300.0, 132.0);
        ui.quad(
            clip_box,
            &QuadStyle::solid(card).radius(8.0).border(1.0, line),
        );
        ui.push_clip(Rect::new(32.0, 252.0, 284.0, 116.0));
        ui.quad(
            Rect::new(8.0, 280.0, 420.0, 48.0),
            &QuadStyle::solid(color("#beff0c")).radius(8.0),
        );
        ui.text(
            "overflow hidden",
            40.0,
            292.0,
            color("#1f2025"),
            &style(15.0, 700),
        );
        ui.pop_clip();

        let round = Rect::new(340.0, 244.0, 220.0, 132.0);
        ui.push_rounded_clip(round, [28.0, 28.0, 28.0, 28.0]);
        ui.quad(
            Rect::new(300.0, 210.0, 300.0, 200.0),
            &QuadStyle::solid(color("#0064c8")),
        );
        ui.text("圓角 clip", 356.0, 292.0, fg, &style(17.0, 500));
        ui.pop_clip();
        ui.quad(
            round,
            &QuadStyle::solid(Color::TRANSPARENT)
                .radius(28.0)
                .border(1.0, line),
        );

        if let Some(id) = image {
            ui.image(id, Rect::new(580.0, 252.0, 112.0, 112.0), color("#ffffff"));
            ui.image(id, Rect::new(708.0, 252.0, 112.0, 112.0), color("#ff8800"));
        }

        let scroll_view = Rect::new(836.0, 244.0, 420.0, 132.0);
        ui.quad(
            scroll_view,
            &QuadStyle::solid(card).radius(8.0).border(1.0, line),
        );
        let rows = [
            "花蓮縣近海",
            "規模 5.8",
            "深度 18 公里",
            "5⁻ 弱  6⁺ 強",
            "Manrope 123",
            "Noto Sans TC",
            "tabular 1000",
            "scroll",
        ];
        let row_h = 22.0;
        let max_scroll = (rows.len() as f32 * row_h - 110.0).max(0.0);
        let _ = ui.hit(WidgetId(2), scroll_view);
        let scroll = ui.scroll_offset(WidgetId(2), max_scroll);
        ui.push_clip(Rect::new(844.0, 252.0, 404.0, 116.0));
        let row_style = style(13.0, 500);
        for (index, row) in rows.iter().enumerate() {
            ui.text(
                row,
                856.0,
                256.0 + index as f32 * row_h - scroll,
                fg,
                &row_style,
            );
        }
        ui.pop_clip();

        let mut y = 392.0;
        for size in [11.0, 13.0, 15.0, 17.0] {
            ui.text(PHRASE, 24.0, y, fg, &style(size, 400));
            y += size + 6.0;
        }
        let wrap = style(13.0, 400);
        let _height = ui.text_wrapped(
            "這行會在固定寬度裡換行，Manrope 與 Noto Sans TC 混排 12345。",
            700.0,
            392.0,
            540.0,
            muted,
            &wrap,
        );

        for (index, (weight, label)) in [
            (400u16, "400 Manrope 規模"),
            (500, "500 Manrope 規模"),
            (700, "700 Manrope 規模"),
        ]
        .into_iter()
        .enumerate()
        {
            ui.text(
                label,
                24.0 + index as f32 * 360.0,
                488.0,
                fg,
                &style(17.0, weight),
            );
        }
        ui.text(PHRASE, 24.0, 520.0, fg, &style(28.0, 700));
        ui.text(PHRASE, 24.0, 568.0, fg, &style(48.0, 500));

        let truncate_box = Rect::new(24.0, 648.0, 260.0, 36.0);
        ui.quad(
            truncate_box,
            &QuadStyle::solid(card).radius(8.0).border(1.0, line),
        );
        ui.text_truncated(
            "花蓮縣近海規模 5.8 這段文字會被截斷 Truncate this long label",
            32.0,
            654.0,
            244.0,
            fg,
            &style(15.0, 500),
        );
        let text_hit = ui.hit(WidgetId(3), truncate_box);
        if text_hit.hovered {
            ui.set_cursor(CursorKind::Text);
        }

        let mut baseline = style(11.0, 500);
        baseline.v_align = VAlign::Baseline;
        ui.text("tabular", 24.0, 712.0, muted, &baseline);
        ui.text("proportional", 200.0, 696.0, muted, &style(11.0, 500));
        let mut tabular = style(15.0, 500);
        tabular.tabular = true;
        let proportional = style(15.0, 500);
        for (index, number) in ["1234.50", "89.00", "1000.25"].into_iter().enumerate() {
            let row_y = 714.0 + index as f32 * 18.0;
            ui.text(number, 24.0, row_y, fg, &tabular);
            ui.text(number, 200.0, row_y, fg, &proportional);
        }

        let mut tracked = style(15.0, 500);
        tracked.letter_spacing = 1.5;
        ui.text("letter-spacing", 420.0, 714.0, fg, &tracked);

        let button = Rect::new(980.0, 748.0, 140.0, 36.0);
        let hit = ui.hit(WidgetId(1), button);
        let fill = if hit.pressed {
            color("#beff0c")
        } else if hit.hovered {
            color("#3f4045")
        } else {
            card
        };
        ui.quad(
            button,
            &QuadStyle::solid(fill).radius(8.0).border(1.0, line),
        );
        let mut middle = style(15.0, 700);
        middle.v_align = VAlign::Middle;
        ui.text("按鈕", 1024.0, 766.0, fg, &middle);
        if hit.hovered {
            ui.set_cursor(CursorKind::Pointer);
            ui.set_tooltip("這是 tooltip");
        }
        let tip = ui.tooltip().map(str::to_string);
        let (px, py) = ui.pointer();
        if let Some(tip) = tip {
            if px >= 0.0 && py >= 0.0 && px < ui.width() && py < ui.height() {
                ui.quad(
                    Rect::new(px + 12.0, py + 16.0, 140.0, 28.0),
                    &QuadStyle::solid(color("#3f4045")).radius(6.0),
                );
                ui.text(&tip, px + 20.0, py + 20.0, fg, &style(13.0, 500));
            }
        }
    }

    fn image_id(&mut self, ui: &mut Ui, gpu: &Gpu) -> Option<ImageId> {
        if self.image.is_some() && ui.image_count() > 0 {
            return self.image;
        }
        let id = ui.upload_image(gpu, &checker(), 64, 64);
        self.image = id;
        id
    }
}

fn style(size: f32, weight: u16) -> TextStyle {
    TextStyle {
        size,
        weight,
        ..TextStyle::default()
    }
}

fn color(text: &str) -> Color {
    Color::parse(text).unwrap_or(Color::rgba_u8(255, 0, 255, 255))
}

fn checker() -> Vec<u8> {
    let n = 64usize;
    let mut pixels = vec![0u8; n * n * 4];
    for y in 0..n {
        for x in 0..n {
            let i = (y * n + x) * 4;
            let on = ((x / 8) + (y / 8)) % 2 == 0;
            let (r, g, b) = if on { (190, 255, 12) } else { (0, 100, 200) };
            pixels[i] = r;
            pixels[i + 1] = g;
            pixels[i + 2] = b;
            pixels[i + 3] = 255;
            let dx = x as f32 - 31.5;
            let dy = y as f32 - 31.5;
            if dx * dx + dy * dy > 30.0 * 30.0 {
                pixels[i + 3] = 0;
            }
        }
    }
    pixels
}
