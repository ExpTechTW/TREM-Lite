//! The lucide icons this app uses, drawn by trem_gfx's icon cache: rasterized when first
//! needed at the size they appear.

use trem_gfx::ui::icons::IconShape;

/// The icons, cached by kind and size.
pub type IconCache = trem_gfx::ui::icons::IconCache<Icon>;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Icon {
    Settings,
    Crosshair,
    ChevronLeft,
    ChevronRight,
    ChevronDown,
    X,
    Minus,
    Play,
    Copy,
    FolderOpen,
    ExternalLink,
    SlidersHorizontal,
    BellRing,
    Volume2,
    Info,
    WifiOff,
    TriangleAlert,
}

impl IconShape for Icon {
    fn paths(self) -> &'static [&'static str] {
        paths(self)
    }

    fn filled(self) -> bool {
        self == Icon::Play
    }
}

/// Each icon's shapes, as SVG path data.
fn paths(icon: Icon) -> &'static [&'static str] {
    match icon {
        Icon::Settings => &["M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915", "M9 12A3 3 0 1 1 15 12A3 3 0 1 1 9 12"],
        Icon::Crosshair => &["M2 12A10 10 0 1 1 22 12A10 10 0 1 1 2 12", "M22 12L18 12", "M6 12L2 12", "M12 6L12 2", "M12 22L12 18"],
        Icon::ChevronLeft => &["m15 18-6-6 6-6"],
        Icon::ChevronRight => &["m9 18 6-6-6-6"],
        Icon::ChevronDown => &["m6 9 6 6 6-6"],
        Icon::X => &["M18 6 6 18", "m6 6 12 12"],
        Icon::Minus => &["M5 12h14"],
        Icon::Play => &["M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"],
        Icon::Copy => &["M10 8H20A2 2 0 0 1 22 10V20A2 2 0 0 1 20 22H10A2 2 0 0 1 8 20V10A2 2 0 0 1 10 8Z", "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"],
        Icon::FolderOpen => &["m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"],
        Icon::ExternalLink => &["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
        Icon::SlidersHorizontal => &["M10 5H3", "M12 19H3", "M14 3v4", "M16 17v4", "M21 12h-9", "M21 19h-5", "M21 5h-7", "M8 10v4", "M8 12H3"],
        Icon::BellRing => &["M10.268 21a2 2 0 0 0 3.464 0", "M22 8c0-2.3-.8-4.3-2-6", "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326", "M4 2C2.8 3.7 2 5.7 2 8"],
        Icon::Volume2 => &["M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z", "M16 9a5 5 0 0 1 0 6", "M19.364 18.364a9 9 0 0 0 0-12.728"],
        Icon::Info => &["M2 12A10 10 0 1 1 22 12A10 10 0 1 1 2 12", "M12 16v-4", "M12 8h.01"],
        Icon::WifiOff => &["M12 20h.01", "M8.5 16.429a5 5 0 0 1 7 0", "M5 12.859a10 10 0 0 1 5.17-2.69", "M19 12.859a10 10 0 0 0-2.007-1.523", "M2 8.82a15 15 0 0 1 4.177-2.643", "M22 8.82a15 15 0 0 0-11.288-3.764", "m2 2 20 20"],
        Icon::TriangleAlert => &["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"],
    }
}
