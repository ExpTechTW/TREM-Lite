//! The map's icons, all in one texture with mipmaps (trem_gfx's sprite): the intensity
//! and long-period badges (domain/utils.ts `createIntensityIcon*`, there SVG) drawn once
//! with the UI renderer, and the epicentre crosses from their PNGs. Mipmapped because
//! they are shown at 12 to 100 pixels and sampled from 96.

use trem_gfx::map::icons::{SpriteIcon, SpriteLayout};

use crate::domain::constants::{
    intensity_color, intensity_text, lpgm_color, lpgm_text, INTENSITY_LIST,
};
use crate::render::{Gpu, HAlign, TextStyle, VAlign};
use crate::ui::{Color, QuadStyle, Rect, Ui};

/// 96 px cells, 6 to a row, with 4 px around each.
pub const LAYOUT: SpriteLayout = SpriteLayout {
    cell: 96,
    pad: 4,
    columns: 6,
    cells: CELLS,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IconId {
    Intensity(u8),
    IntensitySquare(u8),
    Lpgm(u8),
    Cross,
    /// `cross1` to `cross4`: which of several EEWs.
    CrossNumbered(u8),
}

impl SpriteIcon for IconId {
    /// The cell: 10 intensity, 10 square, 4 lpgm, then the 5 crosses.
    fn cell(self) -> u32 {
        match self {
            Self::Intensity(i) => u32::from(i.min(9)),
            Self::IntensitySquare(i) => 10 + u32::from(i.min(9)),
            Self::Lpgm(l) => 20 + u32::from(l.clamp(1, 4)) - 1,
            Self::Cross => 24,
            Self::CrossNumbered(n) => 24 + u32::from(n.clamp(1, 4)),
        }
    }

    /// The size MapLibre knew it by, which `icon-size` scales: the SVGs are 60 px and
    /// the cross PNGs 1080.
    fn natural(self) -> f32 {
        match self {
            Self::Cross | Self::CrossNumbered(_) => 1080.0,
            _ => 60.0,
        }
    }
}

const CELLS: u32 = 29;

/// One badge, in its cell. `square` is the rounded square, else the circle.
fn draw_badge(ui: &mut Ui, index: u32, label: &str, bg: Color, fg: Color, square: bool) {
    let (ox, oy) = LAYOUT.cell_origin(index);
    let s = LAYOUT.cell as f32 / 60.0;
    let (x, y) = (ox as f32, oy as f32);
    // The SVG's stroke straddles its edge; a CSS border lies inside it. So the box
    // grows by half the stroke (1.5 of 60).
    let style = if square {
        // <rect x=2 y=2 w=56 h=56 rx=10 stroke-width=3>
        QuadStyle::solid(bg).radius(11.5 * s).border(3.0 * s, fg)
    } else {
        // <circle cx=30 cy=30 r=28 stroke-width=3>
        QuadStyle::solid(bg).radius(29.5 * s).border(3.0 * s, fg)
    };
    ui.quad(
        Rect::new(x + 0.5 * s, y + 0.5 * s, 59.0 * s, 59.0 * s),
        &style,
    );
    let text = TextStyle {
        size: 36.0 * s,
        weight: 700,
        h_align: HAlign::Center,
        v_align: VAlign::Middle,
        subpixel: true,
        ..TextStyle::default()
    };
    ui.text(label, x + 30.0 * s, y + 31.5 * s, fg, &text);
}

fn draw_badges(ui: &mut Ui) {
    for i in 0..10u8 {
        let label = INTENSITY_LIST[i as usize];
        let bg = intensity_color(i);
        let fg = intensity_text(i);
        draw_badge(ui, IconId::Intensity(i).cell(), label, bg, fg, false);
        draw_badge(ui, IconId::IntensitySquare(i).cell(), label, bg, fg, true);
    }
    for l in 1..=4u8 {
        let label = l.to_string();
        draw_badge(
            ui,
            IconId::Lpgm(l).cell(),
            &label,
            lpgm_color(l),
            lpgm_text(l),
            true,
        );
    }
}

/// The sprite's size in pixels.
#[cfg(test)]
pub fn sprite_size() -> (u32, u32) {
    LAYOUT.size()
}

/// Build the sprite texture.
#[cfg(not(target_arch = "wasm32"))]
pub fn build_sprite(gpu: &Gpu) -> Result<wgpu::Texture, String> {
    Ok(LAYOUT.upload(gpu, sprite_pixels(gpu)?))
}

/// A browser cannot wait for a readback, so it takes the sprite the desktop draws, as
/// the test that pins it keeps it: the same pixels.
#[cfg(target_arch = "wasm32")]
pub fn build_sprite(gpu: &Gpu) -> Result<wgpu::Texture, String> {
    LAYOUT.from_png(
        gpu,
        include_bytes!("../../testdata/golden/render/map-sprite.png"),
    )
}

/// The sprite's top level, premultiplied RGBA. The badges draw through the normal UI
/// renderer, on a transparent target, which leaves them premultiplied, as the map's blend
/// wants.
#[cfg(not(target_arch = "wasm32"))]
pub fn sprite_pixels(gpu: &Gpu) -> Result<Vec<u8>, String> {
    let crosses: [(IconId, &[u8]); 5] = [
        (IconId::Cross, include_bytes!("../../assets/map/cross.png")),
        (
            IconId::CrossNumbered(1),
            include_bytes!("../../assets/map/cross1.png"),
        ),
        (
            IconId::CrossNumbered(2),
            include_bytes!("../../assets/map/cross2.png"),
        ),
        (
            IconId::CrossNumbered(3),
            include_bytes!("../../assets/map/cross3.png"),
        ),
        (
            IconId::CrossNumbered(4),
            include_bytes!("../../assets/map/cross4.png"),
        ),
    ];
    LAYOUT.render(gpu, &crate::render::FONTS, draw_badges, &crosses)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_icon_has_its_own_cell_inside_the_texture() {
        let mut seen = std::collections::HashSet::new();
        let ids = (0..10)
            .map(IconId::Intensity)
            .chain((0..10).map(IconId::IntensitySquare))
            .chain((1..=4).map(IconId::Lpgm))
            .chain([IconId::Cross])
            .chain((1..=4).map(IconId::CrossNumbered));
        for id in ids {
            assert!(seen.insert(id.cell()), "{id:?}");
            let [u, v, w, h] = LAYOUT.uv_rect(id.cell());
            assert!(u >= 0.0 && v >= 0.0 && u + w <= 1.0 && v + h <= 1.0);
        }
        assert_eq!(seen.len() as u32, CELLS);
    }
}
