//! Where the time goes. Not run by default:
//! `cargo test --release bench -- --ignored --nocapture --test-threads=1`.

use std::hint::black_box;
use std::rc::Rc;
use std::time::Instant;

use super::{quake_answers, Harness, QUAKE_ORIGIN_MS};
use crate::domain::types::{parse_station_csv, RtsData, RtsStation, RtsV1};
use crate::map::{dem, mvt, tessellate};

fn time<T>(label: &str, runs: u32, mut f: impl FnMut() -> T) {
    // One warm-up run, then the median of the rest.
    black_box(f());
    let mut samples: Vec<f64> = (0..runs)
        .map(|_| {
            let start = Instant::now();
            black_box(f());
            start.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    samples.sort_by(f64::total_cmp);
    let median = samples[samples.len() / 2];
    let max = samples.last().copied().unwrap_or(0.0);
    println!("{label:44} median {median:9.3} ms   max {max:9.3} ms");
}

fn read(path: &str) -> Vec<u8> {
    std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).expect(path)
}

#[test]
#[ignore = "a measurement, not a check"]
fn bench_cpu_work() {
    let tile = read("testdata/tiles/6/53/27.pbf");
    time("mvt::decode 6/53/27", 20, || mvt::decode(&tile, "CODE"));
    time("tessellate 6/53/27 (decode + cut)", 20, || {
        tessellate::tessellate(&tile)
    });
    let png = read("testdata/terrain/6/53/27.png");
    time("terrain PNG decode", 20, || {
        image::load_from_memory_with_format(&png, image::ImageFormat::Png)
    });
    let rgb = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
        .expect("png")
        .into_rgb8();
    time("dem::bake 512²", 20, || {
        dem::bake(rgb.as_raw(), 512, 6, 27)
    });

    crate::backend::ml_intensity::load_for_tests();
    let mut n = 0.0;
    time("eew_area_intensity (368 towns)", 20, || {
        // A new solution each run: the last one is cached.
        n += 0.001;
        crate::backend::math::eew_area_intensity(22.8 + n, 121.3, 20.0, 5.9)
    });
    let onnx: &[u8] = include_bytes!("../../assets/models/intensity_ml_v1.onnx");
    time("ML model parse + compile", 3, || {
        crate::backend::ml_intensity::build_for_bench(onnx)
    });

    let answers = quake_answers();
    let csv = &answers["https://static.core.exptech.dev/resource/station"];
    time("station CSV parse", 20, || parse_station_csv(csv));
    let list = &answers["https://api.core.exptech.dev/api/v2/eq/report?limit=75"];
    time("report list parse (75)", 20, || {
        serde_json::from_str::<Vec<crate::domain::types::ReportListItem>>(list)
    });
    let frame = &answers["https://api.core.exptech.dev/api/v3/trem/rts/1787641260"];
    time("rts.v1 frame parse", 50, || {
        serde_json::from_str::<RtsV1>(frame)
    });
    time("region + boxes + time table", 1, || {
        (
            crate::domain::region::towns().len(),
            crate::domain::region::boxes().len(),
            crate::domain::utils::ps_wave_dist(10.0, 0.0, 10_000.0),
        )
    });
}

/// A frame of a thousand stations, a hundred of them alerting, through every handler.
#[test]
#[ignore = "a measurement, not a check"]
fn bench_main_thread_frame() {
    let mut h = Harness::new(
        QUAKE_ORIGIN_MS,
        super::spec_answers(),
        Harness::default_config(),
    );
    h.logging = false;
    let mut stations = std::collections::HashMap::new();
    let mut frame = Vec::new();
    for n in 0..1000u32 {
        let id = crate::domain::types::StationId::new(&format!("1{n:06X}")).expect("an id");
        let town = &crate::domain::region::towns()[(n as usize * 7) % 368];
        stations.insert(
            id,
            crate::domain::types::Station {
                code: town.code,
                lon: town.lon + f64::from(n % 10) * 0.001,
                lat: town.lat,
                work: Some(true),
            },
        );
        frame.push((
            id,
            RtsStation {
                pga: f64::from(n % 50) * 0.7,
                i: f64::from(n % 60) / 10.0 - 1.0,
                alert: n % 10 == 0,
            },
        ));
    }
    h.app.var.station = Some(std::sync::Arc::new(stations));
    let mut t = QUAKE_ORIGIN_MS;
    time("data_rts_frame, 1000 stations, 100 alerting", 200, || {
        t += 500.0;
        let rts = RtsData {
            station: frame.clone(),
            boxes: Vec::new(),
            int: Vec::new(),
            time: t,
            eq: Vec::new(),
        };
        h.app.data_rts_frame(rts);
        h.app.trace.clear();
        h.app.host.outputs.clear();
        h.app.commands.clear();
    });
    let quiet: Vec<_> = frame
        .iter()
        .map(|(id, s)| (*id, RtsStation { alert: false, ..*s }))
        .collect();
    time("data_rts_frame, 1000 stations, quiet", 200, || {
        t += 500.0;
        h.app.data_rts_frame(RtsData {
            station: quiet.clone(),
            boxes: Vec::new(),
            int: Vec::new(),
            time: t,
            eq: Vec::new(),
        });
        h.app.trace.clear();
    });
    let _ = Rc::new(());
}

/// The CPU side of a frame: what the UI records and the map prepares.
#[test]
#[ignore = "a measurement, not a check"]
fn bench_frame_cpu() {
    let Some(gpu) = crate::render::Gpu::new() else {
        return;
    };
    let started = Instant::now();
    let text = crate::render::TextEngine::new();
    println!(
        "{:44} {:9.3} ms",
        "TextEngine::new",
        started.elapsed().as_secs_f64() * 1000.0
    );
    drop(text);
    let mut h = Harness::new(
        QUAKE_ORIGIN_MS,
        super::spec_answers(),
        Harness::default_config(),
    );
    crate::preview::apply_preview(&mut h.app, "eew");
    let started = Instant::now();
    let mut ui = crate::ui::Ui::new(&gpu, crate::render::OFFSCREEN_FORMAT, (1280.0, 815.0), 2.0)
        .expect("a UI");
    println!(
        "{:44} {:9.3} ms",
        "Ui::new",
        started.elapsed().as_secs_f64() * 1000.0
    );
    let mut icons = crate::ui::icons::IconCache::default();
    let mut view = crate::ui::main_view::MainView::new(1280.0);
    let target = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d {
            width: 2560,
            height: 1630,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: crate::render::OFFSCREEN_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let view_tex = target.create_view(&wgpu::TextureViewDescriptor::default());
    let mut first = true;
    time("UI frame (record + encode), 2x", 50, || {
        let started = Instant::now();
        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        let mut actions = Vec::new();
        ui.begin();
        view.draw(&mut ui, &gpu, &mut icons, &mut h.app, &mut actions);
        ui.end();
        ui.render(
            &gpu,
            &view_tex,
            &mut encoder,
            Some(crate::ui::clear_color()),
        );
        gpu.queue.submit([encoder.finish()]);
        if first {
            first = false;
            println!(
                "{:44} {:9.3} ms",
                "first UI frame (glyphs rasterized)",
                started.elapsed().as_secs_f64() * 1000.0
            );
        }
    });
    let started = Instant::now();
    let pass = crate::render::map_pass::MapPass::new(&gpu, crate::render::OFFSCREEN_FORMAT);
    println!(
        "{:44} {:9.3} ms",
        "MapPass::new (pipelines + sprite)",
        started.elapsed().as_secs_f64() * 1000.0
    );
    drop(pass);
}
