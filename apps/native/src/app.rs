//! The app's state and its event bus. Everything runs on the main thread, as it did in the
//! webview: tokio tasks do the waiting and the decoding, and post a [`Msg`] back.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::backend::audio::AudioEngine;
use crate::backend::config::{self, Config};
use crate::backend::math::EewAreaResult;
use crate::domain::types::{Area, IntensityReport, RtsData, Station, StationId};
use crate::events::Event;
use crate::features::alerts::{SpeechEnd, SpeechState};
use crate::features::data::{DataState, FileFrame, Polled};
use crate::features::eew::EewState;
use crate::features::estimate::EstimateState;
use crate::features::event_log::EventLogState;
use crate::features::flash::FlashState;
use crate::features::focus::FocusState;
use crate::features::report::{ReportFetch, ReportState};
use crate::features::resource::{ResourceState, StationKind};
use crate::features::rts::RtsState;
use crate::features::window::{WindowCommand, WindowState};
use crate::map::MapEngine;
use crate::net::ProxyState;
use crate::platform::speech::Speech;
use crate::timers::{Task, Timers};
use crate::variable::{UiState, Variable};

/// Waiting work's way back to the main thread.
pub type Post = Arc<dyn Fn(Msg) + Send + Sync>;

/// What comes back from other threads.
pub enum Msg {
    /// Something the map needs, a tile, arrived.
    Wake,
    RtsFrame(RtsData),
    EewFrame(serde_json::Value),
    IntensityFrame(IntensityReport),
    StreamPing {
        ts: f64,
        label: String,
    },
    Ntp(Result<crate::net::ntp::NtpResult, String>),
    Polled {
        epoch: u64,
        data: Polled,
    },
    FileFrame {
        epoch: u64,
        mode: u8,
        name: String,
        frame: Result<FileFrame, String>,
    },
    StationList {
        kind: StationKind,
        list: HashMap<StationId, Station>,
    },
    ReportText {
        purpose: ReportFetch,
        text: Option<String>,
    },
    EewArea {
        id: String,
        serial: i64,
        reported: Area,
        result: Result<EewAreaResult, String>,
        elapsed: Duration,
    },
    SpeechEnded(SpeechEnd),
    /// A downloaded update. Nothing sends this yet: the trial build has no update channel.
    #[allow(dead_code)]
    UpdateStaged(String),
    /// A second launch asked for the main window.
    SecondInstance,
    Tray(crate::platform::tray::TrayCommand),
}

/// Work that ran as a microtask or after an await: after the current event's handlers.
#[derive(Clone, Copy, Debug)]
pub enum Micro {
    FocusRts,
    SurfaceAlert { critical: bool, pip_eligible: bool },
}

const REPEAT_MS: u128 = 60_000;

pub struct App {
    pub var: Variable,
    pub ui: UiState,
    pub config: Config,
    pub map: MapEngine,
    pub net: Arc<ProxyState>,
    pub rt: tokio::runtime::Handle,
    pub post: Post,
    pub timers: Timers,
    pub audio: AudioEngine,
    pub speech: Speech,
    /// Asks of the windows, carried out by the event loop.
    pub commands: Vec<WindowCommand>,
    /// Something changed that the main window shows.
    pub dirty: bool,

    pub data_state: DataState,
    pub rts: RtsState,
    pub eew: EewState,
    pub flash: FlashState,
    pub estimate: EstimateState,
    pub focus: FocusState,
    pub report: ReportState,
    pub resource: ResourceState,
    pub event_log: EventLogState,
    pub speech_state: SpeechState,
    pub window: WindowState,
    pub clock_calibrated: Option<Instant>,

    micro: Vec<Micro>,
    depth: u32,
    failures: HashMap<String, (Instant, u32)>,
    resize_timer: Option<crate::timers::TimerId>,
}

type Module = (&'static str, fn(&mut App, &Event));

/// In the order of features/index.ts.
const MODULES: [Module; 15] = [
    ("event-log", App::log_on),
    ("audio", App::audio_on),
    ("notifications", App::notify_on),
    ("speech", App::speech_on),
    ("focus", App::focus_on),
    ("rts", App::rts_on),
    ("eew", App::eew_on),
    ("estimate", App::estimate_on),
    ("intensity", App::intensity_on),
    ("lpgm", App::lpgm_on),
    ("report", App::report_on),
    ("loop", App::loop_on),
    ("pip", App::pip_on),
    ("window", App::window_on),
    ("update", App::update_on),
];

impl App {
    pub fn new(
        rt: tokio::runtime::Handle,
        net: Arc<ProxyState>,
        post: Post,
        map: MapEngine,
        speech: Speech,
    ) -> Self {
        let config = config::load();
        log::info!(target: "config", "載入設定：{}", config.describe());
        let idle = config.idle_map;
        let auto_zoom = !config.checked("graphics-block-auto-zoom");
        Self {
            var: Variable::default(),
            ui: UiState::default(),
            config,
            map,
            net,
            rt,
            post,
            timers: Timers::default(),
            audio: AudioEngine::new(),
            speech,
            commands: Vec::new(),
            dirty: true,
            data_state: DataState::new(),
            rts: RtsState::new(idle),
            eew: EewState::default(),
            flash: FlashState::default(),
            estimate: EstimateState::default(),
            focus: FocusState::new(auto_zoom),
            report: ReportState::default(),
            resource: ResourceState::default(),
            event_log: EventLogState::default(),
            speech_state: SpeechState::default(),
            window: WindowState::default(),
            clock_calibrated: None,
            micro: Vec::new(),
            depth: 0,
            failures: HashMap::new(),
            resize_timer: None,
        }
    }

    /// Boots every module (initFeatures), then the map's `MapLoad`.
    pub fn start(&mut self, main_shown: bool) {
        self.resource_init();
        self.focus_init();
        self.eew_init();
        self.report_init();
        self.loop_init();
        self.timers.interval(3000.0, Task::SpeechTick);
        self.window_init(main_shown);
        self.data_init();
        let [[west, south], [east, north]] = crate::domain::constants::MAP_BOUNDS;
        self.map.fit_bounds(
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
        self.emit(Event::MapLoad);
    }

    // ---- The bus ----------------------------------------------------------

    /// Run every module's handler now, in order. One failing costs only its own work.
    pub fn emit(&mut self, ev: Event) {
        self.depth += 1;
        self.dirty = true;
        for (name, handler) in MODULES {
            let ran = std::panic::catch_unwind(AssertUnwindSafe(|| handler(self, &ev)));
            if ran.is_err() {
                self.failed(ev.name(), name);
            }
        }
        // data.ts registers last, and its handlers belong to no other module's state.
        let ran = std::panic::catch_unwind(AssertUnwindSafe(|| self.data_on(&ev)));
        if ran.is_err() {
            self.failed(ev.name(), "data");
        }
        self.depth -= 1;
        if self.depth == 0 {
            self.drain_micro();
        }
    }

    pub fn after_dispatch(&mut self, micro: Micro) {
        self.micro.push(micro);
    }

    fn drain_micro(&mut self) {
        while !self.micro.is_empty() {
            for micro in std::mem::take(&mut self.micro) {
                let ran = std::panic::catch_unwind(AssertUnwindSafe(|| match micro {
                    Micro::FocusRts => self.focus_after_rts(),
                    Micro::SurfaceAlert {
                        critical,
                        pip_eligible,
                    } => self.surface_alert_now(critical, pip_eligible),
                }));
                if ran.is_err() {
                    self.failed("microtask", "app");
                }
            }
        }
    }

    /// The same failure, logged once a minute with how often it recurred.
    fn failed(&mut self, event: &str, module: &str) {
        let key = format!("{event}|{module}");
        let now = Instant::now();
        match self.failures.get_mut(&key) {
            Some((at, again)) if now.duration_since(*at).as_millis() < REPEAT_MS => *again += 1,
            seen => {
                let again = seen.map_or(0, |(_, again)| *again);
                let tail = if again > 0 {
                    format!("（前 60s 又發生 {again} 次）")
                } else {
                    String::new()
                };
                self.failures.insert(key, (now, 0));
                log::error!(target: "event", "處理事件 {event} 時 {module} 出錯，其他模組照常{tail}");
            }
        }
    }

    // ---- Config -----------------------------------------------------------

    /// Persist the whole config and tell whoever follows it.
    pub fn write_config(&mut self, next: Config) {
        let diff = self.config.changes(&next);
        if !diff.is_empty() {
            log::info!(target: "config", "設定變更：{}", diff.join("；"));
        }
        if let Err(err) = config::save(&next) {
            log::warn!(target: "config", "設定寫入失敗：{err}");
        }
        self.config = next;
        self.dirty = true;
        self.on_config_updated();
    }

    pub fn reset_config(&mut self) {
        match config::reset() {
            Ok(next) => {
                log::info!(target: "config", "所有設定還原為預設值：{}", next.describe());
                self.config = next;
                self.dirty = true;
                self.on_config_updated();
            }
            Err(err) => log::warn!(target: "config", "設定還原失敗：{err}"),
        }
    }

    fn on_config_updated(&mut self) {
        self.focus_on_config();
        self.rts_on_config();
        self.report_on_config();
    }

    // ---- The clock --------------------------------------------------------

    /// Measure the offset once; a failed or slow measurement keeps the last one.
    pub fn clock_sync(&self) {
        let client = self.net.client();
        let post = self.post.clone();
        self.rt.spawn(async move {
            post(Msg::Ntp(crate::net::ntp::ntp_sync(client).await));
        });
    }

    fn clock_result(&mut self, result: Result<crate::net::ntp::NtpResult, String>) {
        const MAX_RTT_MS: f64 = 1000.0;
        match result {
            Ok(r) if r.rtt_ms > MAX_RTT_MS => {
                log::warn!(target: "clock", "校時失敗，沿用上次的時鐘差：來回 {}ms，超過 {MAX_RTT_MS}ms 不採用", r.rtt_ms.round());
            }
            Ok(r) => {
                let before = self.var.cache.time_offset;
                self.var.cache.time_offset = r.offset_ms;
                self.clock_calibrated = Some(Instant::now());
                log::info!(
                    target: "clock",
                    "校時（{}）：本機時鐘差 {:+.1}ms（上次 {before:.1}ms），來回 {:.1}ms",
                    r.via,
                    r.offset_ms,
                    r.rtt_ms
                );
            }
            Err(err) => log::warn!(target: "clock", "校時失敗，沿用上次的時鐘差：{err}"),
        }
    }

    /// `: ping <unix s>`. Off by much means the transport or the clock; adopted only when
    /// calibration has not been working.
    fn clock_on_ping(&mut self, ts: f64, label: &str) {
        const PING_SKEW_WARN_S: f64 = 5.0;
        const TRUSTED_MS: u128 = 30 * 60_000;
        if !ts.is_finite() || ts <= 0.0 {
            return;
        }
        let skew = (self.var.real_now() / 1000.0 - ts).round();
        if skew.abs() <= PING_SKEW_WARN_S {
            return;
        }
        log::warn!(target: "sse", "{label} 心跳時間戳跟本機差 {skew}s（伺服器 {ts}）：傳輸延遲或時鐘不準");
        if self
            .clock_calibrated
            .is_some_and(|at| at.elapsed().as_millis() < TRUSTED_MS)
        {
            return;
        }
        let offset = ts * 1000.0 - chrono::Utc::now().timestamp_millis() as f64;
        let before = self.var.cache.time_offset;
        if (offset - before).abs() < 5000.0 {
            return;
        }
        self.var.cache.time_offset = offset;
        log::warn!(
            target: "clock",
            "校時一直失敗，改用 {label} 心跳的伺服器時間：本機時鐘差 {:+}ms（原本 {}ms）",
            offset.round(),
            before.round()
        );
    }

    // ---- Timers and messages ----------------------------------------------

    pub fn run_task(&mut self, task: Task) {
        match task {
            Task::FocusTick => self.focus_now(),
            Task::FocusPending => self.focus_pending_fired(),
            Task::EewWaves => self.eew_waves(),
            Task::EewCacheSweep => self.eew_sweep(),
            Task::EewRotate => self.show_eew(true),
            Task::LoopBeat => self.loop_beat(),
            Task::LoopInternet => self.loop_internet(),
            Task::ClockSync => self.clock_sync(),
            Task::DataFetch => self.data_fetch(),
            Task::DataSleep => self.data_sleep_fired(),
            Task::IntensityOff => self.intensity_off(),
            Task::LpgmOff => self.lpgm_off(),
            Task::ReplayLimit => self.replay_limit_tick(),
            Task::ReplayReturn => {
                self.focus_reset(false);
                self.focus_now();
            }
            Task::ReportNewest => self.report_check_newest(),
            Task::ReportFull => self.report_refresh(),
            Task::ResourceFetch => self.resource_fetch(),
            Task::SpeechTick => self.speech_tick(),
            Task::SpeechDone(id) => self.emit(Event::ReportSpeechEnd(id)),
            Task::UpdateWait => self.update_wait(),
            Task::WindowWatch => self.window_watch(),
            Task::ResizeFit => {
                self.resize_timer = None;
                if !self.focus.lock && !self.var.event_holds_map() {
                    self.fit_taiwan();
                }
            }
        }
        self.drain_micro();
    }

    pub fn on_msg(&mut self, msg: Msg) {
        match msg {
            Msg::Wake => self.map.tile_arrived(),
            Msg::RtsFrame(rts) => self.data_rts_frame(rts),
            Msg::EewFrame(parsed) => self.data_eew_frame(&parsed),
            Msg::IntensityFrame(report) => self.data_intensity_frame(report),
            Msg::StreamPing { ts, label } => self.clock_on_ping(ts, &label),
            Msg::Ntp(result) => self.clock_result(result),
            Msg::Polled { epoch, data } => self.data_polled(epoch, data),
            Msg::FileFrame {
                epoch,
                mode,
                name,
                frame,
            } => self.data_file_frame(epoch, mode, name, frame),
            Msg::StationList { kind, list } => self.resource_list(kind, list),
            Msg::ReportText { purpose, text } => self.report_text(purpose, text),
            Msg::EewArea {
                id,
                serial,
                reported,
                result,
                elapsed,
            } => self.estimate_done(id, serial, reported, result, elapsed),
            Msg::SpeechEnded(end) => self.speech_ended(end),
            Msg::UpdateStaged(version) => self.update_staged(&version),
            Msg::SecondInstance => {
                log::info!(target: "app", "第二次啟動：叫出已經在跑的主視窗");
                self.commands
                    .push(WindowCommand::FocusMain { critical: false });
            }
            Msg::Tray(command) => self.tray_command(command),
        }
        self.drain_micro();
    }

    fn tray_command(&mut self, command: crate::platform::tray::TrayCommand) {
        use crate::platform::tray::TrayCommand;
        match command {
            TrayCommand::Show => self
                .commands
                .push(WindowCommand::FocusMain { critical: false }),
            TrayCommand::Toggle => self.commands.push(WindowCommand::ToggleMain),
            TrayCommand::Restart => self.commands.push(WindowCommand::Restart {
                hidden: self.window.main_unavailable,
            }),
            TrayCommand::Quit => self.commands.push(WindowCommand::Quit),
        }
    }

    /// The canvas tracks the window; idle and unlocked, all of Taiwan once the size settles.
    pub fn map_resized(&mut self, width: f64, height: f64) {
        self.map.resize(width, height);
        self.timers.clear_slot(&mut self.resize_timer);
        self.resize_timer = Some(self.timers.timeout(200.0, Task::ResizeFit));
    }
}
