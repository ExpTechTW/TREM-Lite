//! Running the whole app in a test: virtual time, a recorded network, effects recorded.
//! The features run unchanged; only what crosses the app's edge is swapped (crate::host).

#[cfg(test)]
mod bench;
mod pins;
mod render;
mod scenarios;
mod spec;

use std::collections::HashMap;
use std::fmt::Write as _;
use std::io::Read;
use std::rc::Rc;
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use trem_io::net::{Fetched, ProxyRequest};

use crate::app::{App, Msg, Post};
use crate::backend::config::{self, Config};
use crate::events::Event;
use crate::features::window::WindowCommand;
use crate::host::{Host, Output};
use crate::map::MapEngine;
use crate::platform::speech::Speech;

/// The recorded earthquake's answers, by URL.
pub fn quake_answers() -> &'static HashMap<String, String> {
    static ANSWERS: OnceLock<HashMap<String, String>> = OnceLock::new();
    ANSWERS.get_or_init(|| {
        let gz = include_bytes!("../../testdata/quake/answers.json.gz");
        let mut text = String::new();
        flate2::read::GzDecoder::new(&gz[..])
            .read_to_string(&mut text)
            .expect("testdata/quake/answers.json.gz is gzip");
        serde_json::from_str(&text).expect("testdata/quake/answers.json.gz is a JSON map")
    })
}

/// No answers at all.
pub fn spec_answers() -> &'static HashMap<String, String> {
    static EMPTY: OnceLock<HashMap<String, String>> = OnceLock::new();
    EMPTY.get_or_init(HashMap::new)
}

/// 2026-08-25 15:00:11 +08:00, the recorded earthquake's origin.
pub const QUAKE_ORIGIN_MS: f64 = 1_787_641_211_000.0;
pub const QUAKE_REPORT: &str = "115057-2026-0825-150011";

fn answer(status: u16, body: &str) -> Fetched {
    Fetched {
        status,
        body: Arc::new(body.as_bytes().to_vec()),
        from_cache: false,
        stale: false,
        via: "test",
    }
}

/// The recording holds intensity.v1 every 5 s; the archive answers every second with the
/// reports in force then, which is the last recorded second's answer. Past the recording
/// the archives still answer, with nothing in force: an empty list.
fn lookup(answers: &HashMap<String, String>, url: &str) -> Option<String> {
    if let Some(body) = answers.get(url) {
        return Some(body.clone());
    }
    let (base, second) = url.rsplit_once('/')?;
    let second: u64 = second.parse().ok()?;
    let in_force = base.ends_with("/api/v3/trem/intensity");
    if in_force {
        let earlier =
            (1..5).find_map(|back| answers.get(&format!("{base}/{}", second.checked_sub(back)?)));
        if let Some(body) = earlier {
            return Some(body.clone());
        }
    }
    let after_recording = second > (QUAKE_ORIGIN_MS / 1000.0) as u64 + 180;
    (after_recording && (in_force || base.ends_with("/api/v2/eq/eew"))).then(|| "[]".to_string())
}

pub struct Harness {
    pub app: App,
    rx: mpsc::Receiver<Msg>,
    _rt: tokio::runtime::Runtime,
    start: Instant,
    start_wall: f64,
    elapsed: Duration,
    /// Every request the app made, in order.
    pub requests: Arc<Mutex<Vec<String>>>,
    /// What is read in order: events, effects, window commands.
    pub log: Vec<String>,
    /// Whether [`Self::log`] takes them; off, they stay on the app for a test to read.
    pub logging: bool,
}

impl Harness {
    /// The app at `wall_ms`, answered from `answers`, its timers not yet started.
    pub fn new(wall_ms: f64, answers: &'static HashMap<String, String>, config: Config) -> Self {
        // The predicted towns need the model; a test reads the repository's copy.
        crate::backend::ml_intensity::load_for_tests();
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("a runtime");
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let post: Post = Arc::new(move |msg| {
            if let Ok(tx) = tx.lock() {
                let _ = tx.send(msg);
            }
        });
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&requests);
        let fake = Arc::new(move |req: &ProxyRequest| {
            if let Ok(mut seen) = seen.lock() {
                seen.push(req.url.clone());
            }
            Ok(match lookup(answers, &req.url) {
                Some(body) => answer(200, &body),
                None => answer(404, ""),
            })
        });
        let host = Host::test(rt.handle().clone(), post.clone(), fake);
        let map = MapEngine::new(Arc::new(|_, _| {}), Arc::new(|| {}), (1280.0, 815.0));
        let speech = Speech::disabled(post);
        let mut app = App::new(host, config, map, speech);
        let start = Instant::now();
        app.var.wall_override = Some(wall_ms);
        app.timers.virtual_now = Some(start);
        app.map.set_clock(0.0);
        Self {
            app,
            rx,
            _rt: rt,
            start,
            start_wall: wall_ms,
            elapsed: Duration::ZERO,
            requests,
            log: Vec::new(),
            logging: true,
        }
    }

    pub fn default_config() -> Config {
        config::defaults()
    }

    /// Seconds since the harness began.
    /// Deliver what the app posted to itself, and record what came of it.
    pub fn settle(&mut self) {
        while let Ok(msg) = self.rx.try_recv() {
            self.app.on_msg(msg);
        }
        self.collect();
    }

    fn collect(&mut self) {
        if !self.logging {
            return;
        }
        let at = self.elapsed.as_secs_f64();
        for ev in std::mem::take(&mut self.app.trace) {
            if matches!(ev, Event::EewDisplayUpdate) {
                continue;
            }
            let line = describe(&ev);
            self.log.push(format!("{at:7.1} {line}"));
        }
        for out in std::mem::take(&mut self.app.host.outputs) {
            self.log
                .push(format!("{at:7.1}   > {}", describe_output(&out)));
        }
        for command in std::mem::take(&mut self.app.commands) {
            self.log.push(format!("{at:7.1}   # {command:?}"));
            // The windows answer as the event loop would.
            match command {
                WindowCommand::FocusMain { .. } => self.app.window.main_shown = true,
                WindowCommand::HidePip => self.app.window.pip_shown = false,
                _ => {}
            }
        }
    }

    /// Start the modules, as the event loop does once the window exists.
    pub fn start(&mut self, main_shown: bool) {
        self.app.window.main_shown = main_shown;
        self.app.start(main_shown);
        self.settle();
    }

    /// Move time on by `ms`, firing every timer that falls due, in order.
    pub fn advance(&mut self, ms: u64) {
        let end = self.elapsed + Duration::from_millis(ms);
        loop {
            let next = self
                .app
                .timers
                .next_deadline()
                .map(|due| due.duration_since(self.start));
            let step = match next {
                Some(due) if due <= end => due.max(self.elapsed),
                _ => end,
            };
            self.set_time(step);
            let now = self.start + step;
            let mut fired = false;
            while let Some((_, task)) = self.app.timers.pop_due(now) {
                fired = true;
                self.app.run_task(task);
                self.settle();
            }
            self.settle();
            if step >= end && !fired {
                break;
            }
            if step >= end {
                // Timers that fired may have set others due right now.
                if self.app.timers.next_deadline().is_none_or(|due| due > now) {
                    break;
                }
            }
        }
    }

    fn set_time(&mut self, elapsed: Duration) {
        self.elapsed = elapsed;
        self.app.timers.virtual_now = Some(self.start + elapsed);
        self.app.var.wall_override = Some(self.start_wall + elapsed.as_secs_f64() * 1000.0);
        self.app.map.set_clock(elapsed.as_secs_f64() * 1000.0);
    }

    /// One line of what the app holds now.
    pub fn snapshot(&mut self) -> String {
        let app = &mut self.app;
        let mut s = String::new();
        let eews: Vec<String> = app
            .var
            .data
            .eew
            .iter()
            .map(|e| format!("{}#{}/{}", e.id, e.serial, e.status))
            .collect();
        let (lon, lat) = app.map.camera.center();
        let scene = &app.map.scene;
        let _ = write!(
            s,
            "mode={} eew=[{}] alert={} boxes={} eqwaves={} cross={} waves={} towns={} imarks={} lmarks={} rmarks={}+{} dots={}/{}/{} op={}",
            app.var.play_mode,
            eews.join(","),
            app.var.cache.rts_alert,
            scene.boxes.len(),
            scene.eq_waves.len(),
            scene.cross.len(),
            scene.waves.len(),
            scene.towns.len(),
            scene.intensity_markers.len(),
            scene.lpgm_markers.len(),
            scene.report_markers.len(),
            scene.report_cross.len(),
            scene.rts_dots.len(),
            scene.zero_dots.len(),
            scene.markers.len(),
            scene.rts_opacity,
        );
        let _ = write!(
            s,
            " | max={} pga={:.2}/{} lvl={} trig={} rows={} unstable={} net={} lock={} cam={:.3},{:.3},{:.2}",
            app.ui.max_intensity.0,
            app.ui.max_pga,
            app.ui.max_pga_intensity,
            app.ui.rts_level,
            app.ui.rts_trigger,
            app.ui
                .rts_intensity_rows
                .iter()
                .map(|r| format!("{}{}", r.name, r.i))
                .collect::<Vec<_>>()
                .join("/"),
            app.ui.unstable,
            app.ui.internet_error,
            app.focus.lock,
            lon,
            lat,
            app.map.camera.zoom,
        );
        if let Some(eew) = &app.ui.current_eew {
            let _ = write!(
                s,
                " | card={:?} {} {} M{} max{}",
                eew.status, eew.unit_text, eew.loc, eew.mag, eew.max
            );
        } else if let Some(t) = &app.ui.current_trigger {
            let names: Vec<&str> = t.locations.iter().map(|l| l.name.as_str()).collect();
            let _ = write!(s, " | trigger={} {}", t.max, names.join("/"));
        }
        s
    }

    pub fn note(&mut self, text: &str) {
        let at = self.elapsed.as_secs_f64();
        self.log.push(format!("{at:7.1} = {text}"));
    }
}

fn describe(ev: &Event) -> String {
    let eew = |e: &crate::domain::types::EewData| {
        format!(
            "{}#{} status={} max={} M{} {}",
            e.id, e.serial, e.status, e.eq.max, e.eq.mag, e.eq.loc
        )
    };
    match ev {
        Event::DataRts(Some(rts)) => format!(
            "DataRts t={} stations={} boxes={} int={}",
            rts.time,
            rts.station.len(),
            rts.boxes.len(),
            rts.int.len()
        ),
        Event::DataRts(None) => "DataRts none".to_string(),
        Event::EewRelease(e) => format!("EewRelease {}", eew(e)),
        Event::EewUpdate(e) => format!("EewUpdate {}", eew(e)),
        Event::EewEnd(e) => format!("EewEnd {}", eew(e)),
        Event::EewAlert(e) => format!("EewAlert {}", eew(e)),
        Event::EewCancel(e) => format!("EewCancel {}", eew(e)),
        Event::EewNewAreaAlert(c) => format!("EewNewAreaAlert {}", c.join("、")),
        Event::IntensityRelease(d) | Event::IntensityUpdate(d) | Event::IntensityEnd(d) => {
            let towns: usize = d.area.iter().map(|(_, c)| c.len()).sum();
            format!(
                "{} {} serial={} max={} towns={towns}",
                ev.name(),
                d.id,
                d.serial,
                d.max
            )
        }
        Event::LpgmRelease(d) => format!("LpgmRelease {} stations={}", d.id, d.list.len()),
        Event::ReportRelease { data, update } => {
            format!("ReportRelease {} update={update} int={}", data.id, data.int)
        }
        Event::ReportSpeechEnd(id) => format!("ReportSpeechEnd {id}"),
        Event::ReplayStateChange { active, report_id } => {
            format!("ReplayStateChange active={active} report={report_id:?}")
        }
        Event::FocusLockChange(v) | Event::InternetErrorChange(v) | Event::MainWindowHidden(v) => {
            format!("{} {v}", ev.name())
        }
        Event::UpdateReady(v) => format!("UpdateReady {v}"),
        other => other.name().to_string(),
    }
}

fn describe_output(out: &Output) -> String {
    match out {
        Output::Speak { text, queue } => format!("Speak queue={queue} {text}"),
        Output::Notify { title, body } => format!("Notify {title} | {}", body.replace('\n', " / ")),
        other => format!("{other:?}"),
    }
}

/// Compare with `testdata/golden/<name>.txt`; `UPDATE_GOLDEN=1` writes it instead.
pub fn check_golden(name: &str, actual: &str) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("testdata/golden")
        .join(format!("{name}.txt"));
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(path.parent().unwrap_or(std::path::Path::new(".")))
            .expect("the golden directory");
        std::fs::write(&path, actual).expect("the golden file");
        return;
    }
    let expected = std::fs::read_to_string(&path).unwrap_or_else(|_| {
        panic!(
            "no golden file {}: run with UPDATE_GOLDEN=1",
            path.display()
        )
    });
    if expected != actual {
        let first = expected
            .lines()
            .zip(actual.lines())
            .position(|(a, b)| a != b)
            .unwrap_or_else(|| expected.lines().count().min(actual.lines().count()));
        let near = |text: &str| {
            text.lines()
                .skip(first.saturating_sub(2))
                .take(6)
                .collect::<Vec<_>>()
                .join("\n")
        };
        panic!(
            "{name} differs from its golden file at line {}:\n--- expected\n{}\n--- actual\n{}",
            first + 1,
            near(&expected),
            near(actual)
        );
    }
}

/// The report the recorded earthquake's replay starts from.
pub fn quake_report(app: &App) -> Rc<crate::domain::types::ReportListItem> {
    app.var
        .data
        .report
        .iter()
        .find(|r| r.id == QUAKE_REPORT)
        .cloned()
        .expect("the recorded report is in the list")
}
