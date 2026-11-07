//! The two live streams (features/data/dataHttp.ts `init`): `trem` with rts.v1 and
//! intensity.v1, and `eew` with the agencies' EEWs. A frame is decoded on its stream's
//! worker; only the result reaches the main thread.

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
use crate::net::sse::{Stream, StreamSpec};

const TOPICS: &str = "trem.intensity.v1,trem.rts.v1";
const RECONNECT_DELAY: Duration = Duration::from_secs(3);

/// The two live streams.
pub struct SseManager {
    trem: Option<Stream>,
    eew: Option<Stream>,
    background: Arc<AtomicBool>,
}

impl SseManager {
    pub fn abort(&self) {
        log::info!(target: "sse", "停止即時連線（進入重播或重設）");
        if let Some(stream) = &self.trem {
            stream.stop();
        }
        if let Some(stream) = &self.eew {
            stream.stop();
        }
    }

    pub fn set_background(&self, value: bool) {
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
    pub fn renew(&self) {
        log::info!(target: "sse", "網路恢復：trem 與 eew 各建立新連線，舊的留到交接完成");
        if let Some(stream) = &self.trem {
            stream.handover();
        }
        if let Some(stream) = &self.eew {
            stream.handover();
        }
    }
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

/// Open the live streams. A frame is decoded on the stream's worker; only the result
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
        "啟動即時連線：節點 {LB_API}，trem topic {TOPICS}（{}），eew 為 CWA 預警",
        if data.asleep { "休眠：rts 只收有測站觸發的資料" } else { "live" }
    );
    // Fixture mode and tests never touch the network: the streams stay closed.
    let Some(proxy) = proxy.filter(|_| !fixture::active()) else {
        return SseManager {
            trem: None,
            eew: None,
            background,
        };
    };
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
                        intensity_label(report.max)
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
