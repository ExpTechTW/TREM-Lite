//! Everything on the bus goes into the log (features/log/eventLog.ts): first, so the log
//! shows what happened before what each module did about it. RTS frames come twice a
//! second, so only a change of trigger state is logged, and a line a minute.

use web_time::Instant;

use trem_core::region;

use crate::app::App;
use crate::domain::constants::intensity_label;
use crate::domain::types::{Area, EewData, ReportListItem, RtsData};
use crate::domain::utils::when;
use crate::events::Event;

pub struct EventLogState {
    frames: u32,
    window_start: Instant,
    last_key: String,
    /// Whether a first live frame has come since the app started.
    had_data: bool,
}

impl Default for EventLogState {
    fn default() -> Self {
        Self {
            frames: 0,
            window_start: Instant::now(),
            last_key: String::new(),
            had_data: false,
        }
    }
}

fn eew_text(mode: &str, kind: &str, e: &EewData) -> String {
    let status = match e.status {
        0 => "預警".to_string(),
        1 => "警報".to_string(),
        3 => "取消".to_string(),
        other => format!("status {other}"),
    };
    [
        format!("{mode}{kind} {} 第 {} 報", e.id, e.serial),
        format!(
            "{} {status}{}",
            e.author,
            if e.is_final { "（最終報）" } else { "" }
        ),
        format!("{} ({}, {})", e.eq.loc, e.eq.lat, e.eq.lon),
        format!("M{} 深 {} km", e.eq.mag, e.eq.depth),
        format!("預估最大 {}", intensity_label(e.eq.max)),
        format!("發震 {}", when(e.eq.time)),
    ]
    .join("｜")
}

/// How many towns at each level, naming the places at the highest.
fn areas(area: &Area) -> String {
    let mut levels: Vec<&(i32, Vec<i32>)> = area.iter().collect();
    levels.sort_by_key(|level| std::cmp::Reverse(level.0));
    let Some(top) = levels.first() else {
        return "無區域資料".to_string();
    };
    let counts: Vec<String> = levels
        .iter()
        .map(|(i, codes)| format!("{}×{}", intensity_label(*i), codes.len()))
        .collect();
    let names: Vec<String> = top
        .1
        .iter()
        .take(12)
        .map(|code| {
            let name = region::town_name(*code);
            if name.is_empty() {
                code.to_string()
            } else {
                name
            }
        })
        .collect();
    let more = if top.1.len() > 12 {
        format!(" 等 {} 處", top.1.len())
    } else {
        String::new()
    };
    format!(
        "{}｜{}：{}{more}",
        counts.join(" "),
        intensity_label(top.0),
        names.join("、")
    )
}

fn report_text(r: &ReportListItem, update: bool) -> String {
    [
        format!("地震報告{} {}", if update { "（修正）" } else { "" }, r.id),
        format!("{} ({}, {})", r.loc, r.lat, r.lon),
        format!("M{} 深 {} km", r.mag, r.depth),
        format!("最大 {}", intensity_label(r.int)),
        format!("發震 {}", when(r.time)),
    ]
    .join("｜")
}

impl App {
    fn log_rts(&mut self, rts: Option<&RtsData>) {
        let Some(rts) = rts else {
            if !self.event_log.last_key.is_empty() {
                log::info!(target: "event", "RTS 清空（模式切換或資料重設）");
            }
            self.event_log.last_key.clear();
            return;
        };
        self.event_log.frames += 1;
        let boxes = rts.boxes.len();
        // No boxes, as is usual: the stations are not walked for the log.
        let alerted: Vec<_> = if boxes > 0 {
            rts.station.iter().filter(|(_, s)| s.alert).collect()
        } else {
            Vec::new()
        };
        let max_i = alerted
            .iter()
            .fold(f64::NEG_INFINITY, |m, (_, s)| m.max(s.i))
            .max(-1.0);
        let max_pga = alerted.iter().fold(0.0_f64, |m, (_, s)| m.max(s.pga));
        let key = if boxes > 0 {
            format!(
                "{}|{}|{}|{boxes}",
                alerted.len(),
                max_i.round(),
                max_pga.round()
            )
        } else {
            "0|-1|0|0".to_string()
        };
        if key != self.event_log.last_key {
            if alerted.is_empty() {
                if !self.event_log.last_key.is_empty() && !self.event_log.last_key.starts_with("0|")
                {
                    log::info!(target: "event", "RTS 觸發結束，沒有測站在警戒中");
                }
            } else {
                let mut sorted = alerted.clone();
                sorted.sort_by(|a, b| b.1.i.total_cmp(&a.1.i).then(b.1.pga.total_cmp(&a.1.pga)));
                let top: Vec<String> = sorted
                    .iter()
                    .take(5)
                    .map(|(id, st)| {
                        let place = self
                            .var
                            .station
                            .as_ref()
                            .and_then(|list| list.get(id))
                            .map(|at| region::town_name(at.code))
                            .filter(|n| !n.is_empty())
                            .unwrap_or_else(|| "?".to_string());
                        format!("{id} {place} 震度 {:.1} PGA {:.1}", st.i, st.pga)
                    })
                    .collect();
                log::info!(
                    target: "event",
                    "RTS 觸發 {} 站｜最大震度 {max_i:.1}｜最大 PGA {max_pga:.1} gal｜警戒框 {boxes} 區｜{}",
                    alerted.len(),
                    top.join("；")
                );
            }
            self.event_log.last_key = key;
        }
        if self.event_log.window_start.elapsed().as_secs() >= 60 {
            let lag = if rts.time != 0.0 {
                format!(
                    "{:.1}",
                    (chrono::Utc::now().timestamp_millis() as f64 - rts.time) / 1000.0
                )
            } else {
                "?".to_string()
            };
            log::debug!(
                target: "event",
                "RTS 近 {} 秒 {} 筆｜回報測站 {}｜觸發 {}｜資料時間 {}（落後 {lag} 秒）",
                self.event_log.window_start.elapsed().as_secs(),
                self.event_log.frames,
                rts.station.len(),
                alerted.len(),
                when(rts.time)
            );
            self.event_log.frames = 0;
            self.event_log.window_start = Instant::now();
        }
    }

    pub fn log_on(&mut self, ev: &Event) {
        let mode = match self.var.play_mode {
            2 => "〔報告重播〕",
            3 => "〔檔案重播〕",
            _ => "",
        };
        match ev {
            Event::MapLoad => log::info!(target: "event", "地圖載入完成"),
            Event::MainWindowHidden(hidden) => {
                log::info!(target: "event", "{}", if *hidden { "主視窗隱藏" } else { "主視窗顯示" });
            }
            Event::InternetErrorChange(down) => {
                // The flag is up from the start until the first frame: not a drop.
                if !self.event_log.had_data {
                    log::info!(target: "event", "{}", if *down { "等待第一筆即時資料" } else { "收到第一筆即時資料" });
                    self.event_log.had_data = !*down;
                } else if *down {
                    log::warn!(target: "event", "超過時限沒有收到即時資料，顯示斷線警告");
                } else {
                    log::info!(target: "event", "即時資料恢復，斷線警告解除");
                }
            }
            Event::UpdateReady(label) => {
                log::info!(target: "event", "更新 {label} 已下載，等重新啟動套用");
            }
            Event::FocusLockChange(locked) => {
                log::debug!(target: "event", "{}", if *locked { "使用者移動了地圖，自動聚焦暫停" } else { "自動聚焦恢復" });
            }
            Event::DataRts(rts) => self.log_rts(rts.as_deref()),
            Event::DataModeReset => log::info!(target: "event", "即時／重播切換，清除所有事件狀態"),
            Event::EewRelease(e) => {
                log::info!(target: "event", "{}", eew_text(mode, "地震預警 發布", e))
            }
            Event::EewUpdate(e) => {
                log::info!(target: "event", "{}", eew_text(mode, "地震預警 更新", e))
            }
            Event::EewAlert(e) => {
                log::warn!(target: "event", "{}", eew_text(mode, "地震預警 升級為警報", e))
            }
            Event::EewCancel(e) => {
                log::warn!(target: "event", "{}", eew_text(mode, "地震預警 取消", e))
            }
            Event::EewEnd(e) => {
                log::info!(target: "event", "{}", eew_text(mode, "地震預警 結束", e))
            }
            Event::EewNewAreaAlert(cities) => {
                log::warn!(target: "event", "預警新增警報區域：{}", cities.join("、"));
            }
            Event::IntensityRelease(d) => log::info!(
                target: "event",
                "{mode}震度速報 發布 {}｜最大 {}｜{}",
                d.id,
                intensity_label(d.max),
                areas(&d.area)
            ),
            Event::IntensityUpdate(d) => log::info!(
                target: "event",
                "{mode}震度速報 更新 {}｜最大 {}｜{}",
                d.id,
                intensity_label(d.max),
                areas(&d.area)
            ),
            Event::IntensityEnd(d) => log::info!(target: "event", "{mode}震度速報 結束 {}", d.id),
            Event::LpgmRelease(d) => log::info!(
                target: "event",
                "{mode}長週期地震動 {}｜{} 站｜最大階級 {}",
                d.id,
                d.list.len(),
                d.list.iter().map(|l| l.lpgm).max().unwrap_or(0).max(0)
            ),
            Event::ReportRelease { data, update } => {
                log::info!(target: "event", "{mode}{}", report_text(data, *update));
            }
            Event::ReportSpeechEnd(id) => log::debug!(target: "event", "報告 {id} 的語音播報結束"),
            Event::ReportListUpdate => {
                log::debug!(target: "event", "報告列表更新，共 {} 筆", self.var.data.report.len());
            }
            Event::ReplayStateChange { active, report_id } => {
                if *active {
                    log::info!(
                        target: "event",
                        "重播開始{}",
                        report_id
                            .as_ref()
                            .map_or_else(|| "（檔案）".to_string(), |id| format!("（報告 {id}）"))
                    );
                } else {
                    log::info!(target: "event", "重播結束，回到即時");
                }
            }
            Event::RtsShindo0 => log::info!(target: "event", "測站警報音：測站開始觸發"),
            Event::RtsShindo1 => log::info!(target: "event", "測站警報音：測站震度 2 以上"),
            Event::RtsShindo2 => log::warn!(target: "event", "測站警報音：測站震度 4 以上"),
            Event::RtsPga1 => log::info!(target: "event", "測站警報音：測站加速度超過 8 gal"),
            Event::RtsPga2 => log::warn!(target: "event", "測站警報音：測站加速度超過 200 gal"),
            // Too frequent, and with nothing to say: the card rotates every 5 s.
            Event::EewDisplayUpdate => {}
        }
    }
}
