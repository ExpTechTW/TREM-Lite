//! What the windows draw, pinned as pictures: the overlays in preview.tsx's states, PiP,
//! a settings page, and the map on real tiles. Compared with a small tolerance, since the
//! GPU may round a blend differently; needs a GPU, and fonts as macOS has them.

use std::sync::Arc;
use std::time::Duration;

use trem_gfx::testing::gpu;

use super::{Harness, QUAKE_ORIGIN_MS};
use crate::map::camera::Target;
use crate::map::MapEngine;
use crate::render::{render_rgba, Gpu, OFFSCREEN_FORMAT};
use crate::ui::icons::IconCache;
use crate::ui::main_view::MainView;
use crate::ui::settings::SettingsView;
use crate::ui::{clear_color, Ui};

/// Compare with `testdata/golden/render/<name>.png`; `UPDATE_GOLDEN=1` writes it instead.
/// A pixel counts as different past 16 in a channel; at most 0.1% may be.
fn check_picture(name: &str, width: u32, height: u32, rgba: Vec<u8>) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("testdata/golden/render")
        .join(format!("{name}.png"));
    trem_gfx::testing::check_picture(&path, width, height, rgba);
}

fn overlays(state: &str, width: f32, height: f32) {
    let Some(gpu) = gpu() else {
        return;
    };
    let mut h = Harness::new(
        QUAKE_ORIGIN_MS,
        super::spec_answers(),
        Harness::default_config(),
    );
    crate::preview::apply_preview(&mut h.app, state);
    let mut ui = Ui::new(
        &gpu,
        OFFSCREEN_FORMAT,
        (width, height),
        1.0,
        &crate::render::FONTS,
    )
    .expect("a UI");
    let mut icons = IconCache::default();
    let mut view = MainView::new(width);
    let rgba = render_rgba(&gpu, width as u32, height as u32, |target, encoder| {
        let mut actions = Vec::new();
        ui.begin();
        view.draw(&mut ui, &gpu, &mut icons, &mut h.app, &mut actions);
        ui.end();
        ui.render(&gpu, target, encoder, Some(clear_color()));
    })
    .expect("a frame");
    check_picture(
        &format!("main-{state}-{width}x{height}"),
        width as u32,
        height as u32,
        rgba,
    );
}

#[test]
fn overlays_in_an_eew() {
    overlays("eew", 1280.0, 815.0);
}

#[test]
fn overlays_with_warnings_narrow() {
    overlays("warnings", 960.0, 700.0);
}

#[test]
fn overlays_in_a_survey() {
    overlays("survey", 1280.0, 815.0);
}

#[test]
fn pip_in_a_trigger() {
    let Some(gpu) = gpu() else {
        return;
    };
    let mut h = Harness::new(
        QUAKE_ORIGIN_MS,
        super::spec_answers(),
        Harness::default_config(),
    );
    crate::preview::apply_preview(&mut h.app, "trigger");
    let mut ui = Ui::new(
        &gpu,
        OFFSCREEN_FORMAT,
        (276.0, 147.0),
        1.0,
        &crate::render::FONTS,
    )
    .expect("a UI");
    let mut icons = IconCache::default();
    let rgba = render_rgba(&gpu, 276, 147, |target, encoder| {
        ui.begin();
        crate::ui::pip::draw(
            &mut ui,
            &gpu,
            &mut icons,
            h.app.ui.current_eew.as_ref(),
            h.app.ui.current_trigger.as_ref(),
        );
        ui.end();
        ui.render(&gpu, target, encoder, Some(clear_color()));
    })
    .expect("a frame");
    check_picture("pip-trigger", 276, 147, rgba);
}

#[test]
fn the_sound_settings() {
    let Some(gpu) = gpu() else {
        return;
    };
    let mut h = Harness::new(
        QUAKE_ORIGIN_MS,
        super::spec_answers(),
        Harness::default_config(),
    );
    let mut ui = Ui::new(
        &gpu,
        OFFSCREEN_FORMAT,
        (970.0, 590.0),
        1.0,
        &crate::render::FONTS,
    )
    .expect("a UI");
    let mut icons = IconCache::default();
    let mut view = SettingsView::new(&h.app);
    view.select_tab_named("音效");
    let rgba = render_rgba(&gpu, 970, 590, |target, encoder| {
        ui.begin();
        view.draw(&mut ui, &gpu, &mut icons, &mut h.app);
        ui.end();
        ui.render(&gpu, target, encoder, Some(clear_color()));
    })
    .expect("a frame");
    check_picture("settings-sound", 970, 590, rgba);
}

/// Also the browser build's sprite: it embeds this picture rather than drawing its own.
#[test]
fn the_map_sprite() {
    let Some(gpu) = gpu() else {
        return;
    };
    let (w, h) = crate::map::icons::sprite_size();
    let pixels = crate::map::icons::sprite_pixels(&gpu).expect("the sprite draws");
    check_picture("map-sprite", w, h, pixels);
}

#[test]
fn the_map_on_real_tiles() {
    let Some(gpu) = gpu() else {
        return;
    };
    check_picture("map-z6", 480, 480, map_on_real_tiles(&gpu, false));
}

/// The runner makes the map's pipelines on another thread ahead of the first frame.
#[test]
fn a_map_pass_made_on_another_thread_draws_the_same() {
    let Some(gpu) = gpu() else {
        return;
    };
    check_picture("map-z6", 480, 480, map_on_real_tiles(&gpu, true));
}

fn map_on_real_tiles(gpu: &Gpu, prebuilt: bool) -> Vec<u8> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata");
    let fetch: crate::map::tiles::Fetch = Arc::new(move |url: String, reply| {
        // `.../tiles/6/53/27.pbf` or `.../terrain/6/53/27.png`, from testdata.
        let mut parts = url.rsplit('/');
        let file = parts.next().unwrap_or("");
        let x = parts.next().unwrap_or("");
        let z = parts.next().unwrap_or("");
        let kind = parts.next().unwrap_or("");
        let path = root.join(kind).join(z).join(x).join(file);
        let body = std::fs::read(path)
            .ok()
            .filter(|b| !b.is_empty())
            .map(Arc::new);
        reply(Ok(body));
    });
    let mut map = crate::map::engine(fetch, Arc::new(|| {}), (480.0, 480.0));
    if prebuilt {
        let pass = std::thread::scope(|scope| {
            scope
                .spawn(|| MapEngine::new_pass(gpu, OFFSCREEN_FORMAT))
                .join()
        });
        map.install_pass(pass.expect("no panic").expect("the pass is made"));
        assert!(!map.needs_pass(OFFSCREEN_FORMAT));
    }
    map.camera.jump(Target {
        lon: 121.0,
        lat: 23.6,
        zoom: 6.4,
    });
    for _ in 0..50 {
        map.prepare(gpu, OFFSCREEN_FORMAT)
            .expect("the map prepares");
        if map.settled() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    map.prepare(gpu, OFFSCREEN_FORMAT)
        .expect("the map prepares");
    render_rgba(gpu, 480, 480, |target, encoder| {
        map.encode(gpu, target, encoder, 1.0);
    })
    .expect("a frame")
}
