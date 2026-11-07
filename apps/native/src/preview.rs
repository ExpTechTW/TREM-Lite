//! Offscreen drawing, for looking at the app without its windows: the states of preview.tsx
//! with the same mock data and fixed time, and a live run against fixture data.

use std::path::Path;
use std::rc::Rc;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use trem_io::net::ProxyState;

use crate::app::{App, Msg, Post};
use crate::domain::types::ReportListItem;
use crate::map::MapEngine;
use crate::platform::speech::Speech;
use crate::render::{capture, Gpu, OFFSCREEN_FORMAT};
use crate::ui::icons::IconCache;
use crate::ui::main_view::MainView;
use crate::ui::settings::SettingsView;
use crate::ui::{clear_color, Ui};
use crate::variable::{CurrentStation, EewDisplay, EewStatus, TriggerDisplay, TriggerLocation};
use crate::Args;

/// 2026-08-28 07:26:30 +08:00.
const PREVIEW_NOW: f64 = 1_787_873_190_000.0;
/// 2026-08-28 07:25:29 +08:00.
const PREVIEW_EEW_TIME: f64 = 1_787_873_129_000.0;

pub fn screenshot(
    rt: &tokio::runtime::Runtime,
    args: &Args,
    path: &Path,
) -> Result<(u32, u32), String> {
    let gpu = Gpu::new().ok_or("沒有可用的 GPU")?;
    match args.page.as_str() {
        "map" => map_shot(rt, &gpu, args, path),
        "main" => {
            let (mut app, _rx) = preview_app(rt, args)?;
            let mut ui = Ui::new(
                &gpu,
                OFFSCREEN_FORMAT,
                (args.width, args.height),
                args.scale,
                &crate::render::FONTS,
            )?;
            let mut icons = IconCache::default();
            let mut view = MainView::new(args.width);
            apply_preview(&mut app, &args.preview);
            let mut actions = Vec::new();
            play_input(&mut ui, args, |ui| {
                view.draw(ui, &gpu, &mut icons, &mut app, &mut actions);
            });
            log_actions(&actions);
            capture(
                &gpu,
                args.width,
                args.height,
                args.scale,
                path,
                |target, encoder| {
                    let mut actions = Vec::new();
                    ui.begin();
                    hover_last(&mut ui, args);
                    view.draw(&mut ui, &gpu, &mut icons, &mut app, &mut actions);
                    ui.end();
                    ui.render(&gpu, target, encoder, Some(clear_color()));
                },
            )
        }
        "pip" => {
            let (mut app, _rx) = preview_app(rt, args)?;
            let mut ui = Ui::new(
                &gpu,
                OFFSCREEN_FORMAT,
                (276.0, 147.0),
                args.scale,
                &crate::render::FONTS,
            )?;
            let mut icons = IconCache::default();
            apply_preview(&mut app, &args.preview);
            capture(&gpu, 276.0, 147.0, args.scale, path, |target, encoder| {
                ui.begin();
                crate::ui::pip::draw(
                    &mut ui,
                    &gpu,
                    &mut icons,
                    app.ui.current_eew.as_ref(),
                    app.ui.current_trigger.as_ref(),
                );
                ui.end();
                ui.render(&gpu, target, encoder, Some(clear_color()));
            })
        }
        "settings" => {
            let (mut app, _rx) = preview_app(rt, args)?;
            let mut ui = Ui::new(
                &gpu,
                OFFSCREEN_FORMAT,
                (970.0, 590.0),
                args.scale,
                &crate::render::FONTS,
            )?;
            let mut icons = IconCache::default();
            // With fixture data, the station list is there to pick from.
            if let Some(text) =
                trem_io::net::fixture::read("https://static.core.exptech.dev/resource/station")
                    .ok()
                    .map(|f| String::from_utf8_lossy(&f.body).into_owned())
            {
                let list = crate::domain::types::parse_station_csv(&text);
                if !list.is_empty() {
                    app.var.station = Some(Arc::new(list));
                }
            }
            let mut view = SettingsView::new(&app);
            view.select_tab_named(&args.settings_tab);
            play_input(&mut ui, args, |ui| {
                view.draw(ui, &gpu, &mut icons, &mut app);
            });
            capture(&gpu, 970.0, 590.0, args.scale, path, |target, encoder| {
                ui.begin();
                hover_last(&mut ui, args);
                view.draw(&mut ui, &gpu, &mut icons, &mut app);
                ui.end();
                ui.render(&gpu, target, encoder, Some(clear_color()));
            })
        }
        "run" => run_shot(rt, &gpu, args, path),
        other => Err(format!("不認識的頁面：{other}")),
    }
}

/// The frames a person's input would make: move over a point, press, release. Each `--click`
/// and `--wheel` is replayed in order, so a page can be looked at after being used.
fn play_input(ui: &mut Ui, args: &Args, mut draw: impl FnMut(&mut Ui)) {
    let mut frame =
        |ui: &mut Ui, x: f32, y: f32, down: bool, pressed: bool, released: bool, wheel: f32| {
            ui.begin();
            ui.set_pointer(x, y);
            ui.set_buttons(down, pressed, released);
            ui.add_wheel(wheel);
            draw(ui);
            ui.end();
        };
    frame(ui, -1.0e6, -1.0e6, false, false, false, 0.0);
    for step in &args.input {
        match *step {
            crate::InputStep::Click(x, y) => {
                frame(ui, x, y, false, false, false, 0.0);
                frame(ui, x, y, true, true, false, 0.0);
                frame(ui, x, y, false, false, true, 0.0);
                frame(ui, x, y, false, false, false, 0.0);
            }
            crate::InputStep::Hover(x, y) => {
                frame(ui, x, y, false, false, false, 0.0);
                frame(ui, x, y, false, false, false, 0.0);
            }
            crate::InputStep::Wheel(x, y, dy) => {
                frame(ui, x, y, false, false, false, 0.0);
                frame(ui, x, y, false, false, false, dy);
            }
        }
    }
}

/// The last frame keeps the pointer where the input left it.
fn hover_last(ui: &mut Ui, args: &Args) {
    if let Some(step) = args.input.last() {
        let (x, y) = match *step {
            crate::InputStep::Click(x, y)
            | crate::InputStep::Hover(x, y)
            | crate::InputStep::Wheel(x, y, _) => (x, y),
        };
        ui.set_pointer(x, y);
    }
}

fn log_actions(actions: &[crate::ui::main_view::Action]) {
    use crate::ui::main_view::Action;
    for action in actions {
        let what = match action {
            Action::OpenSettings => "開設定".to_string(),
            Action::FocusReset => "定位".to_string(),
            Action::RestartForUpdate => "重啟更新".to_string(),
            Action::OpenReport(r) => format!("開報告 {}", r.id),
            Action::Replay(r) => format!("重播 {}", r.id),
        };
        log::info!("點擊結果：{what}");
    }
}

fn new_proxy() -> Result<Arc<ProxyState>, String> {
    let dir = std::env::temp_dir().join("trem-native-shot");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(Arc::new(ProxyState::new(&dir, crate::net::proxy_config())?))
}

/// The app with its state, its timers not started.
fn preview_app(
    rt: &tokio::runtime::Runtime,
    args: &Args,
) -> Result<(App, mpsc::Receiver<Msg>), String> {
    let (tx, rx) = mpsc::channel();
    let tx = std::sync::Mutex::new(tx);
    let post: Post = Arc::new(move |msg| {
        if let Ok(tx) = tx.lock() {
            let _ = tx.send(msg);
        }
    });
    let net = new_proxy()?;
    let wake_post = post.clone();
    let map = MapEngine::new(
        crate::map::tile_fetch(rt.handle().clone(), Arc::clone(&net)),
        Arc::new(move || wake_post(Msg::Wake)),
        (f64::from(args.width), f64::from(args.height)),
    );
    let speech = Speech::disabled(post.clone());
    let host = crate::host::Host::live(rt.handle().clone(), post, net);
    let app = App::new(host, crate::backend::config::load(), map, speech);
    Ok((app, rx))
}

fn mock_report(
    id: &str,
    depth: f64,
    loc: &str,
    mag: f64,
    ago: f64,
    int: i32,
) -> Rc<ReportListItem> {
    Rc::new(ReportListItem {
        id: id.to_string(),
        depth,
        loc: loc.to_string(),
        mag,
        time: PREVIEW_NOW - ago,
        int,
        ..Default::default()
    })
}

/// preview.tsx's mock state.
pub(crate) fn apply_preview(app: &mut App, state: &str) {
    let real = chrono::Utc::now().timestamp_millis() as f64;
    app.var.cache.time_offset = PREVIEW_NOW - real;
    app.ui.max_intensity = (0, "0級".to_string());
    app.ui.max_pga = 3.98;
    app.ui.current_station = Some(CurrentStation {
        loc: "臺南市歸仁區".to_string(),
        i: 0,
        raw_i: -3.0,
        pga: 0.49,
    });
    let row = |i, name: &str| TriggerLocation {
        i,
        name: name.to_string(),
    };
    match state {
        "trigger" => {
            app.ui.current_trigger = Some(TriggerDisplay {
                max: 4,
                locations: vec![
                    row(4, "花蓮縣秀林鄉"),
                    row(4, "花蓮縣壽豐鄉"),
                    row(3, "宜蘭縣南澳鄉"),
                    row(3, "臺東縣海端鄉"),
                ],
            });
        }
        "eew" | "cancel" => {
            app.ui.current_eew = Some(EewDisplay {
                id: "preview-eew".to_string(),
                status: if state == "cancel" {
                    EewStatus::Cancel
                } else {
                    EewStatus::Alert
                },
                serial: 3,
                is_final: false,
                unit_text: "CWA".to_string(),
                loc: "花蓮縣近海".to_string(),
                depth: 18.0,
                mag: 5.8,
                max: 6,
                time: PREVIEW_EEW_TIME,
            });
        }
        "rts" => {
            app.ui.rts_intensity_rows = vec![row(4, "花蓮縣"), row(3, "宜蘭縣"), row(2, "臺東縣")];
        }
        "warnings" => {
            app.ui.internet_error = true;
            app.ui.unstable = true;
        }
        "survey" => {
            app.var.cache.intensity_time = PREVIEW_NOW - 90_000.0;
            app.var.cache.intensity_max = 5;
        }
        _ => {}
    }
    app.var.data.report = vec![
        mock_report(
            "115000-2026-0702-114500",
            14.1,
            "花蓮縣秀林鄉",
            3.5,
            3_600_000.0,
            2,
        ),
        mock_report(
            "115049-2026-0702-090100",
            20.0,
            "臺灣南部海域",
            4.0,
            8_000_000.0,
            2,
        ),
        mock_report(
            "115000-2026-0702-070600",
            10.0,
            "花蓮縣豐濱鄉",
            4.0,
            12_000_000.0,
            4,
        ),
        mock_report(
            "115000-2026-0702-003100",
            30.0,
            "臺灣東部海域",
            4.3,
            20_000_000.0,
            2,
        ),
        mock_report(
            "115000-2026-0630-051500",
            40.0,
            "臺灣東部海域",
            5.0,
            90_000_000.0,
            2,
        ),
        mock_report(
            "115000-2026-0629-092000",
            12.0,
            "花蓮縣秀林鄉",
            3.6,
            100_000_000.0,
            2,
        ),
        mock_report(
            "115000-2026-0625-053000",
            8.0,
            "嘉義縣中埔鄉",
            3.1,
            140_000_000.0,
            2,
        ),
        mock_report(
            "115000-2026-0621-103700",
            15.0,
            "嘉義市西區",
            3.5,
            180_000_000.0,
            3,
        ),
    ];
}

fn map_shot(
    rt: &tokio::runtime::Runtime,
    gpu: &Gpu,
    args: &Args,
    path: &Path,
) -> Result<(u32, u32), String> {
    let net = new_proxy()?;
    let mut engine = MapEngine::new(
        crate::map::tile_fetch(rt.handle().clone(), net),
        Arc::new(|| {}),
        (f64::from(args.width), f64::from(args.height)),
    );
    match args.camera {
        Some((lon, lat, zoom)) => engine
            .camera
            .jump(crate::map::camera::Target { lon, lat, zoom }),
        None => {
            let [[west, south], [east, north]] = crate::domain::constants::MAP_BOUNDS;
            engine.fit_bounds(
                crate::map::camera::Bounds {
                    west,
                    south,
                    east,
                    north,
                },
                crate::map::camera::Padding::all(crate::domain::constants::MAP_PADDING),
                f64::INFINITY,
                0.0,
            );
        }
    }
    let started = Instant::now();
    loop {
        engine.prepare(gpu, OFFSCREEN_FORMAT)?;
        if engine.settled() || started.elapsed().as_secs() > 30 {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    engine.prepare(gpu, OFFSCREEN_FORMAT)?;
    log::info!("地圖 GPU 用量：{:?}", engine.tiles.gpu_bytes());
    capture(
        gpu,
        args.width,
        args.height,
        args.scale,
        path,
        |view, encoder| {
            engine.encode(gpu, view, encoder, f64::from(args.scale));
        },
    )
}

/// The real app, running on the fixture data for `--after` seconds, then one frame of
/// everything. With `--replay`, a report's replay, which is what exercises the alerts.
fn run_shot(
    rt: &tokio::runtime::Runtime,
    gpu: &Gpu,
    args: &Args,
    path: &Path,
) -> Result<(u32, u32), String> {
    let (mut app, rx) = preview_app(rt, args)?;
    let mut ui = Ui::new(
        gpu,
        OFFSCREEN_FORMAT,
        (args.width, args.height),
        args.scale,
        &crate::render::FONTS,
    )?;
    let mut icons = IconCache::default();
    let mut view = MainView::new(args.width);
    // The predicted towns need the model: from disk, never fetched in a test.
    if let Some(dir) = crate::paths::PATHS
        .local_data_dir()
        .map(|d| d.join("models"))
    {
        if dir.is_dir() {
            if let Some(net) = &app.host.net {
                rt.spawn(crate::backend::ml_intensity::prepare(dir, net.client()));
            }
        }
    }
    app.start(true);
    app.window.main_shown = true;
    let started = Instant::now();
    let mut replay_started = false;
    loop {
        while let Ok(msg) = rx.try_recv() {
            app.on_msg(msg);
        }
        let now = Instant::now();
        while let Some((_, task)) = app.timers.pop_due(now) {
            app.run_task(task);
        }
        app.commands.clear();
        if !replay_started && !app.var.data.report.is_empty() {
            if let Some(id) = &args.replay {
                let item = app.var.data.report.iter().find(|r| r.id == *id).cloned();
                if let Some(item) = item {
                    app.replay_report(&item);
                    replay_started = true;
                }
            }
        }
        app.map.prepare(gpu, OFFSCREEN_FORMAT)?;
        if started.elapsed().as_secs_f64() >= args.after {
            break;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
    // Settle the camera and let any last tile in.
    for _ in 0..50 {
        app.map.prepare(gpu, OFFSCREEN_FORMAT)?;
        if app.map.settled() && !app.map.is_moving() {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    app.map.prepare(gpu, OFFSCREEN_FORMAT)?;
    capture(
        gpu,
        args.width,
        args.height,
        args.scale,
        path,
        |target, encoder| {
            app.map.encode(gpu, target, encoder, f64::from(args.scale));
            let mut actions = Vec::new();
            ui.begin();
            view.draw(&mut ui, gpu, &mut icons, &mut app, &mut actions);
            ui.end();
            ui.render(gpu, target, encoder, None);
        },
    )
}
