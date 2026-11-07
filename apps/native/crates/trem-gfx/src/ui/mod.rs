//! Immediate-mode UI in CSS logical pixels. The renderer multiplies by the DPI scale.

pub mod icons;
pub mod widgets;

use std::collections::HashMap;
use std::sync::Arc;

use crate::render::{
    append_glyph_quads, ClipPx, FontConfig, FontMetrics, GlyphDraw, GlyphQuad, HAlign, QuadDesc,
    TextEngine, TextStyle, UiPass, VAlign,
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Color {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Color {
    pub const TRANSPARENT: Self = Self {
        r: 0.0,
        g: 0.0,
        b: 0.0,
        a: 0.0,
    };

    pub const fn rgba_u8(r: u8, g: u8, b: u8, a: u8) -> Self {
        Self {
            r: r as f32 / 255.0,
            g: g as f32 / 255.0,
            b: b as f32 / 255.0,
            a: a as f32 / 255.0,
        }
    }

    pub fn to_array(self) -> [f32; 4] {
        [self.r, self.g, self.b, self.a]
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub const ZERO: Self = Self {
        x: 0.0,
        y: 0.0,
        w: 0.0,
        h: 0.0,
    };

    pub fn new(x: f32, y: f32, w: f32, h: f32) -> Self {
        Self { x, y, w, h }
    }

    pub fn contains(self, x: f32, y: f32) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.w && y < self.y + self.h
    }

    pub fn intersect(self, other: Self) -> Option<Self> {
        let x0 = self.x.max(other.x);
        let y0 = self.y.max(other.y);
        let x1 = (self.x + self.w).min(other.x + other.w);
        let y1 = (self.y + self.h).min(other.y + other.h);
        let w = x1 - x0;
        let h = y1 - y0;
        if w > 0.0 && h > 0.0 {
            Some(Self { x: x0, y: y0, w, h })
        } else {
            None
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Shadow {
    pub offset_x: f32,
    pub offset_y: f32,
    pub blur: f32,
    pub spread: f32,
    pub color: Color,
}

#[derive(Clone, Copy, Debug)]
pub struct QuadStyle {
    pub fill: Color,
    pub fill_end: Color,
    pub gradient_deg: f32,
    pub radii: [f32; 4],
    pub border_width: f32,
    pub border_color: Color,
    pub shadow: Option<Shadow>,
}

impl Default for QuadStyle {
    fn default() -> Self {
        Self {
            fill: Color::TRANSPARENT,
            fill_end: Color::TRANSPARENT,
            gradient_deg: 180.0,
            radii: [0.0; 4],
            border_width: 0.0,
            border_color: Color::TRANSPARENT,
            shadow: None,
        }
    }
}

impl QuadStyle {
    pub fn solid(fill: Color) -> Self {
        Self {
            fill,
            fill_end: fill,
            ..Self::default()
        }
    }

    pub fn radii(mut self, tl: f32, tr: f32, br: f32, bl: f32) -> Self {
        self.radii = [tl, tr, br, bl];
        self
    }

    pub fn radius(self, radius: f32) -> Self {
        self.radii(radius, radius, radius, radius)
    }

    pub fn border(mut self, width: f32, color: Color) -> Self {
        self.border_width = width;
        self.border_color = color;
        self
    }

    pub fn gradient(mut self, end: Color, degrees: f32) -> Self {
        self.fill_end = end;
        self.gradient_deg = degrees;
        self
    }

    pub fn shadow(mut self, offset_x: f32, offset_y: f32, blur: f32, color: Color) -> Self {
        self.shadow = Some(Shadow {
            offset_x,
            offset_y,
            blur,
            spread: 0.0,
            color,
        });
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct WidgetId(pub u64);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Interaction {
    pub hovered: bool,
    pub pressed: bool,
    pub clicked: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorKind {
    Default,
    Pointer,
}

#[derive(Clone, Copy, Debug)]
pub struct ImageId(pub u32);

#[derive(Clone, Copy, Debug)]
struct ClipEntry {
    rect: Rect,
    radii: [f32; 4],
}

#[derive(Clone, Debug, Default)]
struct ClipStack {
    stack: Vec<ClipEntry>,
}

impl ClipStack {
    fn push(&mut self, rect: Rect, radii: [f32; 4]) {
        let radii = fit_radii(rect.w, rect.h, radii);
        self.stack.push(ClipEntry { rect, radii });
    }

    fn pop(&mut self) {
        self.stack.pop();
    }

    fn aabb(&self) -> Option<Rect> {
        let mut acc: Option<Rect> = None;
        for entry in &self.stack {
            acc = Some(match acc {
                None => entry.rect,
                Some(prev) => prev.intersect(entry.rect).unwrap_or(Rect::ZERO),
            });
        }
        acc
    }

    fn round(&self) -> Option<(Rect, [f32; 4])> {
        self.stack.iter().rev().find_map(|entry| {
            if entry.radii.iter().any(|radius| *radius > 0.0) {
                Some((entry.rect, entry.radii))
            } else {
                None
            }
        })
    }
}

#[derive(Clone, Copy, Debug)]
struct ClipSnapshot {
    aabb: Option<Rect>,
    round: Option<(Rect, [f32; 4])>,
}

impl ClipSnapshot {
    fn to_px(self, scale: f32, screen: [f32; 2]) -> ClipPx {
        let mut clip = match self.aabb {
            None => ClipPx::screen(screen[0], screen[1]),
            Some(rect) => ClipPx {
                aabb: scale_rect(rect, scale),
                round_box: [0.0; 4],
                round_radii: [0.0; 4],
            },
        };
        if let Some((rect, radii)) = self.round {
            clip.round_box = scale_rect(rect, scale);
            clip.round_radii = radii.map(|radius| radius * scale);
        }
        clip
    }
}

enum DrawOp {
    Quad {
        rect: Rect,
        style: QuadStyle,
        clip: ClipSnapshot,
    },
    Image {
        id: ImageId,
        rect: Rect,
        tint: Color,
        clip: ClipSnapshot,
    },
    Text {
        layout: Arc<crate::render::TextLayout>,
        x: f32,
        y: f32,
        color: Color,
        h_align: HAlign,
        v_align: VAlign,
        subpixel: bool,
        box_width: Option<f32>,
        clip: ClipSnapshot,
    },
}

#[derive(Clone, Copy)]
enum Cmd {
    Quad(QuadDesc),
    Image {
        id: u32,
        dest: [f32; 4],
        tint: [f32; 4],
        clip: ClipPx,
    },
    Glyphs {
        start: u32,
        end: u32,
        clip: ClipPx,
    },
}

struct HitNode {
    id: WidgetId,
    rect: Rect,
}

pub struct Ui {
    pass: UiPass,
    text: TextEngine,
    width: f32,
    height: f32,
    scale: f32,
    ops: Vec<DrawOp>,
    clips: ClipStack,
    glyphs: Vec<GlyphQuad>,
    cmds: Vec<Cmd>,
    input: InputState,
}

/// One window's interaction. There is one [`Ui`] for all the windows, so they share the
/// glyph atlas, the images and the pipelines; each window keeps this and swaps it in.
pub struct InputState {
    pointer_x: f32,
    pointer_y: f32,
    mouse_down: bool,
    mouse_pressed: bool,
    mouse_released: bool,
    wheel_y: f32,
    hover: Option<WidgetId>,
    pressed: Option<WidgetId>,
    nodes: Vec<HitNode>,
    scrolls: HashMap<WidgetId, f32>,
    cursor: CursorKind,
    tooltip: Option<String>,
}

impl Default for InputState {
    fn default() -> Self {
        Self {
            pointer_x: -1.0e6,
            pointer_y: -1.0e6,
            mouse_down: false,
            mouse_pressed: false,
            mouse_released: false,
            wheel_y: 0.0,
            hover: None,
            pressed: None,
            nodes: Vec::new(),
            scrolls: HashMap::new(),
            cursor: CursorKind::Default,
            tooltip: None,
        }
    }
}

impl Ui {
    pub fn new(
        gpu: &crate::render::Gpu,
        format: wgpu::TextureFormat,
        logical: (f32, f32),
        scale: f32,
        fonts: &FontConfig,
    ) -> Result<Self, String> {
        Ok(Self {
            pass: UiPass::new(gpu, format)?,
            text: TextEngine::new(fonts),
            width: logical.0,
            height: logical.1,
            scale: if scale.is_finite() && scale > 0.0 {
                scale
            } else {
                1.0
            },
            ops: Vec::new(),
            clips: ClipStack::default(),
            glyphs: Vec::new(),
            cmds: Vec::new(),
            input: InputState::default(),
        })
    }

    /// Put a window's interaction in, and get the previous one back.
    pub fn swap_input(&mut self, other: &mut InputState) {
        std::mem::swap(&mut self.input, other);
    }

    pub fn current_hover(&self) -> Option<WidgetId> {
        self.input.hover
    }

    /// What the pointer would be over at this point, by the last frame's widgets.
    pub fn hover_at(&self, x: f32, y: f32) -> Option<WidgetId> {
        self.input
            .nodes
            .iter()
            .rev()
            .find(|node| node.rect.contains(x, y))
            .map(|node| node.id)
    }

    pub fn resize(&mut self, logical: (f32, f32), scale: f32) {
        self.width = logical.0;
        self.height = logical.1;
        // The atlas stays: glyphs of the old scale age out, and two windows on screens of
        // different scale would otherwise throw it away every frame.
        if scale.is_finite() && scale > 0.0 {
            self.scale = scale;
        }
    }

    pub fn recreate_pipelines(
        &mut self,
        gpu: &crate::render::Gpu,
        format: wgpu::TextureFormat,
    ) -> Result<(), String> {
        if self.pass.format == format {
            return Ok(());
        }
        self.pass = UiPass::new(gpu, format)?;
        Ok(())
    }

    pub fn release_atlas(&mut self) {
        self.text.release_atlas();
    }

    pub fn scale(&self) -> f32 {
        self.scale
    }

    pub fn width(&self) -> f32 {
        self.width
    }

    pub fn height(&self) -> f32 {
        self.height
    }

    /// The sans family's vertical metrics: where its lines sit.
    pub fn metrics(&self) -> &FontMetrics {
        self.text.metrics()
    }

    pub fn begin(&mut self) {
        self.ops.clear();
        self.clips.stack.clear();
        self.input.nodes.clear();
        self.input.cursor = CursorKind::Default;
        self.input.tooltip = None;
    }

    pub fn end(&mut self) {
        self.input.hover = self
            .input
            .nodes
            .iter()
            .rev()
            .find(|node| {
                node.rect
                    .contains(self.input.pointer_x, self.input.pointer_y)
            })
            .map(|node| node.id);
        if self.input.mouse_pressed {
            self.input.pressed = self.input.hover;
        }
        if !self.input.mouse_down {
            self.input.pressed = None;
        }
        self.input.mouse_pressed = false;
        self.input.mouse_released = false;
        self.input.wheel_y = 0.0;
    }

    pub fn set_pointer(&mut self, x: f32, y: f32) {
        self.input.pointer_x = x;
        self.input.pointer_y = y;
    }

    pub fn set_buttons(&mut self, down: bool, pressed: bool, released: bool) {
        self.input.mouse_down = down;
        self.input.mouse_pressed = pressed;
        self.input.mouse_released = released;
    }

    pub fn add_wheel(&mut self, dy: f32) {
        if dy.is_finite() {
            self.input.wheel_y += dy;
        }
    }

    /// The press of this frame, whatever is under it.
    pub fn mouse_just_pressed(&self) -> bool {
        self.input.mouse_pressed
    }

    pub fn mouse_just_released(&self) -> bool {
        self.input.mouse_released
    }

    pub fn pointer(&self) -> (f32, f32) {
        (self.input.pointer_x, self.input.pointer_y)
    }

    pub fn cursor(&self) -> CursorKind {
        self.input.cursor
    }

    pub fn set_cursor(&mut self, cursor: CursorKind) {
        self.input.cursor = cursor;
    }

    pub fn set_tooltip(&mut self, text: &str) {
        self.input.tooltip = Some(text.to_string());
    }

    pub fn tooltip(&self) -> Option<&str> {
        self.input.tooltip.as_deref()
    }

    pub fn quad(&mut self, rect: Rect, style: &QuadStyle) {
        let clip = self.snapshot();
        self.ops.push(DrawOp::Quad {
            rect,
            style: *style,
            clip,
        });
    }

    pub fn image(&mut self, id: ImageId, rect: Rect, tint: Color) {
        let clip = self.snapshot();
        self.ops.push(DrawOp::Image {
            id,
            rect,
            tint,
            clip,
        });
    }

    pub fn upload_image(
        &mut self,
        gpu: &crate::render::Gpu,
        data: &[u8],
        width: u32,
        height: u32,
    ) -> Option<ImageId> {
        self.pass.upload_rgba(gpu, width, height, data).map(ImageId)
    }

    pub fn text(&mut self, text: &str, x: f32, y: f32, color: Color, style: &TextStyle) {
        let clip = self.snapshot();
        let layout = self.text.layout_single(text, style);
        self.ops.push(DrawOp::Text {
            layout,
            x,
            y,
            color,
            h_align: style.h_align,
            v_align: style.v_align,
            subpixel: style.subpixel,
            box_width: None,
            clip,
        });
    }

    pub fn text_truncated(
        &mut self,
        text: &str,
        x: f32,
        y: f32,
        max_width: f32,
        color: Color,
        style: &TextStyle,
    ) {
        let clip = self.snapshot();
        let layout = self.text.layout_truncate(text, max_width, style);
        let _truncated = layout.truncated;
        self.ops.push(DrawOp::Text {
            layout,
            x,
            y,
            color,
            h_align: style.h_align,
            v_align: style.v_align,
            subpixel: style.subpixel,
            box_width: Some(max_width),
            clip,
        });
    }

    pub fn text_wrapped(
        &mut self,
        text: &str,
        x: f32,
        y: f32,
        max_width: f32,
        color: Color,
        style: &TextStyle,
    ) -> f32 {
        let clip = self.snapshot();
        let layout = self.text.layout_wrap(text, max_width, style);
        let height = layout.height;
        self.ops.push(DrawOp::Text {
            layout,
            x,
            y,
            color,
            h_align: style.h_align,
            v_align: style.v_align,
            subpixel: style.subpixel,
            box_width: Some(max_width),
            clip,
        });
        height
    }

    pub fn measure(&mut self, text: &str, style: &TextStyle) -> f32 {
        self.text.measure(text, style)
    }

    pub fn push_clip(&mut self, rect: Rect) {
        self.clips.push(rect, [0.0; 4]);
    }

    pub fn pop_clip(&mut self) {
        self.clips.pop();
    }

    pub fn hit(&mut self, id: WidgetId, rect: Rect) -> Interaction {
        let rect = match self.clips.aabb() {
            None => rect,
            Some(clip) => rect.intersect(clip).unwrap_or(Rect::ZERO),
        };
        self.input.nodes.push(HitNode { id, rect });
        Interaction {
            hovered: self.input.hover == Some(id),
            pressed: self.input.pressed == Some(id) && self.input.mouse_down,
            clicked: self.input.pressed == Some(id)
                && self.input.mouse_released
                && rect.contains(self.input.pointer_x, self.input.pointer_y),
        }
    }

    /// A scrolled area's offset. The wheel counts anywhere in `area`, on the rows inside
    /// it as well.
    pub fn scroll_offset(&mut self, id: WidgetId, area: Rect, max_offset: f32) -> f32 {
        let max_offset = if max_offset.is_finite() {
            max_offset.max(0.0)
        } else {
            0.0
        };
        let hovered = area.contains(self.input.pointer_x, self.input.pointer_y);
        let wheel = self.input.wheel_y;
        let slot = self.input.scrolls.entry(id).or_insert(0.0);
        if hovered {
            *slot += wheel;
        }
        *slot = slot.clamp(0.0, max_offset);
        *slot
    }

    /// Draw what was recorded. `clear` starts from a colour; None draws over what
    /// the map already put there.
    pub fn render(
        &mut self,
        gpu: &crate::render::Gpu,
        view: &wgpu::TextureView,
        encoder: &mut wgpu::CommandEncoder,
        clear: Option<wgpu::Color>,
    ) {
        self.glyphs.clear();
        self.cmds.clear();
        let scale = self.scale;
        let screen = [self.width * scale, self.height * scale];
        let count = self.ops.len();
        for index in 0..count {
            self.record(index, scale, screen);
        }
        let layout = self.pass.group1_layout().clone();
        let sampler = self.pass.sampler().clone();
        let bind = self
            .text
            .prepare_glyphs(&mut self.glyphs, gpu, &layout, &sampler);
        self.pass.begin_frame();
        let cmds = self.cmds.len();
        for index in 0..cmds {
            let cmd = self.cmds[index];
            match cmd {
                Cmd::Quad(desc) => self.pass.quad(&desc),
                Cmd::Image {
                    id,
                    dest,
                    tint,
                    clip,
                } => self.pass.image(id, dest, tint, clip),
                Cmd::Glyphs { start, end, clip } => {
                    for glyph_index in start..end {
                        let glyph = self.glyphs[glyph_index as usize];
                        if glyph.visible {
                            self.pass.glyph(
                                [glyph.x, glyph.y, glyph.w, glyph.h],
                                glyph.uv,
                                glyph.color,
                                clip,
                            );
                        }
                    }
                }
            }
        }
        self.pass
            .encode(gpu, view, encoder, clear, screen, bind.as_ref());
    }

    fn snapshot(&self) -> ClipSnapshot {
        ClipSnapshot {
            aabb: self.clips.aabb(),
            round: self.clips.round(),
        }
    }

    fn record(&mut self, index: usize, scale: f32, screen: [f32; 2]) {
        let extracted = match &self.ops[index] {
            DrawOp::Quad { rect, style, clip } => Extract::Quad {
                rect: *rect,
                style: *style,
                clip: *clip,
            },
            DrawOp::Image {
                id,
                rect,
                tint,
                clip,
            } => Extract::Image {
                id: id.0,
                rect: *rect,
                tint: *tint,
                clip: *clip,
            },
            DrawOp::Text {
                layout,
                x,
                y,
                color,
                h_align,
                v_align,
                subpixel,
                box_width,
                clip,
            } => Extract::Text {
                layout: Arc::clone(layout),
                x: *x,
                y: *y,
                color: *color,
                h_align: *h_align,
                v_align: *v_align,
                subpixel: *subpixel,
                box_width: *box_width,
                clip: *clip,
            },
        };
        match extracted {
            Extract::Quad { rect, style, clip } => {
                let radii = fit_radii(rect.w, rect.h, style.radii).map(|radius| radius * scale);
                let shadow = style.shadow.map(|shadow| {
                    (
                        [
                            shadow.color.r,
                            shadow.color.g,
                            shadow.color.b,
                            shadow.color.a,
                        ],
                        [shadow.offset_x * scale, shadow.offset_y * scale],
                        shadow.blur * scale,
                        shadow.spread * scale,
                    )
                });
                let (shadow_color, shadow_off, blur, spread) =
                    shadow.unwrap_or(([0.0; 4], [0.0; 2], 0.0, 0.0));
                self.cmds.push(Cmd::Quad(QuadDesc {
                    rect: scale_rect(rect, scale),
                    radii,
                    color0: style.fill.to_array(),
                    color1: style.fill_end.to_array(),
                    angle: style.gradient_deg * std::f32::consts::PI / 180.0,
                    border_w: style.border_width * scale,
                    border: style.border_color.to_array(),
                    shadow: shadow_color,
                    shadow_off,
                    blur,
                    spread,
                    clip: clip.to_px(scale, screen),
                }));
            }
            Extract::Image {
                id,
                rect,
                tint,
                clip,
            } => {
                self.cmds.push(Cmd::Image {
                    id,
                    dest: scale_rect(rect, scale),
                    tint: tint.to_array(),
                    clip: clip.to_px(scale, screen),
                });
            }
            Extract::Text {
                layout,
                x,
                y,
                color,
                h_align,
                v_align,
                subpixel,
                box_width,
                clip,
            } => {
                let start = self.glyphs.len() as u32;
                append_glyph_quads(
                    &GlyphDraw {
                        layout: &layout,
                        x,
                        y,
                        scale,
                        color: color.to_array(),
                        h_align,
                        v_align,
                        subpixel,
                        box_width,
                    },
                    &mut self.glyphs,
                );
                let end = self.glyphs.len() as u32;
                self.cmds.push(Cmd::Glyphs {
                    start,
                    end,
                    clip: clip.to_px(scale, screen),
                });
            }
        }
    }
}

enum Extract {
    Quad {
        rect: Rect,
        style: QuadStyle,
        clip: ClipSnapshot,
    },
    Image {
        id: u32,
        rect: Rect,
        tint: Color,
        clip: ClipSnapshot,
    },
    Text {
        layout: Arc<crate::render::TextLayout>,
        x: f32,
        y: f32,
        color: Color,
        h_align: HAlign,
        v_align: VAlign,
        subpixel: bool,
        box_width: Option<f32>,
        clip: ClipSnapshot,
    },
}

fn scale_rect(rect: Rect, scale: f32) -> [f32; 4] {
    [
        rect.x * scale,
        rect.y * scale,
        rect.w * scale,
        rect.h * scale,
    ]
}

pub fn fit_radii(w: f32, h: f32, radii: [f32; 4]) -> [f32; 4] {
    let radii = radii.map(|radius| {
        if radius.is_finite() {
            radius.max(0.0)
        } else {
            0.0
        }
    });
    if w <= 0.0 || h <= 0.0 {
        return [0.0; 4];
    }
    let limits = [
        radii[0] + radii[1],
        radii[2] + radii[3],
        radii[0] + radii[3],
        radii[1] + radii[2],
    ];
    let sides = [w, w, h, h];
    let mut scale = 1.0f32;
    for (sum, side) in limits.into_iter().zip(sides) {
        if sum > side && side > 0.0 {
            scale = scale.min(side / sum);
        }
    }
    radii.map(|radius| radius * scale)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_contains_and_intersect() {
        let rect = Rect::new(1.0, 2.0, 3.0, 4.0);
        assert!(rect.contains(1.0, 2.0));
        assert!(!rect.contains(4.0, 2.0));
        assert!(!rect.contains(1.0, 6.0));
        assert_eq!(
            rect.intersect(Rect::new(3.0, 4.0, 10.0, 10.0)),
            Some(Rect::new(3.0, 4.0, 1.0, 2.0))
        );
        assert!(rect.intersect(Rect::new(10.0, 10.0, 1.0, 1.0)).is_none());
    }

    #[test]
    fn clip_stack_intersects_and_restores() {
        let mut stack = ClipStack::default();
        assert!(stack.aabb().is_none());
        assert!(stack.round().is_none());
        stack.push(Rect::new(0.0, 0.0, 100.0, 80.0), [0.0; 4]);
        stack.push(Rect::new(40.0, 20.0, 100.0, 100.0), [0.0; 4]);
        assert_eq!(stack.aabb(), Some(Rect::new(40.0, 20.0, 60.0, 60.0)));
        stack.push(Rect::new(50.0, 30.0, 20.0, 20.0), [8.0, 0.0, 0.0, 0.0]);
        assert_eq!(
            stack.round(),
            Some((Rect::new(50.0, 30.0, 20.0, 20.0), [8.0, 0.0, 0.0, 0.0]))
        );
        let clipped = stack.aabb().unwrap();
        assert_eq!(clipped, Rect::new(50.0, 30.0, 20.0, 20.0));
        stack.pop();
        assert!(stack.round().is_none());
        assert_eq!(stack.aabb(), Some(Rect::new(40.0, 20.0, 60.0, 60.0)));
        stack.pop();
        stack.pop();
        assert!(stack.aabb().is_none());
        stack.pop();
        stack.push(Rect::new(0.0, 0.0, 10.0, 10.0), [0.0; 4]);
        stack.push(Rect::new(20.0, 20.0, 5.0, 5.0), [0.0; 4]);
        assert_eq!(stack.aabb(), Some(Rect::ZERO));
    }
}
