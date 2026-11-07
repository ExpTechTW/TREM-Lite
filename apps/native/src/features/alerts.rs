//! What reaches the senses: sound routing (lib/audioClient.ts), system notifications
//! (lib/notificationClient.ts) and speech (lib/speechClient.ts).

use std::collections::HashMap;

use crate::app::App;
use crate::domain::constants::INTENSITY_LIST;
use crate::domain::region;
use crate::domain::types::{EewData, LpgmData, ReportListItem, StationId};
use crate::domain::utils::{chinese_time, extract_location, format_timestamp, int_to_string};
use crate::events::Event;
use crate::timers::Task;

/// How long an update is shown when there is no speech to wait for.
const UNSPOKEN_UPDATE_MS: f64 = 15_000.0;

struct EewSpeech {
    last_loc: String,
    last_intensity: i32,
    loc: String,
    intensity: i32,
}

#[derive(Default)]
pub struct SpeechState {
    cache: Vec<(String, EewSpeech)>,
    pub area_alert_speaking: bool,
}

fn pronunciation(text: &str) -> String {
    text.replacen("2.", "二點", 1)
        .replace(".2", "點二")
        .replace("三地門", "三弟門")
        .replace('.', "點")
        .replace('為', "圍")
}

fn label(level: i32) -> String {
    usize::try_from(level)
        .ok()
        .and_then(|l| INTENSITY_LIST.get(l))
        .map_or_else(|| level.to_string(), |s| (*s).to_string())
}

fn add_place(places: &mut Vec<String>, name: &str) {
    if !places.iter().any(|p| p == name) {
        places.push(name.to_string());
    }
}

/// What a finished utterance tells the app.
#[derive(Clone, Debug, PartialEq)]
pub enum SpeechEnd {
    None,
    AreaAlert,
    ReportUpdate(String),
}

impl App {
    fn sfx(&self, key: &str) -> bool {
        let on = self.config.checked(key);
        if !on {
            log::debug!(target: "audio", "音效設定 {key} 關閉，這次不播");
        }
        on
    }

    fn enqueue(&self, queue: &str, sound: &str) {
        log::info!(target: "audio", "音效排入 {queue} 佇列：{sound}");
        // Fixture data is a test: logged, not heard.
        if !crate::net::fixture::active() {
            self.audio.enqueue(queue, sound);
        }
    }

    fn play(&self, sound: &str) {
        log::info!(target: "audio", "播放音效：{sound}");
        if !crate::net::fixture::active() {
            self.audio.play_direct(sound);
        }
    }

    pub fn audio_stop_all(&self) {
        log::info!(target: "audio", "停止所有音效（播放中與排隊中的）");
        self.audio.stop_all();
    }

    pub fn audio_preview(&self, sound: &str) {
        log::info!(target: "audio", "試聽音效：{sound}");
        self.audio.preview(sound);
    }

    pub fn audio_on(&mut self, ev: &Event) {
        match ev {
            Event::EewRelease(data) => {
                if data.status == 1 {
                    if self.sfx("sound-effects-EEW2") {
                        self.enqueue("eew", "ALERT");
                    }
                } else if self.sfx("sound-effects-EEW") {
                    self.enqueue("eew", "EEW");
                }
            }
            Event::EewAlert(_) => {
                if self.sfx("sound-effects-EEW2") {
                    self.enqueue("eew", "ALERT");
                }
            }
            Event::EewUpdate(_) => {
                log::debug!(target: "audio", "清空 update 佇列裡還沒播的音效");
                self.audio.clear("update");
                if self.sfx("sound-effects-Update") {
                    self.enqueue("update", "UPDATE");
                }
            }
            Event::RtsPga2 => {
                if self.sfx("sound-effects-PGA2") {
                    self.enqueue("pga", "PGA2");
                }
            }
            Event::RtsPga1 => {
                if self.sfx("sound-effects-PGA1") {
                    self.enqueue("pga", "PGA1");
                }
            }
            Event::RtsShindo2 => {
                if self.sfx("sound-effects-Shindo2") {
                    self.enqueue("shindo", "SHINDO2");
                }
            }
            Event::RtsShindo1 => {
                if self.sfx("sound-effects-Shindo1") {
                    self.enqueue("shindo", "SHINDO1");
                }
            }
            Event::RtsShindo0 => {
                if self.sfx("sound-effects-Shindo0") {
                    self.enqueue("shindo", "SHINDO0");
                }
            }
            Event::ReportRelease { .. } => {
                if self.sfx("sound-effects-Report") {
                    self.play("REPORT");
                }
            }
            Event::LpgmRelease(_) | Event::IntensityRelease(_) | Event::IntensityUpdate(_)
                if self.sfx("sound-effects-PAlert") =>
            {
                self.play("INTENSITY");
            }
            _ => {}
        }
    }

    // ---- Notifications ----------------------------------------------------

    /// Supplementary: a denied permission must not affect the alerts.
    fn notify(&self, title: String, body: String) {
        log::info!(target: "notify", "系統通知：{title}｜{}", body.replace('\n', " "));
        if crate::net::fixture::active() {
            return;
        }
        // Its own thread: a system that never answers strands only this notification.
        let spawned = std::thread::Builder::new()
            .name("notify".into())
            .spawn(move || crate::platform::notify::send(&title, &body));
        if let Err(err) = spawned {
            log::warn!(target: "notify", "系統通知送不出去：{err}");
        }
    }

    fn eew_notice(&self, data: &EewData) {
        let kind = if data.status == 1 {
            "🚨 緊急地震速報"
        } else {
            "⚠️ 地震速報"
        };
        self.notify(
            format!("{kind} {}報", data.serial),
            format!(
                "{} 最大預估 {}\n{} M{} {}km",
                format_timestamp(data.eq.time),
                int_to_string(data.eq.max),
                data.eq.loc,
                data.eq.mag,
                data.eq.depth
            ),
        );
    }

    fn intensity_notice(&self, id: f64, max: i32, area: &crate::domain::types::Area) {
        if self.var.cache.intensity_max >= max {
            return;
        }
        let top = area.iter().map(|(l, _)| *l).max().unwrap_or(0).max(0);
        let mut cities = Vec::new();
        for (level, codes) in area {
            if *level == top {
                for code in codes {
                    if let Some(town) = region::town_of(*code) {
                        add_place(&mut cities, town.city);
                    }
                }
            }
        }
        self.notify(
            format!("📨 震度速報 [{}]", format_timestamp(id)),
            format!("震度{} {}", int_to_string(top), cities.join("、")),
        );
    }

    pub fn notify_on(&mut self, ev: &Event) {
        match ev {
            Event::EewRelease(data) | Event::EewUpdate(data) => self.eew_notice(data),
            Event::EewCancel(data) => self.notify(
                format!("⚠️ 地震速報 {}報（取消）", data.serial),
                format!(
                    "{} 最大預估不明\n{}",
                    format_timestamp(data.eq.time),
                    data.eq.loc
                ),
            ),
            Event::RtsShindo2 => self.notify("🟥 強震檢測".into(), "請注意今後的資訊。".into()),
            Event::RtsShindo1 => self.notify("🟧 震動檢測".into(), "請注意今後的資訊。".into()),
            Event::RtsShindo0 => self.notify("🟩 弱反應".into(), "請注意今後的資訊。".into()),
            Event::ReportRelease { data, update } => {
                let (mut intensity, mut county) = (0, "");
                for (name, value) in &data.list.0 {
                    if value.int > intensity {
                        intensity = value.int;
                        county = name;
                    }
                }
                let id = data.id.split('-').next().unwrap_or("");
                let label = if id.contains("000") {
                    "小區域有感地震"
                } else {
                    id
                };
                self.notify(
                    format!(
                        "🔔 {} [{label}]",
                        if *update {
                            "地震報告更新"
                        } else {
                            "地震報告"
                        }
                    ),
                    format!(
                        "{} {} M{:.1}，{county}最大震度{}。",
                        format_timestamp(data.time),
                        data.loc,
                        data.mag,
                        int_to_string(intensity)
                    ),
                );
            }
            Event::IntensityRelease(d) | Event::IntensityUpdate(d) => {
                self.intensity_notice(d.id, d.max, &d.area);
            }
            Event::LpgmRelease(data) => {
                let (mut max, mut city) = (0, String::new());
                for item in &data.list {
                    if item.lpgm <= max {
                        continue;
                    }
                    let town = StationId::new(&item.id)
                        .and_then(|id| {
                            self.var
                                .legacy_station
                                .as_ref()
                                .and_then(|l| l.get(&id).copied())
                        })
                        .and_then(|at| region::town_of(at.code));
                    max = item.lpgm;
                    if let Some(town) = town {
                        city = town.city.to_string();
                    }
                }
                self.notify(
                    "🔔 長週期地震動".into(),
                    format!("{city}觀測到最大長週期地震動階級{max}。"),
                );
            }
            _ => {}
        }
    }

    // ---- Speech -----------------------------------------------------------

    fn speech_enabled(&self) -> bool {
        self.speech.available() && self.config.checked("other-tts")
    }

    fn speak(&mut self, text: &str, queue: bool, end: SpeechEnd) {
        if !self.speech_enabled() {
            log::debug!(
                target: "speech",
                "語音{}，不念：{text}",
                if self.speech.available() { "設定關閉" } else { "在這個環境無法使用" }
            );
            return;
        }
        log::info!(
            target: "speech",
            "語音{}：{text}",
            if queue { "" } else { "（插隊，先停掉正在念的）" }
        );
        self.speech.speak(text, queue, end);
    }

    /// Drop what is being said and what is queued, at a live/replay boundary.
    pub fn speech_stop(&mut self) {
        log::info!(target: "speech", "停止語音（念到一半的與排隊中的）");
        self.speech.stop();
    }

    /// An utterance ended, spoken or cut off.
    pub fn speech_ended(&mut self, end: SpeechEnd) {
        match end {
            SpeechEnd::None => {}
            SpeechEnd::AreaAlert => self.speech_state.area_alert_speaking = false,
            SpeechEnd::ReportUpdate(id) => self.emit(Event::ReportSpeechEnd(id)),
        }
    }

    fn announce_report(&mut self, data: &ReportListItem, update: bool) {
        let mut stations: HashMap<i32, Vec<String>> = HashMap::new();
        let mut maximum = 0;
        for (county, city) in &data.list.0 {
            maximum = maximum.max(city.int);
            for (town, info) in &city.town.0 {
                stations
                    .entry(info.int)
                    .or_default()
                    .push(format!("{county}{town}"));
            }
        }
        let mut text = [
            if update {
                "地震報告更新"
            } else {
                "地震報告"
            }
            .to_string(),
            chinese_time(data.time),
            format!("發生最大震度 {} 地震", int_to_string(maximum)),
            format!("震央位於 {}", extract_location(&data.loc)),
            format!("震央深度為 {}公里", data.depth),
            format!("地震規模為 {:.1}", data.mag),
        ]
        .join("，");
        let mut described = 0;
        for intensity in (1..=9).rev() {
            if described >= 3 {
                break;
            }
            let Some(places) = stations.get(&intensity).filter(|p| !p.is_empty()) else {
                continue;
            };
            let lead = match described {
                0 => "這次地震，最大",
                1 => "此外",
                _ => "",
            };
            text.push_str(&format!(
                "，{lead}震度 {} 地區 {}",
                int_to_string(intensity),
                places.join("，")
            ));
            described += 1;
        }
        let end = if update {
            SpeechEnd::ReportUpdate(data.id.clone())
        } else {
            SpeechEnd::None
        };
        self.speak(&pronunciation(&text), false, end);
    }

    fn announce_lpgm(&mut self, data: &LpgmData) {
        let mut stations: HashMap<i32, Vec<String>> = HashMap::new();
        let (mut maximum, mut max_city) = (0, "");
        for item in &data.list {
            if item.lpgm == 0 {
                continue;
            }
            let town = StationId::new(&item.id)
                .and_then(|id| {
                    self.var
                        .legacy_station
                        .as_ref()
                        .and_then(|l| l.get(&id).copied())
                })
                .and_then(|at| region::town_of(at.code));
            let Some(town) = town else {
                continue;
            };
            stations
                .entry(item.lpgm)
                .or_default()
                .push(format!("{}{}", town.city, town.town));
            if item.lpgm > maximum {
                maximum = item.lpgm;
                max_city = town.city;
            }
        }
        let mut text = format!(
            "長週期地震動觀測資訊，{}，{max_city}觀測到最大長週期地震動階級{maximum}",
            chinese_time(data.id)
        );
        let mut described = 0;
        for level in (1..=4).rev() {
            if described >= 3 {
                break;
            }
            let Some(places) = stations.get(&level).filter(|p| !p.is_empty()) else {
                continue;
            };
            let lead = match described {
                0 => "這次地震，最大",
                1 => "此外",
                _ => "",
            };
            text.push_str(&format!(
                "，{lead}長週期地震動階級 {level} 地區 {}",
                places.join("，")
            ));
            described += 1;
        }
        self.speak(&pronunciation(&text), false, SpeechEnd::None);
    }

    fn announce_intensity(&mut self, max: i32, area: &crate::domain::types::Area) {
        if self.var.cache.intensity_max >= max {
            return;
        }
        let top = area.iter().map(|(l, _)| *l).fold(max, i32::max);
        let mut cities = Vec::new();
        for (level, codes) in area {
            if *level == top {
                for code in codes {
                    if let Some(town) = region::town_of(*code) {
                        add_place(&mut cities, town.city);
                    }
                }
            }
        }
        let places = if cities.is_empty() {
            String::new()
        } else {
            format!("，{}", cities.join("、"))
        };
        self.speak(
            &format!("震度速報，震度{}{places}", label(top)),
            true,
            SpeechEnd::None,
        );
    }

    fn speech_set(&mut self, data: &EewData) {
        match self
            .speech_state
            .cache
            .iter_mut()
            .find(|(id, _)| *id == data.id)
        {
            Some((_, state)) => {
                state.loc.clone_from(&data.eq.loc);
                state.intensity = data.eq.max;
            }
            None => self.speech_state.cache.push((
                data.id.clone(),
                EewSpeech {
                    last_loc: String::new(),
                    last_intensity: -1,
                    loc: data.eq.loc.clone(),
                    intensity: data.eq.max,
                },
            )),
        }
    }

    pub fn speech_on(&mut self, ev: &Event) {
        match ev {
            Event::EewRelease(data) => {
                self.speech_state.cache.retain(|(id, _)| *id != data.id);
                self.speech_set(data);
            }
            Event::EewUpdate(data) => self.speech_set(data),
            Event::EewEnd(data) => self.speech_state.cache.retain(|(id, _)| *id != data.id),
            Event::EewNewAreaAlert(cities) => {
                if !self.speech_enabled() {
                    return;
                }
                self.speech_state.area_alert_speaking = true;
                self.speak(
                    &format!("緊急地震速報，{}，慎防強烈搖晃", cities.join("、")),
                    false,
                    SpeechEnd::AreaAlert,
                );
            }
            Event::IntensityRelease(d) | Event::IntensityUpdate(d) => {
                self.announce_intensity(d.max, &d.area);
            }
            // An update stays on the map until its announcement ends, so the end is always
            // reported: when spoken, when cut off, or after as long as reading would take.
            Event::ReportRelease { data, update } => {
                if !self.speech_enabled() {
                    if *update {
                        self.timers
                            .timeout(UNSPOKEN_UPDATE_MS, Task::SpeechDone(data.id.clone()));
                    }
                    return;
                }
                self.announce_report(data, *update);
            }
            Event::LpgmRelease(data) => self.announce_lpgm(data),
            _ => {}
        }
    }

    /// Every 3 s, an EEW's place and its predicted maximum, when they rise.
    pub fn speech_tick(&mut self) {
        if !self.speech_enabled() || self.speech_state.area_alert_speaking {
            return;
        }
        let mut lines = Vec::new();
        for (_, state) in &mut self.speech_state.cache {
            if state.intensity <= state.last_intensity {
                continue;
            }
            if state.loc != state.last_loc {
                state.last_loc.clone_from(&state.loc);
                lines.push(format!("{}發生地震", state.loc));
            }
            state.last_intensity = state.intensity;
            let intensity = if state.intensity == 0 {
                "不明".to_string()
            } else {
                label(state.intensity).replace('⁻', "弱").replace('⁺', "強")
            };
            lines.push(format!("預估最大震度{intensity}"));
        }
        for line in lines {
            self.speak(&line, true, SpeechEnd::None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_and_names_are_spoken_as_written_in_the_legacy_table() {
        assert_eq!(pronunciation("2.5"), "二點5");
        assert_eq!(pronunciation("M4.2 為"), "M4點二 圍");
        assert_eq!(pronunciation("三地門鄉 5.1"), "三弟門鄉 5點1");
    }
}
