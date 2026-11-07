//! Data ingestion (features/data/data.ts, dataHttp.ts): the live streams, an HTTP
//! replay's polling, a file replay's frames, and everything's lifecycle events.

use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::app::{App, Msg, Post};
use crate::backend::logging::{fmt_bytes, fmt_dur};
use crate::domain::constants::{timeout, EEW_AUTHOR, INTENSITY_LIST, LAST_DATA_TIMEOUT_ERROR};
use crate::domain::types::{
    decode_payload, parse_eew_list, read_eq, read_intensity_file, read_intensity_v1,
    read_intensity_xml, Area, EewData, IntensityReport, LpgmData, RawStations, RtsData, RtsStation,
    RtsV1, StationId,
};
use crate::domain::utils::format_time;
use crate::events::Event;
use crate::features::rts::fill_derived;
use crate::net::fixture;
use crate::net::sse::{Cancel, Frame, Health, Stream, StreamSpec};
use crate::net::{ProxyRequest, ProxyState};
use crate::timers::{Task, TimerId};
use crate::variable::{AudioCache, LastSeen, Replay, RtsTrigger};

const TOPICS: &str = "trem.intensity.v1,trem.rts.v1";
const LB_API: &str = "api.lb.exptech.dev";
const CORE_API: &str = "api.core.exptech.dev";
/// The lpgm archive is served only by api-1; the core nodes answer 401.
const TREM_ARCHIVE_HOST: &str = "api-1.exptech.dev";
/// How long the main window stays hidden before the RTS stream sleeps. Waking is
/// immediate: a window brought back by an earthquake needs its data now.
const SLEEP_AFTER_MS: f64 = 3000.0;
const RECONNECT_DELAY: Duration = Duration::from_secs(3);

fn mode_name(mode: u8) -> String {
    match mode {
        0 => "即時".to_string(),
        2 => "報告重播".to_string(),
        3 => "檔案重播".to_string(),
        other => other.to_string(),
    }
}

fn shindo(i: i32) -> String {
    usize::try_from(i)
        .ok()
        .and_then(|i| INTENSITY_LIST.get(i))
        .map_or_else(|| i.to_string(), |s| (*s).to_string())
}

/// The data loop's pace: 1 s, slowed while the replay archive answers nothing and eased
/// back once it answers, adjusted at most every 2 s.
struct LoopPace {
    last_adjust: Instant,
    failures: u32,
    interval: f64,
}

impl LoopPace {
    const MAX: f64 = 10_000.0;
    const STEP: f64 = 500.0;

    fn new() -> Self {
        Self {
            last_adjust: Instant::now(),
            failures: 0,
            interval: timeout::LOOP,
        }
    }

    /// Record a poll's outcome; false when it brought nothing and is skipped.
    fn record(&mut self, got: bool) -> bool {
        if self.last_adjust.elapsed() < Duration::from_secs(2) {
            return true;
        }
        self.last_adjust = Instant::now();
        if !got {
            self.failures = (self.failures + 1).min(10);
            self.interval = (self.interval + Self::STEP * f64::from(self.failures)).min(Self::MAX);
            return false;
        }
        self.failures /= 2;
        if self.interval > timeout::LOOP {
            self.interval =
                (self.interval - Self::STEP * f64::from(self.failures + 1)).max(timeout::LOOP);
        }
        true
    }
}

/// The two live streams.
struct SseManager {
    trem: Option<Stream>,
    eew: Option<Stream>,
    background: Arc<AtomicBool>,
}

impl SseManager {
    fn abort(&self) {
        log::info!(target: "sse", "停止即時連線（進入重播或重設）");
        if let Some(stream) = &self.trem {
            stream.stop();
        }
        if let Some(stream) = &self.eew {
            stream.stop();
        }
    }

    fn set_background(&self, value: bool) {
        if self.background.swap(value, Ordering::SeqCst) == value {
            return;
        }
        log::info!(
            target: "sse",
            "切成{}模式，trem 建立新連線，舊的留到交接完成",
            if value { "休眠" } else { " live " }
        );
        if let Some(stream) = &self.trem {
            stream.handover();
        }
    }

    /// A network that comes back can leave a connection that looks open and is dead:
    /// each takes a fresh connection at once, keeping the old until it is up.
    fn renew(&self) {
        log::info!(target: "sse", "網路恢復：trem 與 eew 各建立新連線，舊的留到交接完成");
        if let Some(stream) = &self.trem {
            stream.handover();
        }
        if let Some(stream) = &self.eew {
            stream.handover();
        }
    }
}

pub struct DataState {
    map_initialized: bool,
    sse_active: bool,
    sse: Option<SseManager>,
    fetch_timer: Option<TimerId>,
    /// The main window is hidden, so RTS may sleep.
    background: bool,
    /// Whether the stream has actually been put to sleep.
    pub asleep: bool,
    sleep_timer: Option<TimerId>,
    transport_epoch: u64,
    pace: LoopPace,
    request_counter: u64,
    file_list: Vec<String>,
    file_index: usize,
    polls: Vec<Cancel>,
    pub trem_health: Arc<Health>,
    pub eew_health: Arc<Health>,
}

impl DataState {
    pub fn new() -> Self {
        Self {
            map_initialized: false,
            sse_active: false,
            sse: None,
            fetch_timer: None,
            background: false,
            asleep: false,
            sleep_timer: None,
            transport_epoch: 0,
            pace: LoopPace::new(),
            request_counter: 0,
            file_list: Vec::new(),
            file_index: 0,
            polls: Vec::new(),
            trem_health: Arc::new(Health::default()),
            eew_health: Arc::new(Health::default()),
        }
    }
}

/// What one poll of an HTTP replay brought, not yet checked against the world.
#[derive(Default)]
pub struct Polled {
    pub rts: Option<RtsData>,
    pub eew: Option<Value>,
    pub intensity: Option<Vec<IntensityReport>>,
    pub lpgm: Option<Value>,
}

/// A replay file's frame.
pub struct FileFrame {
    pub rts: Option<RtsData>,
    pub eew: Value,
    pub intensity: Value,
}

/// A file frame's `rts`: the older shape, which carries its own `box` and `int`.
fn read_file_rts(value: &Value) -> Option<RtsData> {
    if value.is_null() {
        return None;
    }
    let station = value
        .get("station")
        .map(|s| serde_json::from_value::<RawStations>(s.clone()))
        .transpose()
        .ok()?
        .map_or_else(Vec::new, |s| s.0);
    let boxes = value
        .get("box")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(id, level)| Some((id.parse().ok()?, level.as_i64()? as i32)))
                .collect()
        })
        .unwrap_or_default();
    let int = value
        .get("int")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|e| {
                    Some((
                        e.get("code")?.as_i64()? as i32,
                        e.get("i")?.as_f64()? as i32,
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    Some(RtsData {
        station,
        boxes,
        int,
        time: value.get("time").and_then(Value::as_f64).unwrap_or(0.0),
        eq: value.get("eq").map(read_eq).unwrap_or_default(),
    })
}

/// A worker's read of an rts.v1 payload: `box` and `int` are added on the main thread,
/// which holds the station list.
fn rts_from_v1(payload: RtsV1) -> Option<RtsData> {
    let stations: Vec<(StationId, RtsStation)> = payload.stations?.0;
    Some(RtsData {
        station: stations,
        boxes: Vec::new(),
        int: Vec::new(),
        time: payload.ts.unwrap_or(0.0),
        eq: payload.eq.as_ref().map(read_eq).unwrap_or_default(),
    })
}

/// A frame of the EEW stream, one clause per EEW: serial, unit, kind, size and place.
fn eew_summary(parsed: &Value, real_now: f64) -> String {
    let single = [parsed.clone()];
    let list: &[Value] = parsed.as_array().map_or(&single, Vec::as_slice);
    if list.is_empty() {
        return "空的（目前沒有生效中的預警）".to_string();
    }
    let text = |v: Option<&Value>| match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => "?".to_string(),
    };
    list.iter()
        .map(|e| {
            let eq = e.get("eq");
            let kind = match e.get("status").and_then(Value::as_i64) {
                Some(1) => "警報",
                Some(3) => "取消",
                _ => "預警",
            };
            let lag = e
                .get("time")
                .and_then(Value::as_f64)
                .filter(|t| *t > 1e12)
                .map_or_else(String::new, |t| {
                    format!(
                        "，發布後 {} 收到",
                        fmt_dur(Duration::from_secs_f64((real_now - t).max(0.0) / 1000.0))
                    )
                });
            format!(
                "{} {} 第 {} 報 {kind} M{} {} 最大 {}{lag}",
                text(e.get("author")),
                text(e.get("id")),
                text(e.get("serial")),
                text(eq.and_then(|q| q.get("mag"))),
                text(eq.and_then(|q| q.get("loc"))),
                shindo(
                    eq.and_then(|q| q.get("max"))
                        .and_then(Value::as_i64)
                        .map_or(-1, |m| m as i32)
                ),
            )
        })
        .collect::<Vec<_>>()
        .join("；")
}

/// Open the live streams. A frame is decoded on the stream's worker; only the result
/// reaches the main thread.
fn open_streams(
    post: &Post,
    proxy: &Arc<ProxyState>,
    data: &DataState,
    real_now: Arc<dyn Fn() -> f64 + Send + Sync>,
) -> SseManager {
    let background = Arc::new(AtomicBool::new(data.asleep));
    log::info!(
        target: "sse",
        "啟動即時連線：節點 {LB_API}，trem topic {TOPICS}（{}），eew 為 CWA 預警",
        if data.asleep { "休眠：rts 只收有測站觸發的資料" } else { "live" }
    );
    // Fixture mode never touches the network: the streams stay closed.
    if fixture::active() {
        return SseManager {
            trem: None,
            eew: None,
            background,
        };
    }
    let trem_url = {
        let background = Arc::clone(&background);
        Arc::new(move || {
            format!(
                "https://{LB_API}/api/v1/trem/sse?topics={TOPICS}{}",
                if background.load(Ordering::SeqCst) {
                    ""
                } else {
                    "&mode=live"
                }
            )
        })
    };
    let ping = |post: &Post| -> crate::net::sse::PingFn {
        let post = post.clone();
        Arc::new(move |ts, label| {
            post(Msg::StreamPing {
                ts,
                label: label.to_string(),
            });
        })
    };
    let trem_post = post.clone();
    let trem = Stream::open(
        StreamSpec {
            name: "trem",
            url: trem_url,
            wanted_topics: TOPICS.split(',').count(),
            on_frame: Arc::new(move |frame: &Frame, label: &str| {
                on_trem_frame(frame, label, &trem_post);
            }),
            on_ping: ping(post),
            reconnect_delay: RECONNECT_DELAY,
        },
        Arc::clone(proxy),
        Arc::clone(&data.trem_health),
    );
    let eew_post = post.clone();
    let eew = Stream::open(
        StreamSpec {
            name: "eew",
            url: Arc::new(|| format!("https://{LB_API}/api/v2/eq/eew?sse=1")),
            wanted_topics: 0,
            on_frame: Arc::new(move |frame: &Frame, label: &str| {
                // The `info` greeting names the node (logged by the connection); EEWs
                // come unnamed.
                if frame.event.is_some() {
                    return;
                }
                match serde_json::from_str::<Value>(&frame.data) {
                    Ok(parsed) if !parsed.is_null() => {
                        log::info!(
                            target: "sse",
                            "{label} 收到 EEW：{}（{}）",
                            eew_summary(&parsed, real_now()),
                            fmt_bytes(frame.data.len() as u64)
                        );
                        eew_post(Msg::EewFrame(parsed));
                    }
                    Ok(_) => {}
                    Err(_) => {
                        let start: String = frame.data.chars().take(200).collect();
                        log::warn!(target: "sse", "{label} EEW 不是合法的 JSON，略過：{start}");
                    }
                }
            }),
            on_ping: ping(post),
            reconnect_delay: RECONNECT_DELAY,
        },
        Arc::clone(proxy),
        Arc::clone(&data.eew_health),
    );
    SseManager {
        trem: Some(trem),
        eew: Some(eew),
        background,
    }
}

fn on_trem_frame(frame: &Frame, label: &str, post: &Post) {
    match frame.event.as_deref() {
        // The greeting: logged by the connection.
        Some("info") => {}
        Some("trem.rts.v1") => {
            let text = decode_payload(&frame.data);
            // Not a frame this client understands.
            let Ok(payload) = serde_json::from_str::<RtsV1>(&text) else {
                return;
            };
            if let Some(rts) = rts_from_v1(payload) {
                post(Msg::RtsFrame(rts));
            }
        }
        Some("trem.intensity.v1") => {
            let bytes = fmt_bytes(frame.data.len() as u64);
            match read_intensity_xml(&decode_payload(&frame.data)) {
                Some(report) => {
                    log::info!(
                        target: "sse",
                        "{label} 收到 trem.intensity.v1：EventID={} 第 {} 報 {} 最大震度 {}（{bytes}）",
                        report.id,
                        report.serial,
                        report.status,
                        shindo(report.max)
                    );
                    post(Msg::IntensityFrame(report));
                }
                None => {
                    log::warn!(target: "sse", "{label} trem.intensity.v1 解不開，略過（{bytes}）");
                }
            }
        }
        Some("unsubscribed") => {
            log::warn!(target: "sse", "{label} topic 被伺服器停掉：{}。其他 topic 照收，等下次重連再要", frame.data);
        }
        Some("close") => log::warn!(target: "sse", "{label} 伺服器主動關閉：{}", frame.data),
        other => {
            log::info!(target: "sse", "{label} 略過 app 不認得的 event {}", other.unwrap_or("message"));
        }
    }
}

fn is_area_different(a: &Area, b: Option<&Area>) -> bool {
    let Some(b) = b else {
        return true;
    };
    if a.len() != b.len() {
        return true;
    }
    a.iter().any(|(level, codes)| {
        let empty = Vec::new();
        let other = b
            .iter()
            .find(|(l, _)| l == level)
            .map_or(&empty, |(_, c)| c);
        codes.len() != other.len() || !codes.iter().all(|c| other.contains(c))
    })
}

impl App {
    pub fn data_init(&mut self) {
        self.detect_replay();
    }

    pub fn data_on(&mut self, ev: &Event) {
        match ev {
            Event::MainWindowHidden(hidden) => self.set_background(*hidden),
            Event::MapLoad => {
                if self.data_state.map_initialized {
                    return;
                }
                self.data_state.map_initialized = true;
                self.arm_fetch(0.0);
            }
            _ => {}
        }
    }

    /// Replay frames under `<data>/replay`, named by their time, mean a file replay.
    fn detect_replay(&mut self) {
        let Some(dir) = crate::paths::data_dir().map(|d| d.join("replay")) else {
            return;
        };
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return; // no replay dir: stay live
        };
        let mut frames: Vec<(u64, String)> = entries
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().into_string().ok()?;
                let stem = name.strip_suffix(".json")?;
                if stem.is_empty() || !stem.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
                let time: u64 = stem.parse().ok()?;
                (time > 0 && time < (1 << 53)).then_some((time, name))
            })
            .collect();
        frames.sort_unstable();
        let Some(first) = frames.first().map(|f| f.0) else {
            return;
        };
        log::info!(target: "data", "找到 {} 個重播檔（replay/），進入檔案重播", frames.len());
        self.data_state.file_list = frames.into_iter().map(|f| f.1).collect();
        self.data_state.file_index = 0;
        self.switch_mode(
            3,
            Replay {
                start_time: first as f64,
                local_time: 0.0,
            },
        );
        self.emit(Event::ReplayStateChange {
            active: true,
            report_id: None,
        });
    }

    fn arm_fetch(&mut self, delay: f64) {
        self.timers.clear_slot(&mut self.data_state.fetch_timer);
        self.data_state.fetch_timer = Some(self.timers.timeout(delay, Task::DataFetch));
    }

    pub fn data_fetch(&mut self) {
        let interval = self.data_state.pace.interval;
        self.arm_fetch(interval);

        if self.var.play_mode == 0 {
            self.start_sse();
        }
        if self.var.play_mode == 3 {
            self.stop_sse();
        }
        if self.data_state.sse_active {
            // An EEW and a shake report end by age, but the stream sends one only when
            // it is issued, never when it expires: age them here, as every poll does.
            self.process_eew(Vec::new());
            self.process_intensity(Vec::new());
            return;
        }
        if self.var.play_mode == 3 {
            self.next_file_frame();
            return;
        }
        // Live data is the stream's, a file replay reads its frames: what is left is an
        // HTTP replay, polled at its clock.
        let time = self.var.now();
        self.get_data(time);
    }

    fn next_file_frame(&mut self) {
        if self.data_state.file_index >= self.data_state.file_list.len() {
            self.switch_mode(0, Replay::default());
            self.emit(Event::ReplayStateChange {
                active: false,
                report_id: None,
            });
            return;
        }
        let name = self.data_state.file_list[self.data_state.file_index].clone();
        self.data_state.file_index += 1;
        let epoch = self.data_state.transport_epoch;
        let mode = self.var.play_mode;
        let post = self.post.clone();
        self.rt.spawn_blocking(move || {
            let read = || -> Result<FileFrame, String> {
                let path = crate::paths::data_dir()
                    .ok_or_else(|| "找不到資料目錄".to_string())?
                    .join("replay")
                    .join(&name);
                let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
                let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                Ok(FileFrame {
                    rts: json.get("rts").and_then(read_file_rts),
                    eew: json.get("eew").cloned().unwrap_or(Value::Null),
                    intensity: json.get("intensity").cloned().unwrap_or(Value::Null),
                })
            };
            let frame = read();
            post(Msg::FileFrame {
                epoch,
                mode,
                name,
                frame,
            });
        });
    }

    pub fn data_file_frame(
        &mut self,
        epoch: u64,
        mode: u8,
        name: String,
        frame: Result<FileFrame, String>,
    ) {
        if epoch != self.data_state.transport_epoch || mode != self.var.play_mode {
            return;
        }
        let frame = match frame {
            Ok(frame) => frame,
            Err(err) => {
                log::warn!(target: "data", "重播檔 replay/{name} 讀不出來，跳過：{err}");
                return;
            }
        };
        let rts = frame.rts.map(Rc::new);
        self.var.data.rts.clone_from(&rts);
        self.emit(Event::DataRts(rts));
        self.process_eew(parse_eew_list(&frame.eew));
        self.process_intensity(read_intensity_file(&frame.intensity));
    }

    /// RTS and intensity from the v3 archives, EEW every call, intensity every 5th call,
    /// lpgm every 7th.
    fn get_data(&mut self, time: f64) {
        let suffix = format!("/{}", (time / 1000.0).round() as i64);
        self.data_state.request_counter += 1;
        let counter = self.data_state.request_counter;
        let want_lpgm = counter.is_multiple_of(7);
        let want_intensity = counter.is_multiple_of(5);
        let cancel = Cancel::default();
        self.data_state.polls.push(cancel.clone());
        // Only the polls still running need cancelling; a few finished ones are harmless.
        if self.data_state.polls.len() > 16 {
            self.data_state.polls.remove(0);
        }
        let proxy = Arc::clone(&self.net);
        let post = self.post.clone();
        let epoch = self.data_state.transport_epoch;
        self.rt.spawn(async move {
            let json = |url: String, ms: u64| {
                let proxy = Arc::clone(&proxy);
                async move {
                    let reply = proxy
                        .send(ProxyRequest::get(url, ms).no_store())
                        .await
                        .ok()?;
                    if !reply.ok() {
                        return None;
                    }
                    serde_json::from_slice::<Value>(&reply.body).ok()
                }
            };
            let requests = async {
                let rts = json(
                    format!("https://{CORE_API}/api/v3/trem/rts{suffix}"),
                    timeout::RTS,
                );
                let eew = json(
                    format!("https://{CORE_API}/api/v2/eq/eew{suffix}"),
                    timeout::EEW,
                );
                let intensity = async {
                    if want_intensity {
                        json(
                            format!("https://{CORE_API}/api/v3/trem/intensity{suffix}"),
                            timeout::INTENSITY,
                        )
                        .await
                    } else {
                        None
                    }
                };
                let lpgm = async {
                    if want_lpgm {
                        json(
                            format!("https://{TREM_ARCHIVE_HOST}/api/v2/trem/lpgm{suffix}"),
                            timeout::LPGM,
                        )
                        .await
                    } else {
                        None
                    }
                };
                tokio::join!(rts, eew, intensity, lpgm)
            };
            let answered = tokio::select! {
                () = cancel.cancelled() => return,
                answered = requests => answered,
            };
            let (rts, eew, intensity, lpgm) = answered;
            post(Msg::Polled {
                epoch,
                data: Polled {
                    rts: rts
                        .and_then(|v| serde_json::from_value::<RtsV1>(v).ok())
                        .and_then(rts_from_v1),
                    eew,
                    intensity: intensity.as_ref().and_then(read_intensity_v1),
                    lpgm,
                },
            });
        });
    }

    pub fn data_polled(&mut self, epoch: u64, data: Polled) {
        // A transition may occur while requests are pending. Never process a result
        // from the previous mode or epoch.
        if epoch != self.data_state.transport_epoch || self.var.play_mode != 2 {
            return;
        }
        if !self
            .data_state
            .pace
            .record(data.eew.is_some() || data.rts.is_some())
        {
            return;
        }
        let rts = data.rts.map(|mut rts| {
            fill_derived(&mut rts, self.var.station.as_ref());
            Rc::new(rts)
        });
        let real_now = self.var.real_now();
        let newer = match (&self.var.data.rts, &rts) {
            (None, _) => true,
            (Some(_), None) => real_now - self.var.cache.last_data_time > LAST_DATA_TIMEOUT_ERROR,
            (Some(known), Some(next)) => known.time < next.time,
        };
        let got_rts = rts.is_some();
        if newer {
            self.var.data.rts.clone_from(&rts);
            self.emit(Event::DataRts(rts));
        }
        self.process_eew(data.eew.as_ref().map_or_else(Vec::new, parse_eew_list));
        if let Some(intensity) = data.intensity {
            self.process_intensity(intensity);
        }
        if let Some(lpgm) = data.lpgm {
            self.process_lpgm(&lpgm);
        }
        if got_rts {
            self.var.cache.last_data_time = self.var.real_now();
        }
    }

    pub fn data_rts_frame(&mut self, mut rts: RtsData) {
        if self.var.play_mode != 0 {
            return;
        }
        fill_derived(&mut rts, self.var.station.as_ref());
        let rts = Rc::new(rts);
        self.var.data.rts = Some(Rc::clone(&rts));
        self.emit(Event::DataRts(Some(rts)));
        self.var.cache.last_data_time = self.var.real_now();
    }

    pub fn data_eew_frame(&mut self, parsed: &Value) {
        if self.var.play_mode != 0 {
            return;
        }
        self.process_eew(parse_eew_list(parsed));
    }

    pub fn data_intensity_frame(&mut self, report: IntensityReport) {
        if self.var.play_mode != 0 {
            return;
        }
        self.process_intensity(vec![report]);
    }

    fn start_sse(&mut self) {
        if self.var.play_mode != 0 {
            return;
        }
        self.data_state.sse_active = true;
        if self.data_state.sse.is_some() {
            return;
        }
        let offset = self.var.cache.time_offset;
        let real_now = Arc::new(move || chrono::Utc::now().timestamp_millis() as f64 + offset);
        let _guard = self.rt.enter();
        self.data_state.sse = Some(open_streams(
            &self.post,
            &self.net,
            &self.data_state,
            real_now,
        ));
    }

    fn stop_sse(&mut self) {
        self.data_state.sse_active = false;
        if let Some(sse) = self.data_state.sse.take() {
            sse.abort();
        }
    }

    /// The machine woke or the network came back.
    pub fn data_network_back(&mut self) {
        if let Some(sse) = &self.data_state.sse {
            let _guard = self.rt.enter();
            sse.renew();
        }
    }

    /// Sleep the RTS stream once hidden for a while; wake it at once.
    fn set_background(&mut self, hidden: bool) {
        self.data_state.background = hidden;
        let debouncing = self.data_state.sleep_timer.is_some();
        self.timers.clear_slot(&mut self.data_state.sleep_timer);
        if !hidden {
            if debouncing {
                log::info!(
                    target: "data",
                    "視窗在 {} 內又被叫回，不切休眠",
                    fmt_dur(Duration::from_secs_f64(SLEEP_AFTER_MS / 1000.0))
                );
            }
            self.apply_sleep(false);
            return;
        }
        if !self.data_state.asleep {
            log::info!(
                target: "data",
                "視窗收起：{} 後切成休眠模式",
                fmt_dur(Duration::from_secs_f64(SLEEP_AFTER_MS / 1000.0))
            );
        }
        self.data_state.sleep_timer = Some(self.timers.timeout(SLEEP_AFTER_MS, Task::DataSleep));
    }

    pub fn data_sleep_fired(&mut self) {
        self.data_state.sleep_timer = None;
        if self.data_state.background {
            self.apply_sleep(true);
        }
    }

    fn apply_sleep(&mut self, asleep: bool) {
        if asleep == self.data_state.asleep {
            return;
        }
        self.data_state.asleep = asleep;
        log::info!(
            target: "data",
            "{}",
            if asleep {
                "休眠模式生效：rts 只收有測站觸發的資料，eew／intensity 照常即時"
            } else {
                "視窗叫回：立即切回 live 模式"
            }
        );
        // Frames stopped coming on purpose; the first live one is a moment away.
        if !asleep {
            self.var.cache.last_data_time = self.var.real_now();
        }
        if let Some(sse) = &self.data_state.sse {
            let _guard = self.rt.enter();
            sse.set_background(asleep);
        }
    }

    /// No live or replay object or alert cache crosses a mode boundary.
    fn clear_domain_state(&mut self) {
        let eew = std::mem::take(&mut self.var.data.eew);
        let intensity = std::mem::take(&mut self.var.data.intensity);
        self.var.data.rts = None;
        self.var.data.lpgm.clear();

        let cache = &mut self.var.cache;
        cache.rts_alert = false;
        cache.unstable = 0.0;
        cache.show_eew_box = false;
        cache.rts_trigger = RtsTrigger::default();
        cache.eew_last.clear();
        cache.intensity_last.clear();
        cache.eew_intensity_area.clear();
        cache.show_intensity = false;
        cache.show_lpgm = false;
        cache.intensity_time = 0.0;
        cache.intensity_max = 0;
        cache.last_data_time = 0.0;
        cache.last_rts_alert = 0.0;
        cache.bounds.rts.clear();
        cache.bounds.intensity.clear();
        cache.bounds.lpgm.clear();
        cache.audio = AudioCache::default();

        self.ui.current_eew = None;
        self.ui.current_trigger = None;
        self.emit(Event::EewDisplayUpdate);

        for mut data in eew {
            data.eew_end = true;
            self.emit(Event::EewEnd(Rc::new(data)));
        }
        for data in intensity {
            let mut data = (*data).clone();
            data.ended = true;
            self.emit(Event::IntensityEnd(Rc::new(data)));
        }
        self.emit(Event::DataModeReset);
        self.emit(Event::DataRts(None));
    }

    /// The one way between live and replay, whichever replay it is. Nothing crosses the
    /// boundary: no stream or request, no domain object, no sound or speech.
    pub fn switch_mode(&mut self, mode: u8, replay: Replay) {
        let at = if replay.start_time != 0.0 {
            format!("，從 {} 開始", format_time(replay.start_time))
        } else {
            String::new()
        };
        log::info!(
            target: "data",
            "資料模式：{} → {}{at}",
            mode_name(self.var.play_mode),
            mode_name(mode)
        );
        // Fully reset the transport before entering or leaving replay.
        self.data_state.transport_epoch += 1;
        for poll in self.data_state.polls.drain(..) {
            poll.cancel();
        }
        self.stop_sse();
        self.var.play_mode = mode;
        self.var.replay = replay;
        self.clear_domain_state();
        // After the reset, so nothing its end events set off is heard either.
        self.audio_stop_all();
        self.speech_stop();
    }

    pub fn process_eew(&mut self, new_data: Vec<EewData>) {
        const EXPIRY_TIME: f64 = 240_000.0;
        const STATUS_3_TIMEOUT: f64 = 60_000.0;
        let current = self.var.now();
        let ended = |item: &EewData| {
            item.eq.time != 0.0
                && (current - item.eq.time > EXPIRY_TIME
                    || item.eew_end
                    || (item.status == 3 && current - item.status3_time > STATUS_3_TIMEOUT))
        };
        let gone: Vec<EewData> = self
            .var
            .data
            .eew
            .iter()
            .filter(|item| ended(item))
            .cloned()
            .collect();
        for mut data in gone {
            data.eew_end = true;
            self.emit(Event::EewEnd(Rc::new(data)));
        }
        self.var
            .data
            .eew
            .retain(|item| item.eq.time != 0.0 && !ended(item));

        for mut data in new_data {
            if data.eq.time == 0.0 || current - data.eq.time > EXPIRY_TIME || data.eew_end {
                // The server still sends it as current yet the clock here says it is
                // old: the clock is wrong and every EEW is being dropped. Said loudly.
                let fresh = data.time != 0.0
                    && data.eq.time != 0.0
                    && data.time - data.eq.time <= EXPIRY_TIME;
                if self.var.play_mode == 0 && fresh && !data.eew_end {
                    log::warn!(
                        target: "data",
                        "略過預警 {} 第 {} 報：本機時間比它的發布時間晚 {} 秒，時鐘可能不準",
                        data.id,
                        data.serial,
                        ((current - data.time) / 1000.0).round()
                    );
                } else {
                    log::debug!(
                        target: "data",
                        "略過預警 {} 第 {} 報：{}",
                        data.id,
                        data.serial,
                        if data.eew_end { "已結束" } else { "發震超過 240 秒或沒有發震時間" }
                    );
                }
                continue;
            }
            let existing = self.var.data.eew.iter().position(|item| item.id == data.id);
            if existing.is_none() && !self.var.cache.eew_last.contains_key(&data.id) {
                if EEW_AUTHOR.contains(&data.author.as_str()) {
                    // The serial it arrived with: first seen at the 3rd, the same 3rd
                    // sent again is no update.
                    self.var.cache.eew_last.insert(
                        data.id.clone(),
                        LastSeen {
                            last_time: current,
                            serial: data.serial,
                        },
                    );
                    let event = Rc::new(data.clone());
                    self.var.data.eew.push(data);
                    self.emit(Event::EewRelease(event));
                } else {
                    log::debug!(
                        target: "data",
                        "略過 {} 的預警 {} 第 {} 報：只顯示 {}",
                        data.author,
                        data.id,
                        data.serial,
                        EEW_AUTHOR.join("、")
                    );
                }
                continue;
            }
            let newer = self
                .var
                .cache
                .eew_last
                .get(&data.id)
                .is_some_and(|seen| seen.serial < data.serial);
            if newer {
                if let Some(seen) = self.var.cache.eew_last.get_mut(&data.id) {
                    seen.serial = data.serial;
                }
                if data.status == 3 {
                    data.status3_time = current;
                }
                // Ended here already and yet a newer serial came: current again.
                let before_status = existing.map(|at| self.var.data.eew[at].status);
                if before_status.is_none() {
                    log::info!(
                        target: "data",
                        "預警 {} 本機已結束，又收到第 {} 報，重新顯示",
                        data.id,
                        data.serial
                    );
                }
                let event = Rc::new(data.clone());
                self.emit(Event::EewUpdate(Rc::clone(&event)));
                if data.status == 3 && before_status != Some(data.status) {
                    self.emit(Event::EewCancel(Rc::clone(&event)));
                }
                if before_status != Some(1) && data.status == 1 {
                    self.emit(Event::EewAlert(event));
                }
                // By id again: a handler may have changed the list.
                match self.var.data.eew.iter().position(|item| item.id == data.id) {
                    Some(at) => self.var.data.eew[at] = data,
                    None => self.var.data.eew.push(data),
                }
            }
        }
        self.cleanup_last(current);
    }

    pub fn process_intensity(&mut self, new_data: Vec<IntensityReport>) {
        const EXPIRY_TIME: f64 = 600_000.0;
        let current = self.var.now();
        let gone: Vec<Rc<IntensityReport>> = self
            .var
            .data
            .intensity
            .iter()
            .filter(|item| item.id != 0.0 && (current - item.id > EXPIRY_TIME || item.ended))
            .cloned()
            .collect();
        for data in gone {
            let mut data = (*data).clone();
            data.ended = true;
            self.emit(Event::IntensityEnd(Rc::new(data)));
        }
        self.var
            .data
            .intensity
            .retain(|item| item.id != 0.0 && current - item.id <= EXPIRY_TIME && !item.ended);

        for data in new_data {
            if data.id == 0.0 || current - data.id > EXPIRY_TIME || data.ended {
                continue;
            }
            let key = data.id as u64;
            let existing = self
                .var
                .data
                .intensity
                .iter()
                .position(|item| item.id == data.id);
            let data = Rc::new(data);
            if existing.is_none() && !self.var.cache.intensity_last.contains_key(&key) {
                self.var.cache.intensity_last.insert(
                    key,
                    LastSeen {
                        last_time: current,
                        serial: 1,
                    },
                );
                self.var.data.intensity.push(Rc::clone(&data));
                self.emit(Event::IntensityRelease(data));
                continue;
            }
            let newer = self
                .var
                .cache
                .intensity_last
                .get(&key)
                .is_some_and(|seen| seen.serial < data.serial);
            if newer {
                if let Some(seen) = self.var.cache.intensity_last.get_mut(&key) {
                    seen.serial = data.serial;
                }
                let before = existing.map(|at| Rc::clone(&self.var.data.intensity[at]));
                if before.is_none() {
                    log::info!(
                        target: "data",
                        "震度報告 {} 本機已結束，又收到第 {} 報，重新顯示",
                        data.id,
                        data.serial
                    );
                }
                if is_area_different(&data.area, before.as_ref().map(|b| &b.area)) {
                    self.emit(Event::IntensityUpdate(Rc::clone(&data)));
                    match self
                        .var
                        .data
                        .intensity
                        .iter()
                        .position(|item| item.id == data.id)
                    {
                        Some(at) => self.var.data.intensity[at] = data,
                        None => self.var.data.intensity.push(data),
                    }
                }
            }
        }
        self.var
            .cache
            .intensity_last
            .retain(|_, seen| current - seen.last_time <= 600_000.0);
    }

    pub fn process_lpgm(&mut self, new_data: &Value) {
        const EXPIRY_TIME: f64 = 600_000.0;
        let current = self.var.now();
        self.var
            .data
            .lpgm
            .retain(|item| item.time != 0.0 && current - item.time <= EXPIRY_TIME && !item.ended);
        let Some(list) = new_data.as_array() else {
            return;
        };
        for raw in list {
            let Ok(mut data) = serde_json::from_value::<LpgmData>(raw.clone()) else {
                continue;
            };
            if data.id == 0.0 || data.ended {
                continue;
            }
            if self.var.data.lpgm.iter().all(|item| item.id != data.id) {
                data.time = self.var.now();
                let data = Rc::new(data);
                self.var.data.lpgm.push(Rc::clone(&data));
                self.emit(Event::LpgmRelease(data));
            }
        }
    }

    fn cleanup_last(&mut self, current: f64) {
        self.var
            .cache
            .eew_last
            .retain(|_, seen| current - seen.last_time <= 600_000.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pace_slows_when_nothing_comes_and_eases_back() {
        let mut pace = LoopPace::new();
        // Within 2 s of the last adjustment nothing is decided.
        assert!(pace.record(false));
        pace.last_adjust = Instant::now() - Duration::from_secs(3);
        assert!(!pace.record(false));
        assert_eq!(pace.interval, 1500.0);
        pace.last_adjust = Instant::now() - Duration::from_secs(3);
        assert!(pace.record(true));
        assert_eq!(pace.interval, 1000.0);
    }

    #[test]
    fn areas_differ_by_content_not_order() {
        let a: Area = vec![(2, vec![1, 2]), (3, vec![3])];
        let b: Area = vec![(3, vec![3]), (2, vec![2, 1])];
        assert!(!is_area_different(&a, Some(&b)));
        assert!(is_area_different(&a, Some(&vec![(2, vec![1, 2])])));
        assert!(is_area_different(&a, None));
    }

    #[test]
    fn a_file_frame_carries_its_own_box_and_int() {
        let v: Value = serde_json::from_str(
            r#"{"station":{"117825C":{"i":1,"pga":2,"alert":1}},"box":{"5":3},"int":[{"code":970,"i":3}],"time":9}"#,
        )
        .unwrap_or_default();
        let rts = read_file_rts(&v).unwrap_or_default();
        assert_eq!(rts.boxes, vec![(5, 3)]);
        assert_eq!(rts.int, vec![(970, 3)]);
        assert_eq!(rts.time, 9.0);
        assert!(read_file_rts(&Value::Null).is_none());
    }
}
