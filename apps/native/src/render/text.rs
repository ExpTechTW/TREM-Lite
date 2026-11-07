//! Shaping (cosmic-text) and an 8-bit glyph atlas.
//!
//! Embedded fonts are Manrope then Noto Sans TC, matching the CSS stack. Their
//! name tables use the default instance ("Manrope ExtraLight", "Noto Sans TC
//! Thin"), so that is what fontdb queries. System fonts are opened only after a
//! shaped run still has a missing glyph.
//!
//! Requested weights are clamped to 200..=800 before shaping. Outside that range
//! Manrope's `wght` axis does not match, and cosmic-text would pick Noto (whose
//! OS/2 weight is 100) for Latin as well. Swash still clamps each face to its
//! own axis, so CJK follows the same weight as Latin inside 200..=800.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use cosmic_text::{
    Attrs, Buffer, CacheKey, CacheKeyFlags, Family, FontFeatures, FontSystem, Metrics, Shaping,
    SwashContent, Weight, Wrap,
};
use cosmic_text::{Fallback, SwashImage};
use swash::scale::ScaleContext;
use unicode_script::Script;

use super::gpu::Gpu;

const MANROPE: &[u8] = include_bytes!("../../assets/fonts/Manrope.ttf");
const NOTO: &[u8] = include_bytes!("../../assets/fonts/NotoSansTC.ttf");

const ATLAS: u32 = 2048;
const PAD: u32 = 1;
const MAX_CACHE: usize = 512;
const WEIGHT_MIN: u16 = 200;
const WEIGHT_MAX: u16 = 800;

const KIND_SINGLE: u8 = 0;
const KIND_TRUNCATE: u8 = 1;
const KIND_WRAP: u8 = 2;

/// One file at a time, smallest useful face first. Stop once nothing is missing.
/// macOS keeps PingFang among its downloadable assets with no stable path, so Han
/// the embedded subset lacks falls through to the directory scan below, which
/// finds it with all its weights.
const SYSTEM_FONTS: &[&str] = &[
    "/System/Library/Fonts/Apple Symbols.ttf",
    r"C:\Windows\Fonts\seguisym.ttf",
    r"C:\Windows\Fonts\msjh.ttc",
    r"C:\Windows\Fonts\msjhbd.ttc",
    r"C:\Windows\Fonts\segoeui.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
];

const FORBIDDEN: &[&str] = &[".LastResort"];

/// Every face in the system font directories. The scan reads hundreds of files (about 50 ms
/// on macOS, more on a crowded Windows), and the embedded Noto subset lacks characters the
/// UI draws from its first frame, so it starts with the engine, on its own thread.
static SYSTEM_FACES: std::sync::OnceLock<Vec<cosmic_text::fontdb::FaceInfo>> =
    std::sync::OnceLock::new();

fn scan_system_fonts() -> Vec<cosmic_text::fontdb::FaceInfo> {
    let mut db = cosmic_text::fontdb::Database::new();
    db.load_system_fonts();
    // cosmic-text maps every font it opens (`FontSystem::get_font`), but matching a new
    // weight reads every face's weight axis, and an unmapped face opens and maps its file
    // each time: ~20 ms a weight with the system fonts loaded. Mapped once here instead,
    // one mapping a file, the same bytes either way.
    let ids: Vec<_> = db.faces().map(|face| face.id).collect();
    let mut mapped = std::collections::HashSet::new();
    for id in ids {
        let path = match db.face(id).map(|face| &face.source) {
            Some(cosmic_text::fontdb::Source::File(path)) => path.clone(),
            _ => continue,
        };
        if mapped.insert(path) {
            // SAFETY: as in cosmic-text's `get_font`: a font file rewritten while mapped
            // could fault. These are the system and user font directories.
            unsafe {
                db.make_shared_face_data(id);
            }
        }
    }
    db.faces().cloned().collect()
}

pub fn prefetch_system_fonts() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        let spawned = std::thread::Builder::new()
            .name("trem-fonts".to_string())
            .spawn(|| {
                SYSTEM_FACES.get_or_init(scan_system_fonts);
            });
        if let Err(err) = spawned {
            log::debug!("無法在背景掃描系統字型：{err}");
        }
    });
}

/// Waits for the scan if it is still running, or runs it here if it never started.
fn system_faces() -> &'static [cosmic_text::fontdb::FaceInfo] {
    SYSTEM_FACES.get_or_init(scan_system_fonts)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HAlign {
    Left,
    Center,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VAlign {
    Top,
    Middle,
    Baseline,
}

#[derive(Clone, Debug)]
pub struct TextStyle {
    pub size: f32,
    pub weight: u16,
    pub h_align: HAlign,
    pub v_align: VAlign,
    pub tabular: bool,
    pub letter_spacing: f32,
    pub line_height: f32,
    pub subpixel: bool,
}

impl Default for TextStyle {
    fn default() -> Self {
        Self {
            size: 15.0,
            weight: 400,
            h_align: HAlign::Left,
            v_align: VAlign::Top,
            tabular: false,
            letter_spacing: 0.0,
            line_height: 0.0,
            subpixel: true,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Glyph {
    pub font_id: cosmic_text::fontdb::ID,
    pub glyph_id: u16,
    pub font_size: f32,
    pub weight: u16,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub x_offset: f32,
    pub y_offset: f32,
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug)]
pub struct TextLine {
    pub glyphs: Vec<Glyph>,
    pub width: f32,
    pub baseline: f32,
    pub top: f32,
    pub height: f32,
}

#[derive(Clone, Debug)]
pub struct TextLayout {
    pub lines: Vec<TextLine>,
    pub width: f32,
    pub height: f32,
    pub truncated: bool,
}

impl TextLayout {
    fn empty() -> Self {
        Self {
            lines: Vec::new(),
            width: 0.0,
            height: 0.0,
            truncated: false,
        }
    }
}

/// A glyph quad before the atlas UV is known. `prepare_glyphs` fills the rest.
#[derive(Clone, Copy, Debug)]
pub struct GlyphQuad {
    pub key: CacheKey,
    pub pen_x: i32,
    pub pen_y: i32,
    pub color: [f32; 4],
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub uv: [f32; 4],
    pub visible: bool,
}

struct StackFallback {
    common: Vec<&'static str>,
    han: Vec<&'static str>,
}

impl StackFallback {
    fn new(noto: &'static str) -> Self {
        Self {
            common: vec![
                noto,
                "Apple Symbols",
                ".SF NS",
                "Arial Unicode MS",
                "Segoe UI Symbol",
                "Segoe UI",
                "DejaVu Sans",
            ],
            han: vec![
                noto,
                "PingFang TC",
                "PingFang HK",
                "PingFang SC",
                "Heiti TC",
                "STHeiti",
                "Hiragino Sans GB",
                "Arial Unicode MS",
                "Microsoft JhengHei",
                "Microsoft YaHei",
                "Noto Sans CJK TC",
                "Noto Sans CJK SC",
                "Source Han Sans TC",
            ],
        }
    }
}

impl Fallback for StackFallback {
    fn common_fallback(&self) -> &[&'static str] {
        &self.common
    }

    fn forbidden_fallback(&self) -> &[&'static str] {
        FORBIDDEN
    }

    fn script_fallback(&self, script: Script, _locale: &str) -> &[&'static str] {
        match script {
            Script::Han
            | Script::Bopomofo
            | Script::Hiragana
            | Script::Katakana
            | Script::Hangul => &self.han,
            _ => &[],
        }
    }
}

struct CacheSlot {
    text: String,
    weight: u16,
    size_bits: u32,
    spacing_bits: u32,
    line_bits: u32,
    tabular: bool,
    kind: u8,
    width_bits: u32,
    layout: Arc<TextLayout>,
    tick: u64,
}

struct SlotKey<'a> {
    text: &'a str,
    weight: u16,
    size_bits: u32,
    spacing_bits: u32,
    line_bits: u32,
    tabular: bool,
    kind: u8,
    width_bits: u32,
}

impl CacheSlot {
    fn matches(&self, key: &SlotKey<'_>) -> bool {
        self.text == key.text
            && self.weight == key.weight
            && self.size_bits == key.size_bits
            && self.spacing_bits == key.spacing_bits
            && self.line_bits == key.line_bits
            && self.tabular == key.tabular
            && self.kind == key.kind
            && self.width_bits == key.width_bits
    }
}

struct Shaped {
    layout: TextLayout,
    missing: bool,
}

pub struct TextEngine {
    fonts: FontSystem,
    scale: ScaleContext,
    buffer: Option<Buffer>,
    manrope: &'static str,
    manrope_ids: Vec<cosmic_text::fontdb::ID>,
    noto_ids: Vec<cosmic_text::fontdb::ID>,
    cache: HashMap<u64, Vec<CacheSlot>>,
    cache_len: usize,
    tick: u64,
    atlas: Atlas,
    font_cursor: usize,
    scanned_system: bool,
    warned_missing: bool,
}

impl TextEngine {
    pub fn new() -> Self {
        prefetch_system_fonts();
        let mut db = cosmic_text::fontdb::Database::new();
        // The embedded bytes themselves, not a copy of them.
        db.load_font_source(cosmic_text::fontdb::Source::Binary(Arc::new(MANROPE)));
        db.load_font_source(cosmic_text::fontdb::Source::Binary(Arc::new(NOTO)));
        let manrope_ids = face_ids(&db, "Manrope");
        let noto_ids = face_ids(&db, "Noto Sans TC");
        let manrope = leak_str(
            find_family(&db, "Manrope").unwrap_or_else(|| "Manrope ExtraLight".to_string()),
        );
        let noto = leak_str(
            find_family(&db, "Noto Sans TC").unwrap_or_else(|| "Noto Sans TC Thin".to_string()),
        );
        log::info!("嵌入字型：{manrope}、{noto}");
        db.set_sans_serif_family(manrope);
        let fallback = StackFallback::new(noto);
        let mut fonts =
            FontSystem::new_with_locale_and_db_and_fallback("zh-TW".to_string(), db, fallback);
        let buffer = if manrope_ids.is_empty() {
            log::error!("嵌入字型無法載入，文字停用");
            None
        } else {
            Some(Buffer::new(&mut fonts, Metrics::new(16.0, 22.0)))
        };
        let engine = Self {
            fonts,
            scale: ScaleContext::new(),
            buffer,
            manrope,
            manrope_ids,
            noto_ids,
            cache: HashMap::new(),
            cache_len: 0,
            tick: 0,
            atlas: Atlas::new(),
            font_cursor: 0,
            scanned_system: false,
            warned_missing: false,
        };
        log::debug!(
            "Manrope faces {}，Noto faces {}",
            engine.manrope_ids.len(),
            engine.noto_ids.len()
        );
        engine
    }

    pub fn measure(&mut self, text: &str, style: &TextStyle) -> f32 {
        self.layout_single(text, style).width
    }

    pub fn layout_single(&mut self, text: &str, style: &TextStyle) -> Arc<TextLayout> {
        self.cached(text, style, KIND_SINGLE, 0, Wrap::None, None)
    }

    pub fn layout_wrap(
        &mut self,
        text: &str,
        max_width: f32,
        style: &TextStyle,
    ) -> Arc<TextLayout> {
        let width = finite_width(max_width);
        self.cached(
            text,
            style,
            KIND_WRAP,
            width.to_bits(),
            Wrap::WordOrGlyph,
            Some(width),
        )
    }

    pub fn layout_truncate(
        &mut self,
        text: &str,
        max_width: f32,
        style: &TextStyle,
    ) -> Arc<TextLayout> {
        let width = finite_width(max_width);
        let key = style_hash(text, style, KIND_TRUNCATE, width.to_bits());
        if let Some(hit) = self.lookup(key, text, style, KIND_TRUNCATE, width.to_bits()) {
            return hit;
        }
        let full = self.layout_single(text, style);
        let dots = self.layout_single("\u{2026}", style);
        let layout = truncate_layout(&full, &dots, width);
        self.insert(key, text, style, KIND_TRUNCATE, width.to_bits(), layout)
    }

    pub fn release_atlas(&mut self) {
        self.atlas.release();
    }

    pub fn prepare_glyphs(
        &mut self,
        glyphs: &mut [GlyphQuad],
        gpu: &Gpu,
        layout: &wgpu::BindGroupLayout,
        sampler: &wgpu::Sampler,
    ) -> Option<wgpu::BindGroup> {
        if glyphs.is_empty() {
            return self.atlas.bind.clone();
        }
        self.atlas.ensure_pixels();
        let frame = self.atlas.next_frame();
        let mut missing = Vec::new();
        for glyph in glyphs.iter() {
            if self.atlas.touch(glyph.key, frame) {
                continue;
            }
            if !missing.contains(&glyph.key) {
                missing.push(glyph.key);
            }
        }
        // Rasterized on the workers, then placed in order: the atlas is laid out as if
        // they had come one by one.
        let mut images = self.rasterize(&missing);
        let mut rebuilt = false;
        for key in missing {
            if self.atlas.touch(key, frame) {
                continue;
            }
            let Some(image) = images.remove(&key) else {
                continue;
            };
            match self.atlas.insert(key, &image, frame) {
                Insert::Placed => {}
                Insert::Skip => {}
                Insert::Full => {
                    if rebuilt {
                        continue;
                    }
                    let keys: Vec<CacheKey> = glyphs.iter().map(|glyph| glyph.key).collect();
                    self.rebuild_atlas(&keys, frame);
                    rebuilt = true;
                }
            }
        }
        let atlas = ATLAS as f32;
        for glyph in glyphs.iter_mut() {
            if let Some(place) = self.atlas.place(glyph.key) {
                glyph.x = (glyph.pen_x + place.left) as f32;
                glyph.y = (glyph.pen_y - place.top) as f32;
                glyph.w = place.w as f32;
                glyph.h = place.h as f32;
                glyph.uv = [
                    place.x as f32 / atlas,
                    place.y as f32 / atlas,
                    (place.x + place.w) as f32 / atlas,
                    (place.y + place.h) as f32 / atlas,
                ];
                glyph.visible = place.w > 0 && place.h > 0;
            }
        }
        self.atlas.flush(gpu, layout, sampler)
    }

    fn cached(
        &mut self,
        text: &str,
        style: &TextStyle,
        kind: u8,
        width_bits: u32,
        wrap: Wrap,
        width: Option<f32>,
    ) -> Arc<TextLayout> {
        let key = style_hash(text, style, kind, width_bits);
        if let Some(hit) = self.lookup(key, text, style, kind, width_bits) {
            return hit;
        }
        let shaped = self.shape_resolved(text, style, wrap, width);
        self.insert(key, text, style, kind, width_bits, shaped)
    }

    fn lookup(
        &mut self,
        key: u64,
        text: &str,
        style: &TextStyle,
        kind: u8,
        width_bits: u32,
    ) -> Option<Arc<TextLayout>> {
        let weight = clamp_weight(style.weight);
        let size_bits = style.size.to_bits();
        let spacing_bits = style.letter_spacing.to_bits();
        let line_bits = line_height_of(style).to_bits();
        let tick = self.tick.wrapping_add(1);
        self.tick = tick;
        let query = SlotKey {
            text,
            weight,
            size_bits,
            spacing_bits,
            line_bits,
            tabular: style.tabular,
            kind,
            width_bits,
        };
        let slot = self
            .cache
            .get_mut(&key)?
            .iter_mut()
            .find(|slot| slot.matches(&query))?;
        slot.tick = tick;
        Some(Arc::clone(&slot.layout))
    }

    fn insert(
        &mut self,
        key: u64,
        text: &str,
        style: &TextStyle,
        kind: u8,
        width_bits: u32,
        layout: TextLayout,
    ) -> Arc<TextLayout> {
        let layout = Arc::new(layout);
        self.cache.entry(key).or_default().push(CacheSlot {
            text: text.to_string(),
            weight: clamp_weight(style.weight),
            size_bits: style.size.to_bits(),
            spacing_bits: style.letter_spacing.to_bits(),
            line_bits: line_height_of(style).to_bits(),
            tabular: style.tabular,
            kind,
            width_bits,
            layout: Arc::clone(&layout),
            tick: self.tick,
        });
        self.cache_len += 1;
        self.evict();
        layout
    }

    fn evict(&mut self) {
        if self.cache_len <= MAX_CACHE {
            return;
        }
        let mut oldest_tick = u64::MAX;
        let mut oldest_key = 0u64;
        let mut oldest_index = 0usize;
        for (key, slots) in &self.cache {
            for (index, slot) in slots.iter().enumerate() {
                if slot.tick < oldest_tick {
                    oldest_tick = slot.tick;
                    oldest_key = *key;
                    oldest_index = index;
                }
            }
        }
        if oldest_tick == u64::MAX {
            return;
        }
        if let Some(slots) = self.cache.get_mut(&oldest_key) {
            slots.swap_remove(oldest_index);
            if slots.is_empty() {
                self.cache.remove(&oldest_key);
            }
            self.cache_len = self.cache_len.saturating_sub(1);
        }
    }

    fn shape_resolved(
        &mut self,
        text: &str,
        style: &TextStyle,
        wrap: Wrap,
        width: Option<f32>,
    ) -> TextLayout {
        let mut shaped = self.shape_once(text, style, wrap, width);
        let mut steps = 0;
        while shaped.missing && steps < 40 {
            steps += 1;
            if !self.load_one_fallback() {
                break;
            }
            shaped = self.shape_once(text, style, wrap, width);
        }
        if shaped.missing && !self.warned_missing {
            self.warned_missing = true;
            log::warn!("嵌入字型與系統 fallback 仍缺字，缺的字會畫成 .notdef");
        }
        shaped.layout
    }

    fn shape_once(
        &mut self,
        text: &str,
        style: &TextStyle,
        wrap: Wrap,
        width: Option<f32>,
    ) -> Shaped {
        if !style.size.is_finite() || style.size <= 0.0 {
            return Shaped {
                layout: TextLayout::empty(),
                missing: false,
            };
        }
        let manrope = self.manrope;
        let tabular = style.tabular;
        let weight = Weight(clamp_weight(style.weight));
        let spacing = if style.size > 0.0 {
            style.letter_spacing / style.size
        } else {
            0.0
        };
        let metrics = Metrics::new(style.size, line_height_of(style).max(0.01));
        let TextEngine { fonts, buffer, .. } = self;
        let Some(buffer) = buffer.as_mut() else {
            return Shaped {
                layout: TextLayout::empty(),
                missing: false,
            };
        };
        let mut features = FontFeatures::new();
        if tabular {
            features.enable(cosmic_text::FeatureTag::new(b"tnum"));
        }
        let attrs = Attrs::new()
            .family(Family::Name(manrope))
            .weight(weight)
            .letter_spacing(spacing)
            .font_features(features);
        let mut borrowed = buffer.borrow_with(fonts);
        borrowed.set_metrics(metrics);
        borrowed.set_wrap(wrap);
        borrowed.set_size(width, None);
        borrowed.set_text(text, &attrs, Shaping::Advanced, None);
        let mut lines = Vec::new();
        let mut missing = false;
        let mut max_w = 0.0f32;
        for run in borrowed.layout_runs() {
            if !missing && line_missing(run.text, run.glyphs) {
                missing = true;
            }
            max_w = max_w.max(run.line_w);
            lines.push(TextLine {
                glyphs: run.glyphs.iter().map(convert_glyph).collect(),
                width: run.line_w,
                baseline: run.line_y,
                top: run.line_top,
                height: run.line_height,
            });
        }
        let height = lines
            .last()
            .map(|line| line.top + line.height)
            .unwrap_or(0.0);
        Shaped {
            layout: TextLayout {
                lines,
                width: max_w,
                height,
                truncated: false,
            },
            missing,
        }
    }

    fn load_one_fallback(&mut self) -> bool {
        while self.font_cursor < SYSTEM_FONTS.len() {
            let path = SYSTEM_FONTS[self.font_cursor];
            self.font_cursor += 1;
            if !std::path::Path::new(path).is_file() {
                continue;
            }
            match self.fonts.db_mut().load_font_file(path) {
                Ok(()) => {
                    log::info!("嵌入字型缺字，載入系統字型：{path}");
                    return true;
                }
                Err(err) => log::debug!("無法載入系統字型 {path}：{err}"),
            }
        }
        if !self.scanned_system {
            self.scanned_system = true;
            log::info!("嵌入字型仍缺字，改用系統字型目錄");
            // What `load_system_fonts` would add, in its order, without the wait.
            let db = self.fonts.db_mut();
            for face in system_faces() {
                db.push_face_info(face.clone());
            }
            return true;
        }
        false
    }

    fn rebuild_atlas(&mut self, keys: &[CacheKey], frame: u64) {
        self.atlas.reset();
        let mut unique: Vec<CacheKey> = Vec::with_capacity(keys.len());
        let mut seen = std::collections::HashSet::with_capacity(keys.len());
        for &key in keys {
            if seen.insert(key) {
                unique.push(key);
            }
        }
        let mut images = self.rasterize(&unique);
        for &key in keys {
            if self.atlas.contains(key) {
                self.atlas.touch(key, frame);
                continue;
            }
            let Some(image) = images.remove(&key) else {
                continue;
            };
            let _ = self.atlas.insert_no_evict(key, &image, frame);
        }
    }

    /// Glyph images for `keys`, on the CPU pool when there are enough to share out.
    fn rasterize(&mut self, keys: &[CacheKey]) -> HashMap<CacheKey, SwashImage> {
        use rayon::prelude::*;
        const WORTH_SHARING: usize = 8;
        let jobs: Vec<(CacheKey, Arc<cosmic_text::Font>)> = keys
            .iter()
            .filter_map(|key| {
                let font = self.fonts.get_font(key.font_id, key.font_weight);
                if font.is_none() {
                    log::warn!("找不到字型 {:?}", key.font_id);
                }
                font.map(|font| (*key, font))
            })
            .collect();
        let images: Vec<(CacheKey, Option<SwashImage>)> = if jobs.len() < WORTH_SHARING {
            jobs.into_iter()
                .map(|(key, font)| (key, rasterize_glyph(&font, &mut self.scale, key)))
                .collect()
        } else {
            jobs.into_par_iter()
                .map_init(ScaleContext::new, |context, (key, font)| {
                    (key, rasterize_glyph(&font, context, key))
                })
                .collect()
        };
        images
            .into_iter()
            .filter_map(|(key, image)| image.map(|image| (key, image)))
            .collect()
    }
}

/// cosmic-text's own rasterizer (swash.rs `swash_image`), with the font already looked up,
/// so it can run on any thread: the same pixels either way.
fn rasterize_glyph(
    font: &cosmic_text::Font,
    context: &mut ScaleContext,
    key: CacheKey,
) -> Option<SwashImage> {
    use swash::scale::{Render, Source, StrikeWith};
    use swash::zeno::{Angle, Format, Transform, Vector};
    let wght = swash::Tag::from_be_bytes(*b"wght");
    let variable_width = font.as_swash().variations().find_by_tag(wght);
    let mut scaler = context
        .builder(font.as_swash())
        .size(f32::from_bits(key.font_size_bits))
        .hint(!key.flags.contains(CacheKeyFlags::DISABLE_HINTING));
    if let Some(variation) = variable_width {
        scaler = scaler.normalized_coords(font.as_swash().variations().normalized_coords([(
            wght,
            f32::from(key.font_weight.0).clamp(variation.min_value(), variation.max_value()),
        )]));
    }
    let mut scaler = scaler.build();
    let offset = if key.flags.contains(CacheKeyFlags::PIXEL_FONT) {
        Vector::new(key.x_bin.as_float().round(), key.y_bin.as_float().round())
    } else {
        Vector::new(key.x_bin.as_float(), key.y_bin.as_float())
    };
    Render::new(&[
        Source::ColorOutline(0),
        Source::ColorBitmap(StrikeWith::BestFit),
        Source::Outline,
    ])
    .format(Format::Alpha)
    .offset(offset)
    .transform(
        key.flags
            .contains(CacheKeyFlags::FAKE_ITALIC)
            .then(|| Transform::skew(Angle::from_degrees(14.0), Angle::from_degrees(0.0))),
    )
    .render(&mut scaler, key.glyph_id)
}

fn convert_glyph(glyph: &cosmic_text::LayoutGlyph) -> Glyph {
    Glyph {
        font_id: glyph.font_id,
        glyph_id: glyph.glyph_id,
        font_size: glyph.font_size,
        weight: glyph.font_weight.0,
        x: glyph.x,
        y: glyph.y,
        w: glyph.w,
        x_offset: glyph.x_offset,
        y_offset: glyph.y_offset,
        start: glyph.start,
        end: glyph.end,
    }
}

fn line_missing(text: &str, glyphs: &[cosmic_text::LayoutGlyph]) -> bool {
    glyphs.iter().any(|glyph| {
        glyph.glyph_id == 0
            && text
                .get(glyph.start..glyph.end)
                .is_some_and(|slice| slice.chars().any(|ch| !ch.is_whitespace()))
    })
}

fn truncate_layout(full: &TextLayout, dots: &TextLayout, max_width: f32) -> TextLayout {
    let Some(line) = full.lines.first() else {
        return TextLayout::empty();
    };
    let dot_glyphs = dots
        .lines
        .first()
        .map(|line| line.glyphs.as_slice())
        .unwrap_or(&[]);
    let dot_w = dots.lines.first().map(|line| line.width).unwrap_or(0.0);
    let right: Vec<f32> = line.glyphs.iter().map(|glyph| glyph.x + glyph.w).collect();
    let ends = cluster_ends(&line.glyphs);
    let Some(keep) = ellipsis_prefix(&right, &ends, dot_w, max_width) else {
        return TextLayout {
            lines: vec![line.clone()],
            width: line.width,
            height: full.height.max(line.height),
            truncated: false,
        };
    };
    let prefix = if keep == 0 {
        0.0
    } else {
        right.get(keep - 1).copied().unwrap_or(0.0)
    };
    let mut glyphs = line.glyphs[..keep].to_vec();
    for glyph in dot_glyphs {
        let mut copy = glyph.clone();
        copy.x += prefix;
        glyphs.push(copy);
    }
    let width = prefix + dot_w;
    let height = line.height;
    TextLayout {
        lines: vec![TextLine {
            glyphs,
            width,
            baseline: line.baseline,
            top: line.top,
            height,
        }],
        width,
        height: full.height.max(height),
        truncated: true,
    }
}

fn cluster_ends(glyphs: &[Glyph]) -> Vec<bool> {
    glyphs
        .iter()
        .enumerate()
        .map(|(index, glyph)| {
            glyphs
                .get(index + 1)
                .is_none_or(|next| next.start >= glyph.end)
        })
        .collect()
}

/// `None` when the line fits. `Some(n)` keeps the first `n` glyphs plus an ellipsis.
pub fn ellipsis_prefix(
    right: &[f32],
    cluster_end: &[bool],
    ellipsis_w: f32,
    max_w: f32,
) -> Option<usize> {
    if right.is_empty() {
        return None;
    }
    let last = right[right.len() - 1];
    if last <= max_w + 0.01 {
        return None;
    }
    let mut best = 0usize;
    let mut found = false;
    for (index, edge) in right.iter().enumerate() {
        let ends = cluster_end.get(index).copied().unwrap_or(true);
        if !ends {
            continue;
        }
        if *edge + ellipsis_w <= max_w + 0.01 {
            best = index + 1;
            found = true;
        } else {
            break;
        }
    }
    if found {
        Some(best)
    } else {
        Some(0)
    }
}

pub struct GlyphDraw<'a> {
    pub layout: &'a TextLayout,
    pub x: f32,
    pub y: f32,
    pub scale: f32,
    pub color: [f32; 4],
    pub h_align: HAlign,
    pub v_align: VAlign,
    pub subpixel: bool,
    pub box_width: Option<f32>,
}

pub fn append_glyph_quads(draw: &GlyphDraw<'_>, out: &mut Vec<GlyphQuad>) {
    if !(draw.scale.is_finite() && draw.scale > 0.0) {
        return;
    }
    let layout = draw.layout;
    let first_baseline = layout
        .lines
        .first()
        .map(|line| line.baseline)
        .unwrap_or(0.0);
    for line in &layout.lines {
        let shift_x = match (draw.h_align, draw.box_width) {
            (HAlign::Left, _) => 0.0,
            (HAlign::Center, Some(box_w)) => (box_w - line.width) * 0.5,
            (HAlign::Center, None) => -line.width * 0.5,
            (HAlign::Right, Some(box_w)) => box_w - line.width,
            (HAlign::Right, None) => -line.width,
        };
        let baseline = match draw.v_align {
            VAlign::Top => draw.y + line.baseline,
            VAlign::Middle => draw.y - layout.height * 0.5 + line.baseline,
            VAlign::Baseline => draw.y + (line.baseline - first_baseline),
        };
        let origin_x = (draw.x + shift_x) * draw.scale;
        let origin_y = baseline * draw.scale;
        for glyph in &line.glyphs {
            let (key, pen_x, pen_y) =
                glyph_key(glyph, origin_x, origin_y, draw.scale, draw.subpixel);
            out.push(GlyphQuad {
                key,
                pen_x,
                pen_y,
                color: draw.color,
                x: 0.0,
                y: 0.0,
                w: 0.0,
                h: 0.0,
                uv: [0.0; 4],
                visible: false,
            });
        }
    }
}

fn glyph_key(
    glyph: &Glyph,
    origin_x: f32,
    origin_y: f32,
    scale: f32,
    subpixel: bool,
) -> (CacheKey, i32, i32) {
    let x_off = glyph.font_size * glyph.x_offset;
    let y_off = glyph.font_size * glyph.y_offset;
    let mut px = (glyph.x + x_off).mul_add(scale, origin_x);
    // Match cosmic-text: hint Y to a whole pixel, keep X fractional unless asked not to.
    let py = (glyph.y - y_off).mul_add(scale, origin_y).trunc();
    if !subpixel {
        px = px.round();
    }
    CacheKey::new(
        glyph.font_id,
        glyph.glyph_id,
        glyph.font_size * scale,
        (px, py),
        Weight(glyph.weight),
        CacheKeyFlags::empty(),
    )
}

fn clamp_weight(weight: u16) -> u16 {
    weight.clamp(WEIGHT_MIN, WEIGHT_MAX)
}

fn line_height_of(style: &TextStyle) -> f32 {
    if style.line_height > 0.0 {
        style.line_height
    } else {
        style.size * 1.35
    }
}

fn finite_width(width: f32) -> f32 {
    if width.is_finite() {
        width.max(0.0)
    } else {
        0.0
    }
}

fn style_hash(text: &str, style: &TextStyle, kind: u8, width_bits: u32) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    style.size.to_bits().hash(&mut hasher);
    clamp_weight(style.weight).hash(&mut hasher);
    style.tabular.hash(&mut hasher);
    style.letter_spacing.to_bits().hash(&mut hasher);
    line_height_of(style).to_bits().hash(&mut hasher);
    kind.hash(&mut hasher);
    width_bits.hash(&mut hasher);
    hasher.finish()
}

fn leak_str(text: String) -> &'static str {
    Box::leak(text.into_boxed_str())
}

fn find_family(db: &cosmic_text::fontdb::Database, needle: &str) -> Option<String> {
    db.faces().find_map(|face| {
        face.families
            .iter()
            .find(|(name, _)| name.contains(needle))
            .map(|(name, _)| name.clone())
    })
}

fn face_ids(db: &cosmic_text::fontdb::Database, needle: &str) -> Vec<cosmic_text::fontdb::ID> {
    db.faces()
        .filter(|face| face.families.iter().any(|(name, _)| name.contains(needle)))
        .map(|face| face.id)
        .collect()
}

struct Atlas {
    size: u32,
    pixels: Vec<u8>,
    shelves: Vec<Shelf>,
    free: Vec<FreeRect>,
    shelf_y: u32,
    entries: HashMap<CacheKey, AtlasGlyph>,
    frame: u64,
    dirty: bool,
    dirty_min_y: u32,
    dirty_max_y: u32,
    texture: Option<wgpu::Texture>,
    view: Option<wgpu::TextureView>,
    bind: Option<wgpu::BindGroup>,
}

struct Shelf {
    y: u32,
    h: u32,
    x: u32,
}

struct FreeRect {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

#[derive(Clone, Copy)]
struct AtlasGlyph {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    left: i32,
    top: i32,
    tick: u64,
}

enum Insert {
    Placed,
    Skip,
    Full,
}

impl Atlas {
    fn new() -> Self {
        Self {
            size: ATLAS,
            pixels: Vec::new(),
            shelves: Vec::new(),
            free: Vec::new(),
            shelf_y: 0,
            entries: HashMap::new(),
            frame: 0,
            dirty: false,
            dirty_min_y: u32::MAX,
            dirty_max_y: 0,
            texture: None,
            view: None,
            bind: None,
        }
    }

    fn ensure_pixels(&mut self) {
        let bytes = (self.size * self.size) as usize;
        if self.pixels.len() != bytes {
            self.pixels = vec![0; bytes];
            self.dirty = true;
            self.dirty_min_y = 0;
            self.dirty_max_y = 0;
        }
    }

    fn next_frame(&mut self) -> u64 {
        self.frame = self.frame.wrapping_add(1);
        self.frame
    }

    fn contains(&self, key: CacheKey) -> bool {
        self.entries.contains_key(&key)
    }

    fn touch(&mut self, key: CacheKey, frame: u64) -> bool {
        if let Some(entry) = self.entries.get_mut(&key) {
            entry.tick = frame;
            true
        } else {
            false
        }
    }

    fn place(&self, key: CacheKey) -> Option<AtlasGlyph> {
        self.entries.get(&key).copied()
    }

    fn insert(&mut self, key: CacheKey, image: &SwashImage, frame: u64) -> Insert {
        self.insert_inner(key, image, frame, true)
    }

    fn insert_no_evict(&mut self, key: CacheKey, image: &SwashImage, frame: u64) -> Insert {
        self.insert_inner(key, image, frame, false)
    }

    fn insert_inner(
        &mut self,
        key: CacheKey,
        image: &SwashImage,
        frame: u64,
        evict: bool,
    ) -> Insert {
        let w = image.placement.width;
        let h = image.placement.height;
        if w == 0 || h == 0 {
            return Insert::Skip;
        }
        if w > self.size || h > self.size {
            return Insert::Skip;
        }
        loop {
            if let Some((x, y)) = self.find_slot(w, h) {
                if !self.blit(x, y, image) {
                    return Insert::Skip;
                }
                self.entries.insert(
                    key,
                    AtlasGlyph {
                        x,
                        y,
                        w,
                        h,
                        left: image.placement.left,
                        top: image.placement.top,
                        tick: frame,
                    },
                );
                return Insert::Placed;
            }
            if !evict || !self.evict_one(frame) {
                return Insert::Full;
            }
        }
    }

    fn find_slot(&mut self, w: u32, h: u32) -> Option<(u32, u32)> {
        if let Some(index) = self.free.iter().position(|rect| rect.w >= w && rect.h >= h) {
            let rect = self.free.swap_remove(index);
            let leftover = rect.w - w;
            if leftover > PAD {
                self.free.push(FreeRect {
                    x: rect.x + w + PAD,
                    y: rect.y,
                    w: leftover - PAD,
                    h: rect.h,
                });
            }
            return Some((rect.x, rect.y));
        }
        for shelf in &mut self.shelves {
            if shelf.h >= h && shelf.x + w <= self.size {
                let x = shelf.x;
                shelf.x = shelf.x.saturating_add(w + PAD);
                return Some((x, shelf.y));
            }
        }
        if self.shelf_y + h <= self.size {
            let y = self.shelf_y;
            self.shelves.push(Shelf { y, h, x: w + PAD });
            self.shelf_y = y + h + PAD;
            Some((0, y))
        } else {
            None
        }
    }

    fn evict_one(&mut self, frame: u64) -> bool {
        let oldest = self
            .entries
            .iter()
            .filter(|(_, entry)| entry.tick < frame)
            .min_by_key(|(_, entry)| entry.tick)
            .map(|(key, _)| *key);
        let Some(key) = oldest else {
            return false;
        };
        let Some(entry) = self.entries.remove(&key) else {
            return false;
        };
        self.free.push(FreeRect {
            x: entry.x,
            y: entry.y,
            w: entry.w,
            h: entry.h,
        });
        true
    }

    fn blit(&mut self, x: u32, y: u32, image: &SwashImage) -> bool {
        let w = image.placement.width;
        let h = image.placement.height;
        if x + w > self.size || y + h > self.size {
            return false;
        }
        let rows = h as usize;
        let cols = w as usize;
        match image.content {
            SwashContent::Mask => {
                if image.data.len() < rows * cols {
                    return false;
                }
                for row in 0..rows {
                    let src = row * cols;
                    let dst = ((y as usize + row) * self.size as usize) + x as usize;
                    self.pixels[dst..dst + cols].copy_from_slice(&image.data[src..src + cols]);
                }
            }
            SwashContent::Color => {
                if image.data.len() < rows * cols * 4 {
                    return false;
                }
                for row in 0..rows {
                    for col in 0..cols {
                        let src = (row * cols + col) * 4;
                        let dst = ((y as usize + row) * self.size as usize) + x as usize + col;
                        self.pixels[dst] = image.data[src + 3];
                    }
                }
            }
            SwashContent::SubpixelMask => {
                if image.data.len() < rows * cols * 3 {
                    return false;
                }
                for row in 0..rows {
                    for col in 0..cols {
                        let src = (row * cols + col) * 3;
                        let dst = ((y as usize + row) * self.size as usize) + x as usize + col;
                        let sum = u16::from(image.data[src])
                            + u16::from(image.data[src + 1])
                            + u16::from(image.data[src + 2]);
                        self.pixels[dst] = (sum / 3) as u8;
                    }
                }
            }
        }
        self.dirty = true;
        self.dirty_min_y = self.dirty_min_y.min(y);
        self.dirty_max_y = self.dirty_max_y.max(y + h);
        true
    }

    fn reset(&mut self) {
        self.ensure_pixels();
        self.pixels.fill(0);
        self.shelves.clear();
        self.free.clear();
        self.shelf_y = 0;
        self.entries.clear();
        self.dirty = true;
        self.dirty_min_y = 0;
        self.dirty_max_y = self.size;
    }

    fn release(&mut self) {
        self.pixels = Vec::new();
        self.shelves.clear();
        self.free.clear();
        self.shelf_y = 0;
        self.entries.clear();
        self.texture = None;
        self.view = None;
        self.bind = None;
        self.dirty = false;
        self.dirty_min_y = u32::MAX;
        self.dirty_max_y = 0;
    }

    fn flush(
        &mut self,
        gpu: &Gpu,
        layout: &wgpu::BindGroupLayout,
        sampler: &wgpu::Sampler,
    ) -> Option<wgpu::BindGroup> {
        if self.pixels.is_empty() {
            return None;
        }
        if self.texture.is_none() {
            let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("glyph-atlas"),
                size: wgpu::Extent3d {
                    width: self.size,
                    height: self.size,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::R8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            self.bind = Some(text_bind_group(gpu, layout, &view, sampler));
            self.texture = Some(texture);
            self.view = Some(view);
        }
        if self.dirty && self.dirty_max_y > self.dirty_min_y {
            let y0 = self.dirty_min_y;
            let y1 = self.dirty_max_y.min(self.size);
            let start = (y0 * self.size) as usize;
            let end = (y1 * self.size) as usize;
            if let Some(texture) = self.texture.as_ref() {
                if end <= self.pixels.len() {
                    gpu.queue.write_texture(
                        wgpu::TexelCopyTextureInfo {
                            texture,
                            mip_level: 0,
                            origin: wgpu::Origin3d { x: 0, y: y0, z: 0 },
                            aspect: wgpu::TextureAspect::All,
                        },
                        &self.pixels[start..end],
                        wgpu::TexelCopyBufferLayout {
                            offset: 0,
                            bytes_per_row: Some(self.size),
                            rows_per_image: Some(y1 - y0),
                        },
                        wgpu::Extent3d {
                            width: self.size,
                            height: y1 - y0,
                            depth_or_array_layers: 1,
                        },
                    );
                }
            }
            self.dirty = false;
            self.dirty_min_y = u32::MAX;
            self.dirty_max_y = 0;
        }
        self.bind.clone()
    }
}

fn text_bind_group(
    gpu: &Gpu,
    layout: &wgpu::BindGroupLayout,
    view: &wgpu::TextureView,
    sampler: &wgpu::Sampler,
) -> wgpu::BindGroup {
    gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("glyph-atlas"),
        layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::Sampler(sampler),
            },
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIXED: [&str; 7] = [
        "最大加速度",
        "設定",
        "5⁻ 6⁺",
        "𝖬 6.4",
        "震度 ㎞",
        "（開關）｜",
        "EEW 📨",
    ];

    fn style(weight: u16) -> TextStyle {
        TextStyle {
            size: 16.0,
            weight,
            ..TextStyle::default()
        }
    }

    /// Each glyph by face name, id and position, so two engines can be compared.
    fn fingerprint(engine: &TextEngine, layout: &TextLayout) -> Vec<(String, u16, u32, u32)> {
        layout
            .lines
            .iter()
            .flat_map(|line| &line.glyphs)
            .map(|glyph| {
                let face = engine.fonts.db().face(glyph.font_id);
                (
                    face.map(|face| face.post_script_name.clone())
                        .unwrap_or_default(),
                    glyph.glyph_id,
                    glyph.x.to_bits(),
                    glyph.w.to_bits(),
                )
            })
            .collect()
    }

    #[test]
    fn the_pool_rasterizes_like_cosmic_text() {
        let mut engine = TextEngine::new();
        let mut keys = Vec::new();
        for weight in [400, 700] {
            for text in MIXED {
                let layout = engine.layout_single(text, &style(weight));
                for glyph in layout.lines.iter().flat_map(|line| &line.glyphs) {
                    for (x, flags) in [
                        (0.0, CacheKeyFlags::empty()),
                        (0.4, CacheKeyFlags::empty()),
                        (0.0, CacheKeyFlags::FAKE_ITALIC),
                    ] {
                        let (key, _, _) = CacheKey::new(
                            glyph.font_id,
                            glyph.glyph_id,
                            glyph.font_size,
                            (x, 0.0),
                            Weight(glyph.weight),
                            flags,
                        );
                        keys.push(key);
                    }
                }
            }
        }
        assert!(keys.len() > 100);
        let ours = engine.rasterize(&keys);
        let mut theirs = cosmic_text::SwashCache::new();
        for key in &keys {
            let expected = theirs.get_image_uncached(&mut engine.fonts, *key);
            let got = ours.get(key);
            assert_eq!(expected.is_some(), got.is_some(), "{key:?}");
            if let (Some(expected), Some(got)) = (expected, got) {
                assert_eq!(expected.data, got.data, "{key:?}");
                let place = |p: &swash::zeno::Placement| (p.left, p.top, p.width, p.height);
                assert_eq!(place(&expected.placement), place(&got.placement), "{key:?}");
                assert_eq!(expected.content, got.content, "{key:?}");
            }
        }
    }

    /// The faces scanned and mapped on their own thread shape as `load_system_fonts` run in
    /// place would: the same faces, in the same order, picked for the same glyphs.
    #[test]
    fn prefetched_system_fonts_shape_like_loading_them_in_place() {
        let mut prefetched = TextEngine::new();
        let db = prefetched.fonts.db_mut();
        for face in system_faces() {
            db.push_face_info(face.clone());
        }
        let mut in_place = TextEngine::new();
        in_place.fonts.db_mut().load_system_fonts();
        for engine in [&mut prefetched, &mut in_place] {
            engine.font_cursor = SYSTEM_FONTS.len();
            engine.scanned_system = true;
        }
        for weight in [400, 500, 700] {
            for text in MIXED {
                let a = prefetched.layout_single(text, &style(weight));
                let b = in_place.layout_single(text, &style(weight));
                assert!(!a.lines.is_empty(), "{text}");
                assert_eq!(
                    fingerprint(&prefetched, &a),
                    fingerprint(&in_place, &b),
                    "{text} at {weight}"
                );
            }
        }
        // Not a vacuous match: 加 and 𝖬 come from the system, not the embedded subset.
        let embedded = |name: &str| name.starts_with("Manrope") || name.starts_with("NotoSansTC");
        for text in ["加", "𝖬"] {
            let layout = prefetched.layout_single(text, &style(400));
            let faces = fingerprint(&prefetched, &layout);
            assert!(
                faces
                    .iter()
                    .any(|(face, id, _, _)| !embedded(face) && *id != 0),
                "{text}: {faces:?}"
            );
        }
    }

    #[test]
    fn ellipsis_prefix_cases() {
        assert_eq!(
            ellipsis_prefix(&[10.0, 20.0], &[true, true], 5.0, 20.0),
            None
        );
        assert_eq!(
            ellipsis_prefix(&[10.0, 20.0, 30.0], &[false, true, true], 5.0, 26.0),
            Some(2)
        );
        assert_eq!(ellipsis_prefix(&[10.0], &[true], 5.0, 4.0), Some(0));
    }

    #[test]
    fn embedded_fonts_shape_weight_tabular_and_cache() {
        let mut engine = TextEngine::new();
        let style = TextStyle {
            size: 16.0,
            weight: 400,
            ..TextStyle::default()
        };
        let mut heavy = style.clone();
        heavy.weight = 700;
        let light = engine.measure("W", &style);
        let bold = engine.measure("W", &heavy);
        assert!(
            (light - bold).abs() > 0.05,
            "weight 400 ({light}) and 700 ({bold}) should differ"
        );

        let mixed = engine.layout_single("A花", &style);
        let glyphs = &mixed.lines[0].glyphs;
        assert!(
            glyphs.len() >= 2,
            "expected two glyphs, got {}",
            glyphs.len()
        );
        assert!(
            engine.manrope_ids.contains(&glyphs[0].font_id),
            "Latin should come from Manrope"
        );
        assert!(
            engine.noto_ids.contains(&glyphs[1].font_id),
            "花 should come from Noto Sans TC"
        );

        let mut tabular = style.clone();
        tabular.tabular = true;
        let ones = engine.measure("1111", &tabular);
        let eights = engine.measure("8888", &tabular);
        assert!(
            (ones - eights).abs() < 0.05,
            "tabular 1111 ({ones}) and 8888 ({eights})"
        );

        let mut spaced = style.clone();
        spaced.letter_spacing = 2.0;
        let plain = engine.measure("AA", &style);
        let tracked = engine.measure("AA", &spaced);
        assert!(tracked > plain + 1.0, "letter-spacing {plain} -> {tracked}");

        let long = "WWWWWWWWWWWWWWWWWWWW";
        let full = engine.measure(long, &style);
        let cut = engine.layout_truncate(long, 40.0, &style);
        assert!(cut.truncated);
        assert!(cut.width <= 40.5, "truncated width {}", cut.width);
        assert!(cut.width < full);
        let short = engine.layout_truncate("A", 200.0, &style);
        assert!(!short.truncated);

        let again = engine.layout_single("A", &style);
        let cached = engine.layout_single("A", &style);
        assert!(Arc::ptr_eq(&again, &cached));
        let mut moved = style.clone();
        moved.h_align = HAlign::Right;
        let same = engine.layout_single("A", &moved);
        assert!(Arc::ptr_eq(&again, &same));
    }
}
