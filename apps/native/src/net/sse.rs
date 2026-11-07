//! SSE streams, ported from features/data/dataHttp.ts (`openStream`, `ConnLog`).
//!
//! One stream keeps one connection open until it is stopped, reconnecting with
//! backoff. `handover()` opens a second connection and closes the first once the
//! new one is up (READY); should the new one fail first, the old one carries on
//! and the handover is tried again.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use web_time::Instant;

use futures_util::StreamExt;
use tokio::sync::Notify;

use crate::backend::logging::{fmt_bytes, fmt_dur};
use crate::net::ProxyState;

/// The server comments `: ping` into every stream each 60 s. Silence for one
/// and a half of those means the connection is dead even if it looks open.
pub const STALE: Duration = Duration::from_secs(90);
/// A connection is up once the server's `info` greeting arrives: the
/// subscription exists. Until then a handover keeps the connection it would
/// replace, and one that brings no greeting in this long is dropped — a hung
/// connect must not wait forever, nor hold two connections open.
const READY: Duration = Duration::from_secs(10);
/// Reconnect delays double from `reconnect_delay` up to this. Kept short: the
/// eew stream is the early-warning path, and a node that comes back must not
/// sit unused for a minute.
const BACKOFF_MAX: Duration = Duration::from_secs(15);
/// 每條連線每隔多久在日誌寫一次統計。
const SUMMARY_EVERY: Duration = Duration::from_secs(300);
/// 心跳間隔超過這個才記警告（伺服器固定 60 秒送一次）。
const PING_GAP_WARN: Duration = Duration::from_secs(75);

#[derive(Debug, Default, PartialEq)]
pub struct Frame {
    pub event: Option<String>,
    pub data: String,
    /// A `:` comment line — the server's `: ping <unix s>` heartbeat.
    pub comment: Option<String>,
}

/// One SSE block. `:` comments (the server's `: ping`) carry no data.
pub fn parse_frame(block: &str) -> Frame {
    let mut frame = Frame::default();
    let mut first = true;
    for line in block.split('\n') {
        if line.is_empty() {
            continue;
        }
        if let Some(comment) = line.strip_prefix(':') {
            frame.comment = Some(comment.trim().to_string());
            continue;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "event" => frame.event = Some(value.to_string()),
            "data" => {
                if !first {
                    frame.data.push('\n');
                }
                frame.data.push_str(value);
                first = false;
            }
            _ => {}
        }
    }
    frame
}

/// Splits a byte stream into SSE frames, holding a partial one for the next chunk.
#[derive(Default)]
pub struct FrameReader {
    buffer: Vec<u8>,
}

impl FrameReader {
    pub fn push(&mut self, chunk: &[u8], out: &mut Vec<Frame>) {
        self.buffer.extend(chunk.iter().filter(|b| **b != b'\r'));
        let mut start = 0;
        while let Some(end) = self.buffer[start..]
            .windows(2)
            .position(|w| w == b"\n\n")
            .map(|p| p + start)
        {
            out.push(parse_frame(&String::from_utf8_lossy(
                &self.buffer[start..end],
            )));
            start = end + 2;
        }
        if start > 0 {
            self.buffer.drain(..start);
        }
    }
}

/// An abort signal that async code can wait on.
#[derive(Clone, Default)]
pub struct Cancel(Arc<(AtomicBool, Notify)>);

impl Cancel {
    pub fn cancel(&self) {
        self.0 .0.store(true, Ordering::SeqCst);
        self.0 .1.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.0 .0.load(Ordering::SeqCst)
    }

    pub async fn cancelled(&self) {
        loop {
            let notified = self.0 .1.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

/// A stream's state, for the status lights next to the clock (TimeBar).
#[derive(Default)]
pub struct Health {
    /// The connection in use has had its greeting and has not ended since.
    up: AtomicBool,
    /// Ms since process start of its last byte: a frame or a heartbeat.
    last: AtomicU64,
    /// A connection has been started at all.
    started: AtomicBool,
}

fn ms_since_start() -> u64 {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

impl Health {
    /// Whether the stream is working: connected, and heard from within STALE.
    /// The second value says what is wrong when it is not.
    pub fn status(&self) -> (bool, String) {
        if !self.up.load(Ordering::Relaxed) {
            let why = if self.started.load(Ordering::Relaxed) {
                "連線中斷，重連中"
            } else {
                "尚未連線"
            };
            return (false, why.to_string());
        }
        let quiet = ms_since_start().saturating_sub(self.last.load(Ordering::Relaxed));
        if quiet > STALE.as_millis() as u64 {
            return (
                false,
                format!("{} 沒有收到任何資料", fmt_dur(Duration::from_millis(quiet))),
            );
        }
        (true, String::new())
    }
}

/// 一條連線從撥出到結束的紀錄，照 trem-monitor（live.rs 的 ConnLog）：撥出、HTTP、
/// 問候、心跳、每 5 分鐘的統計，結束時一行總結——被交接或停止收掉的也有，所以
/// 日誌裡每條連線都有頭有尾。
pub struct ConnLog {
    pub label: String,
    started: Instant,
    ready: Option<Instant>,
    frames: BTreeMap<String, (u64, u64)>,
    pings: u64,
    last_ping: Option<Instant>,
    last_summary: Instant,
    /// 失敗的原因；沒有＝被我們收掉（交接、切模式、進重播）。
    outcome: Option<String>,
    wanted_topics: usize,
}

static CONN_SEQ: AtomicU64 = AtomicU64::new(0);

impl ConnLog {
    fn new(stream: &str, url: &str, wanted_topics: usize) -> Self {
        let label = format!("{stream}#{}", CONN_SEQ.fetch_add(1, Ordering::Relaxed) + 1);
        log::info!(target: "sse", "{label} 撥出 {url}");
        Self {
            label,
            started: Instant::now(),
            ready: None,
            frames: BTreeMap::new(),
            pings: 0,
            last_ping: None,
            last_summary: Instant::now(),
            outcome: None,
            wanted_topics,
        }
    }

    fn since(&self) -> String {
        fmt_dur(self.started.elapsed())
    }

    fn http(&self, res: &reqwest::Response) {
        let seen: String = ["x-served-by", "cf-ray"]
            .iter()
            .filter_map(|name| {
                res.headers()
                    .get(*name)
                    .and_then(|v| v.to_str().ok())
                    .map(|v| format!("，{name}={v}"))
            })
            .collect();
        log::info!(target: "sse",
            "{} HTTP {}（撥出後 {}{seen}）",
            self.label,
            res.status().as_u16(),
            self.since()
        );
    }

    /// `event: info` 的內容：節點名稱、拿到的 topic、被拒的 topic 與原因。
    fn greeting(&self, data: &str) {
        log::info!(target: "sse", "{} 問候（撥出後 {}）：{data}", self.label, self.since());
        let Ok(g) = serde_json::from_str::<serde_json::Value>(data) else {
            return; // 問候不是 JSON：原文已經記下
        };
        let location = g.get("location").and_then(|v| v.as_str()).unwrap_or("?");
        match g.get("topics").and_then(|v| v.as_array()) {
            Some(topics) => log::info!(target: "sse",
                "{} 連上 {location}：收 {}/{} 個 topic",
                self.label,
                topics.len(),
                self.wanted_topics
            ),
            None => log::info!(target: "sse", "{} 連上 {location}", self.label),
        }
        if let Some(denied) = g.get("denied").and_then(|v| v.as_object()) {
            for (topic, reason) in denied {
                log::warn!(target: "sse",
                    "{} {topic} 沒拿到：{reason}。其他 topic 照收，這個等下次重連再要",
                    self.label
                );
            }
        }
    }

    fn frame(&mut self, kind: &str, bytes: usize) {
        let entry = self.frames.entry(kind.to_string()).or_insert((0, 0));
        entry.0 += 1;
        entry.1 += bytes as u64;
        self.maybe_summary();
    }

    /// `: ping <unix 秒>`：記間隔。回傳伺服器時間戳，呼叫端比對時鐘。
    fn ping(&mut self, text: &str) -> Option<f64> {
        let now = Instant::now();
        if let Some(last) = self.last_ping {
            if now - last > PING_GAP_WARN {
                log::warn!(target: "sse", "{} 心跳間隔 {}（正常 60s）", self.label, fmt_dur(now - last));
            }
        }
        self.pings += 1;
        self.last_ping = Some(now);
        self.maybe_summary();
        text.strip_prefix("ping")
            .and_then(|t| t.trim().parse::<f64>().ok())
            .filter(|t| t.is_finite() && *t > 0.0)
    }

    fn stats(&self) -> String {
        let per_topic = if self.frames.is_empty() {
            "沒有資料".to_string()
        } else {
            self.frames
                .iter()
                .map(|(k, (n, bytes))| format!("{k} {n} 筆／{}", fmt_bytes(*bytes)))
                .collect::<Vec<_>>()
                .join("、")
        };
        let last = self.last_ping.map_or(String::new(), |t| {
            format!("，最後一次 {} 前", fmt_dur(t.elapsed()))
        });
        format!("{per_topic}；心跳 {} 次{last}", self.pings)
    }

    fn maybe_summary(&mut self) {
        if self.last_summary.elapsed() < SUMMARY_EVERY {
            return;
        }
        self.last_summary = Instant::now();
        log::info!(target: "sse", "{} 統計（已連 {}）：{}", self.label, self.since(), self.stats());
    }

    fn end(&self) {
        let why = self
            .outcome
            .as_deref()
            .unwrap_or("被收掉（交接、切換模式、進入重播或停止）");
        let line = match self.ready {
            Some(ready) => format!(
                "{} 結束：{why}。歷時 {}（連上 {}），{}",
                self.label,
                self.since(),
                fmt_dur(ready.elapsed()),
                self.stats()
            ),
            None => format!(
                "{} 結束（沒連上）：{why}。歷時 {}",
                self.label,
                self.since()
            ),
        };
        if self.outcome.is_some() {
            log::warn!(target: "sse", "{line}");
        } else {
            log::info!(target: "sse", "{line}");
        }
    }
}

pub type UrlFn = Arc<dyn Fn() -> String + Send + Sync>;
/// Takes a frame and the connection's label. Runs on a tokio worker (the page's thread
/// in a browser).
pub type FrameFn = Arc<dyn Fn(&Frame, &str) + Send + Sync>;
/// A heartbeat's server time in unix seconds, with the connection's label.
pub type PingFn = Arc<dyn Fn(f64, &str) + Send + Sync>;

pub struct StreamSpec {
    pub name: &'static str,
    /// Read at every connection, so a reconnect or handover takes the current mode.
    pub url: UrlFn,
    pub wanted_topics: usize,
    pub on_frame: FrameFn,
    pub on_ping: PingFn,
    pub reconnect_delay: Duration,
}

#[derive(Default)]
struct State {
    failures: u32,
    /// The connection in use, and one taking over from it.
    active: Option<(u64, Cancel)>,
    pending: Option<(u64, Cancel)>,
    retry: Option<crate::exec::Task>,
    active_label: String,
    next_id: u64,
}

struct Shared {
    spec: StreamSpec,
    proxy: Arc<ProxyState>,
    state: Mutex<State>,
    health: Arc<Health>,
    stop: Cancel,
}

fn lock(m: &Mutex<State>) -> std::sync::MutexGuard<'_, State> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A stream kept open until [`Stream::stop`].
#[derive(Clone)]
pub struct Stream(Arc<Shared>);

impl Stream {
    /// Keep one stream open until stopped, reconnecting with backoff.
    pub fn open(spec: StreamSpec, proxy: Arc<ProxyState>, health: Arc<Health>) -> Self {
        health.up.store(false, Ordering::Relaxed);
        health.started.store(true, Ordering::Relaxed);
        let shared = Arc::new(Shared {
            spec,
            proxy,
            state: Mutex::new(State::default()),
            health,
            stop: Cancel::default(),
        });
        connect(&shared, false);
        Self(shared)
    }

    /// Open a second connection; the first closes once the new one is up.
    pub fn handover(&self) {
        connect(&self.0, true);
    }

    pub fn stop(&self) {
        self.0.stop.cancel();
        self.0.health.up.store(false, Ordering::Relaxed);
        let mut state = lock(&self.0.state);
        if let Some(retry) = state.retry.take() {
            retry.abort();
        }
        if let Some((_, cancel)) = state.pending.take() {
            cancel.cancel();
        }
        if let Some((_, cancel)) = state.active.take() {
            cancel.cancel();
        }
    }
}

fn later(shared: &Arc<Shared>, handover: bool) {
    if shared.stop.is_cancelled() {
        return;
    }
    let mut state = lock(&shared.state);
    if let Some(retry) = state.retry.take() {
        retry.abort();
    }
    let base = shared.spec.reconnect_delay;
    let delay = base
        .saturating_mul(2u32.saturating_pow(state.failures))
        .min(BACKOFF_MAX);
    log::info!(target: "sse",
        "{} {} 後{}（連續失敗 {} 次）",
        shared.spec.name,
        fmt_dur(delay),
        if handover { "再試交接" } else { "重連" },
        state.failures + 1
    );
    state.failures += 1;
    let again = shared.clone();
    state.retry = Some(crate::exec::spawn(async move {
        crate::exec::sleep(delay).await;
        connect(&again, handover);
    }));
}

fn connect(shared: &Arc<Shared>, handover: bool) {
    if shared.stop.is_cancelled() {
        return;
    }
    let attempt = Cancel::default();
    let id = {
        let mut state = lock(&shared.state);
        state.retry = None;
        state.next_id += 1;
        let id = state.next_id;
        let replaceable = state
            .active
            .as_ref()
            .is_some_and(|(_, c)| !c.is_cancelled());
        if let Some((_, pending)) = state.pending.take() {
            pending.cancel();
        }
        if handover && replaceable {
            state.pending = Some((id, attempt.clone()));
        } else {
            if let Some((_, active)) = state.active.take() {
                active.cancel();
            }
            state.active = Some((id, attempt.clone()));
        }
        id
    };
    let shared = shared.clone();
    crate::exec::spawn(async move { run_connection(shared, id, attempt).await });
}

async fn run_connection(shared: Arc<Shared>, id: u64, attempt: Cancel) {
    let url = (shared.spec.url)();
    let mut conn = ConnLog::new(shared.spec.name, &url, shared.spec.wanted_topics);
    let waited = Instant::now();

    let outcome = match crate::exec::race(
        read_stream(&shared, id, &url, &mut conn, waited, &attempt),
        attempt.cancelled(),
    )
    .await
    {
        crate::exec::Either::First(result) => Some(result),
        crate::exec::Either::Second(()) => None,
    };

    if let Some(message) = outcome {
        // Entering replay aborts both streams on purpose, and a handover closes the
        // connection it replaced. Neither is a failure: no warning, no reconnect.
        if !attempt.is_cancelled() {
            conn.outcome = Some(message);
        }
    }
    let (was_pending, was_active, label) = {
        let state = lock(&shared.state);
        (
            state.pending.as_ref().is_some_and(|(p, _)| *p == id),
            state.active.as_ref().is_some_and(|(a, _)| *a == id),
            state.active_label.clone(),
        )
    };
    if !attempt.is_cancelled() && !shared.stop.is_cancelled() {
        if was_pending && conn.ready.is_none() {
            log::warn!(target: "sse",
                "交接失敗：新連線 {} 在就緒前就結束，保留目前的連線 {label}",
                conn.label
            );
            lock(&shared.state).pending = None;
            later(&shared, true);
        } else if was_active {
            later(&shared, false);
        }
    }
    // The connection in use ended (not one a handover replaced).
    if lock(&shared.state)
        .active
        .as_ref()
        .is_none_or(|(a, _)| *a == id)
    {
        shared.health.up.store(false, Ordering::Relaxed);
    }
    conn.end();
}

/// Reads until the connection fails, returning why.
async fn read_stream(
    shared: &Arc<Shared>,
    id: u64,
    url: &str,
    conn: &mut ConnLog,
    waited: Instant,
    attempt: &Cancel,
) -> String {
    let target = match shared.proxy.resolve(url) {
        Ok(target) => target,
        Err(e) => return e,
    };
    let request = shared
        .proxy
        .client()
        .get(&target)
        .header("Accept", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .send();
    let Ok(res) = crate::exec::timeout(READY, request).await else {
        return format!("{} 內沒有問候，放棄這條連線", fmt_dur(READY));
    };
    let res = match res {
        Ok(res) => res,
        Err(e) => {
            if !attempt.is_cancelled() {
                shared.proxy.report(&target, false);
            }
            return e.to_string();
        }
    };
    shared.proxy.report(&target, res.status().as_u16() < 500);
    conn.http(&res);
    if !res.status().is_success() {
        return format!("HTTP {}", res.status().as_u16());
    }

    let mut body = res.bytes_stream();
    let mut reader = FrameReader::default();
    let mut frames = Vec::new();
    let opened = Instant::now();
    let mut up = false;
    loop {
        let limit = if up {
            STALE
        } else {
            READY.saturating_sub(opened.elapsed())
        };
        let chunk = match crate::exec::timeout(limit, body.next()).await {
            Ok(Some(Ok(chunk))) => chunk,
            Ok(Some(Err(e))) => {
                if !attempt.is_cancelled() {
                    shared.proxy.report(&target, false);
                }
                return e.to_string();
            }
            Ok(None) => {
                if !attempt.is_cancelled() {
                    shared.proxy.report(&target, false);
                }
                return "stream ended".to_string();
            }
            Err(_) if up => {
                return format!("{} 沒有任何資料（心跳 60s 一次），視為斷線", fmt_dur(STALE));
            }
            Err(_) => return format!("{} 內沒有問候，放棄這條連線", fmt_dur(READY)),
        };
        let is_active = lock(&shared.state)
            .active
            .as_ref()
            .is_some_and(|(a, _)| *a == id);
        if is_active {
            shared
                .health
                .last
                .store(ms_since_start(), Ordering::Relaxed);
        }
        frames.clear();
        reader.push(&chunk, &mut frames);
        for frame in frames.drain(..) {
            if let Some(comment) = frame.comment.as_deref().filter(|c| c.starts_with("ping")) {
                if let Some(server) = conn.ping(comment) {
                    (shared.spec.on_ping)(server, &conn.label);
                }
            }
            if frame.data.is_empty() && frame.event.is_none() {
                continue;
            }
            if !up {
                up = true;
                conn.ready = Some(Instant::now());
                let mut state = lock(&shared.state);
                state.failures = 0;
                if state.pending.as_ref().is_some_and(|(p, _)| *p == id) {
                    log::info!(target: "sse",
                        "交接完成：{} 就緒（等了 {}），關閉舊連線 {}",
                        conn.label,
                        fmt_dur(waited.elapsed()),
                        state.active_label
                    );
                    // Also drops a reconnect the replaced connection had asked for.
                    if let Some(retry) = state.retry.take() {
                        retry.abort();
                    }
                    if let Some((_, active)) = state.active.take() {
                        active.cancel();
                    }
                    state.active = state.pending.take();
                }
                state.active_label = conn.label.clone();
                shared.health.up.store(true, Ordering::Relaxed);
                shared
                    .health
                    .last
                    .store(ms_since_start(), Ordering::Relaxed);
            }
            conn.frame(
                frame.event.as_deref().unwrap_or("message"),
                frame.data.len(),
            );
            if frame.event.as_deref() == Some("info") {
                conn.greeting(&frame.data);
            }
            (shared.spec.on_frame)(&frame, &conn.label);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_block_gives_event_data_and_comment() {
        let frame = parse_frame("event: trem.rts.v1\ndata: abc\ndata: def");
        assert_eq!(frame.event.as_deref(), Some("trem.rts.v1"));
        assert_eq!(frame.data, "abc\ndef");
        let ping = parse_frame(": ping 1790000000");
        assert_eq!(ping.comment.as_deref(), Some("ping 1790000000"));
        assert!(ping.data.is_empty());
    }

    #[test]
    fn the_reader_holds_a_partial_frame_and_drops_carriage_returns() {
        let mut reader = FrameReader::default();
        let mut out = Vec::new();
        reader.push(b"data: a\r\n\r\nda", &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].data, "a");
        out.clear();
        reader.push(b"ta: b\n\n", &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].data, "b");
    }

    #[test]
    fn a_field_with_no_space_after_the_colon_is_read_too() {
        assert_eq!(parse_frame("data:x").data, "x");
    }
}
