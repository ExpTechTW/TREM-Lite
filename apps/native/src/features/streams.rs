//! The live stream (features/data/dataHttp.ts `init`): one connection to the mixed entry
//! `/api/v1/sse` carrying rts.v1 and intensity.v1, the agencies' EEWs (`eq.eew.v1`, the
//! same list `/api/v2/eq/eew` answers) and the earthquake reports (`eq.report.v1`). Data
//! events are named by their topic and carry base64 of gzip. A frame is decoded on the
//! stream's worker; only the result reaches the main thread.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use trem_core::fmt::{fmt_bytes, fmt_dur};
use trem_core::sse::{decode_payload, Frame};
use trem_io::net::{fixture, ProxyState};

use crate::app::{Msg, Post};
use crate::domain::constants::host::LB_API;
use crate::domain::constants::intensity_label;
use crate::domain::types::{read_intensity_xml, RtsV1};
use crate::features::data::{rts_from_v1, DataState};
use crate::features::report::parse_stream_report;
use crate::net::sse::{Stream, StreamSpec};

/// One connection, all four. The server sends them by its own priority (EEWs first, rts.v1
/// last), whatever the order here.
const TOPICS: &str = "trem.intensity.v1,eq.eew.v1,eq.report.v1,trem.rts.v1";
const RECONNECT_DELAY: Duration = Duration::from_secs(3);

/// The live stream.
pub struct SseManager {
    stream: Option<Stream>,
    background: Arc<AtomicBool>,
}

impl SseManager {
    pub fn abort(&self) {
        log::info!(target: "sse", "停止即時連線（進入重播或重設）");
        if let Some(stream) = &self.stream {
            stream.stop();
        }
    }

    /// Asleep, rts.v1 brings only frames with a triggered station; the mode is the URL's,
    /// so it takes a new connection. The other topics come either way.
    pub fn set_background(&self, value: bool) {
        if self.background.swap(value, Ordering::SeqCst) == value {
            return;
        }
        log::info!(
            target: "sse",
            "切成{}模式，建立新連線，舊的留到交接完成",
            if value { "休眠" } else { " live " }
        );
        if let Some(stream) = &self.stream {
            stream.handover();
        }
    }

    /// A network that comes back can leave a connection that looks open and is dead:
    /// take a fresh one at once, keeping the old until it is up.
    pub fn renew(&self) {
        log::info!(target: "sse", "網路恢復：建立新連線，舊的留到交接完成");
        if let Some(stream) = &self.stream {
            stream.handover();
        }
    }
}

/// The stream's URL; `mode=live` unless asleep. Read at every connection.
fn stream_url(asleep: bool) -> String {
    format!(
        "https://{LB_API}/api/v1/sse?topics={TOPICS}{}",
        if asleep { "" } else { "&mode=live" }
    )
}

/// An EEW frame, one clause per EEW: serial, unit, kind, size and place.
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
                intensity_label(
                    eq.and_then(|q| q.get("max"))
                        .and_then(Value::as_i64)
                        .map_or(-1, |m| m as i32)
                ),
            )
        })
        .collect::<Vec<_>>()
        .join("；")
}

/// Open the live stream. A frame is decoded on the stream's worker; only the result
/// reaches the main thread.
pub fn open_streams(
    post: &Post,
    proxy: Option<&Arc<ProxyState>>,
    data: &DataState,
    real_now: Arc<dyn Fn() -> f64 + Send + Sync>,
) -> SseManager {
    let background = Arc::new(AtomicBool::new(data.asleep));
    log::info!(
        target: "sse",
        "啟動即時連線：節點 {LB_API}，topic {TOPICS}（{}）",
        if data.asleep { "休眠：rts 只收有測站觸發的資料" } else { "live" }
    );
    // Fixture mode and tests never touch the network: the stream stays closed.
    let Some(proxy) = proxy.filter(|_| !fixture::active()) else {
        return SseManager {
            stream: None,
            background,
        };
    };
    let url = {
        let background = Arc::clone(&background);
        Arc::new(move || stream_url(background.load(Ordering::SeqCst)))
    };
    let ping_post = post.clone();
    let frame_post = post.clone();
    let stream = Stream::open(
        StreamSpec {
            name: "sse",
            url,
            wanted_topics: TOPICS.split(',').count(),
            on_frame: Arc::new(move |frame: &Frame, label: &str| {
                on_frame(frame, label, &frame_post, &*real_now);
            }),
            on_ping: Arc::new(move |ts, label| {
                ping_post(Msg::StreamPing {
                    ts,
                    label: label.to_string(),
                });
            }),
            reconnect_delay: RECONNECT_DELAY,
        },
        Arc::clone(proxy),
        Arc::clone(&data.sse_health),
    );
    SseManager {
        stream: Some(stream),
        background,
    }
}

/// One event of the stream, by its name. Heartbeats are the connection's.
fn on_frame(frame: &Frame, label: &str, post: &Post, real_now: &dyn Fn() -> f64) {
    match frame.event.as_deref() {
        // The greeting, logged by the connection: the subscription exists from here.
        // Reports are not sent again on connect, so the list is fetched once more to
        // cover the time without one.
        Some("info") => post(Msg::StreamUp),
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
                        intensity_label(report.max)
                    );
                    post(Msg::IntensityFrame(report));
                }
                None => {
                    log::warn!(target: "sse", "{label} trem.intensity.v1 解不開，略過（{bytes}）");
                }
            }
        }
        // The full list of EEWs in force, as `/api/v2/eq/eew?sse=1` sent it: it replaces the
        // last, and `[]` follows the greeting when there is none.
        Some("eq.eew.v1") => {
            let text = decode_payload(&frame.data);
            match serde_json::from_str::<Value>(&text) {
                Ok(parsed) if !parsed.is_null() => {
                    log::info!(
                        target: "sse",
                        "{label} 收到 EEW：{}（{}）",
                        eew_summary(&parsed, real_now()),
                        fmt_bytes(frame.data.len() as u64)
                    );
                    post(Msg::EewFrame(parsed));
                }
                Ok(_) => {}
                Err(_) => {
                    let start: String = text.chars().take(200).collect();
                    log::warn!(target: "sse", "{label} EEW 不是合法的 JSON，略過：{start}");
                }
            }
        }
        Some("eq.report.v1") => {
            let bytes = fmt_bytes(frame.data.len() as u64);
            match parse_stream_report(&decode_payload(&frame.data)) {
                Some((reason, item)) => {
                    log::info!(
                        target: "sse",
                        "{label} 收到 eq.report.v1：{} reason {reason} M{} {} 最大 {}（{bytes}）",
                        item.id,
                        item.mag,
                        item.loc,
                        intensity_label(item.int)
                    );
                    post(Msg::ReportStream {
                        reason,
                        item: Box::new(item),
                    });
                }
                None => {
                    log::warn!(target: "sse", "{label} eq.report.v1 解不開，略過（{bytes}）");
                }
            }
        }
        Some("unsubscribed") => {
            log::warn!(target: "sse", "{label} topic 被伺服器停掉：{}。其他 topic 照收，等下次重連再要", frame.data);
        }
        // The connection ends right after and reconnects as after any other end.
        Some("close") => log::warn!(target: "sse", "{label} 伺服器主動關閉：{}", frame.data),
        other => {
            log::info!(target: "sse", "{label} 略過 app 不認得的 event {}", other.unwrap_or("message"));
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::Mutex;

    use trem_core::sse::FrameReader;

    use super::*;
    use crate::net::sse::ping_seconds;

    const NOW: f64 = 1_790_619_700_000.0;

    fn base64(bytes: &[u8]) -> String {
        const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let n = chunk
                .iter()
                .enumerate()
                .fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
            for i in 0..4 {
                if i <= chunk.len() {
                    out.push(char::from(ABC[((n >> (18 - 6 * i)) & 63) as usize]));
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    /// A data field as the mixed entry sends it: base64 of one gzip member.
    fn compressed(text: &str) -> String {
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(text.as_bytes()).expect("gzip into memory");
        base64(&gz.finish().expect("gzip into memory"))
    }

    fn event(name: &str, data: &str) -> String {
        format!("event: {name}\ndata: {data}\n\n")
    }

    fn describe(msg: &Msg) -> String {
        match msg {
            Msg::StreamUp => "up".to_string(),
            Msg::RtsFrame(rts) => format!("rts {}", rts.time),
            Msg::EewFrame(list) => format!("eew {list}"),
            Msg::IntensityFrame(report) => format!("intensity {}", report.id),
            Msg::ReportStream { reason, item } => {
                format!("report {} reason {reason} int {}", item.id, item.int)
            }
            _ => "other".to_string(),
        }
    }

    /// What the connection does with a body: frames to the dispatch, heartbeats aside.
    /// Read a few bytes at a time, as a network may hand it over.
    fn run(body: &str) -> (Vec<String>, Vec<f64>) {
        let posted = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&posted);
        let post: Post = Arc::new(move |msg| {
            if let Ok(mut sink) = sink.lock() {
                sink.push(describe(&msg));
            }
        });
        let mut reader = FrameReader::default();
        let mut frames = Vec::new();
        for chunk in body.as_bytes().chunks(7) {
            reader.push(chunk, &mut frames);
        }
        let mut pings = Vec::new();
        for frame in &frames {
            if let Some(ts) = frame.comment.as_deref().and_then(ping_seconds) {
                pings.push(ts);
            }
            if frame.data.is_empty() && frame.event.is_none() {
                continue;
            }
            on_frame(frame, "sse#1", &post, &|| NOW);
        }
        let posted = posted.lock().map(|p| p.clone()).unwrap_or_default();
        (posted, pings)
    }

    const XML: &str = r#"<Report><Head><EventID>20260726203641</EventID><InfoType>更新</InfoType><Serial>2</Serial></Head><Body><Area level="2"><Town code="970"/></Area></Body></Report>"#;
    const EEW: &str = r#"[{"author":"cwa","id":"1","serial":1,"status":0,"final":0,"time":1790619690000,"eq":{"time":1790619680000,"lon":121.3,"lat":22.8,"depth":20,"mag":5.1,"loc":"臺東縣近海","max":4}}]"#;
    const REPORT: &str = r#"{"reason":1,"data":{"id":"115079-2026-1109-122157","lat":23.62,"lon":120.66,"depth":10.5,"loc":"雲林縣古坑鄉","mag":4.2,"time":1794198117000,"list":{"雲林縣":{"int":3,"town":{"草嶺":{"lat":23.6,"lon":120.68,"int":3}}},"嘉義縣":{"int":2,"town":{}}}}}"#;

    #[test]
    fn one_connection_brings_every_topic_by_its_event_name() {
        let body = [
            "retry: 3000\n\n".to_string(),
            event(
                "info",
                r#"{"location":"lb-test","topics":["eq.eew.v1","trem.intensity.v1","eq.report.v1","trem.rts.v1"],"anonymous":true}"#,
            ),
            event("eq.eew.v1", &compressed("[]")),
            event("trem.rts.v1", &compressed(r#"{"ts":1790619699000,"stations":{}}"#)),
            event("trem.intensity.v1", &compressed(XML)),
            event("eq.eew.v1", &compressed(EEW)),
            event("eq.report.v1", &compressed(REPORT)),
            ": ping 1790619700\n\n".to_string(),
            event("unsubscribed", r#"{"topic":"trem.rts.v1","reason":"quota exceeded"}"#),
            event("trem.eew.v9", &compressed("{}")),
            event("close", "server shutting down"),
        ]
        .concat();
        let (posted, pings) = run(&body);
        let eew: Value = serde_json::from_str(EEW).unwrap_or_default();
        assert_eq!(
            posted,
            [
                "up".to_string(),
                "eew []".to_string(),
                "rts 1790619699000".to_string(),
                "intensity 1785069401000".to_string(),
                format!("eew {eew}"),
                // Its maximum is its cities' highest.
                "report 115079-2026-1109-122157 reason 1 int 3".to_string(),
            ]
        );
        assert_eq!(pings, [1_790_619_700.0]);
    }

    #[test]
    fn a_data_field_that_does_not_decode_is_dropped() {
        let body = [
            event("eq.eew.v1", "H4sIAAAA"),
            event("eq.eew.v1", &compressed("not json")),
            event("eq.report.v1", &compressed(r#"{"data":{"id":"x"}}"#)),
            event(
                "eq.report.v1",
                &compressed(r#"{"reason":0,"data":{"id":""}}"#),
            ),
            event("trem.intensity.v1", &compressed("<Report/>")),
            event("trem.rts.v1", "@@@"),
        ]
        .concat();
        assert_eq!(run(&body), (Vec::new(), Vec::new()));
    }

    #[test]
    fn a_heartbeat_is_unix_seconds() {
        assert_eq!(ping_seconds("ping 1790619700"), Some(1_790_619_700.0));
        assert_eq!(ping_seconds("ping"), None);
        assert_eq!(ping_seconds("ping -1"), None);
        assert_eq!(ping_seconds("hello"), None);
    }

    #[test]
    fn the_url_asks_for_all_four_topics_and_live_only_when_awake() {
        let base = format!(
            "https://{LB_API}/api/v1/sse?topics=trem.intensity.v1,eq.eew.v1,eq.report.v1,trem.rts.v1"
        );
        assert_eq!(stream_url(false), format!("{base}&mode=live"));
        assert_eq!(stream_url(true), base);
        assert_eq!(TOPICS.split(',').count(), 4);
    }

    #[test]
    fn with_no_network_the_stream_stays_closed() {
        let posted = Arc::new(Mutex::new(0));
        let count = Arc::clone(&posted);
        let post: Post = Arc::new(move |_| {
            if let Ok(mut count) = count.lock() {
                *count += 1;
            }
        });
        let sse = open_streams(&post, None, &DataState::new(), Arc::new(|| NOW));
        assert!(sse.stream.is_none());
        sse.set_background(true);
        sse.renew();
        sse.abort();
        assert_eq!(posted.lock().map(|c| *c).unwrap_or(1), 0);
    }
}
