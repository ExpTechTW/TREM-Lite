//! The report list, the report on the idle map, and a report's replay
//! (features/report/report.ts, features/replay/replay.ts).
//!
//! The list is fetched at start and again on each connection of the live stream, which
//! sends no reports from before it; in between, the stream's `eq.report.v1` keeps it
//! current. Nothing polls.

use std::rc::Rc;

use serde::Deserialize;
use trem_io::net::ProxyRequest;

use crate::app::{App, Msg};
use crate::backend::config::IdleMap;
use crate::domain::constants::host::CORE_API;
use crate::domain::constants::{timeout, REPORT_LIMIT};
use crate::domain::types::ReportListItem;
use crate::domain::utils::text_hash;
use crate::events::Event;
use crate::map::icons::IconId;
use crate::map::scene::Symbol;
use crate::timers::{Task, TimerId};
use crate::variable::{Coord, Replay};

/// Each report is remembered by id, with a key of what makes it that earthquake. An id
/// not seen before is new; a seen id whose key changed is an update. Only an earthquake
/// under 48 h old is released either way; a stream message with reason 3 that is older is
/// maintenance re-sending an old report, and is dropped.
const SEEN_LIMIT: usize = 200;
const FRESH_MS: f64 = 48.0 * 60.0 * 60.0 * 1000.0;
/// How long a replay runs. A shake report, the longest lived, ends 600 s after its shake.
const REPLAY_MAX_MS: f64 = 600_000.0;

/// What a fetched report is for.
#[derive(Debug)]
pub enum ReportFetch {
    List,
    Seed {
        epoch: u64,
    },
    /// `fallback`: what the stream sent, released should the report not be stored yet.
    Release {
        epoch: u64,
        update: bool,
        fallback: Option<Box<ReportListItem>>,
    },
    EndUpdate,
}

#[derive(Default)]
pub struct ReportState {
    started: bool,
    active_replay: Option<String>,
    latest_full: Vec<Rc<ReportListItem>>,
    replay_epoch: u64,
    seeded: bool,
    seen: Vec<(String, String)>,
    /// Reports the stream sent in real time (reason 0) and not yet stored, with their
    /// [`headline`]: a fetched list lacks them, and the stored copy that follows may
    /// differ in its coordinates and towns.
    provisional: Vec<(String, String)>,
    last_list: Option<u64>,
    plotted: Option<Rc<ReportListItem>>,
    fitted_at: Option<(i64, i64, i64)>,
    /// An update shown until its announcement ends.
    update_on_show: Option<String>,
    auto_zoom: bool,
    time_limit: Option<TimerId>,
}

fn report_key(r: &ReportListItem) -> String {
    format!("{}|{}|{}|{}|{}", r.time, r.lat, r.lon, r.depth, r.mag)
}

/// What a stored report must change from its real-time version to be an update of it.
/// Its coordinates are rounded to two places and its towns come from another source.
fn headline(r: &ReportListItem) -> String {
    format!("{}|{}", r.time, r.mag)
}

/// Put `item` into a list kept newest first and at most REPORT_LIMIT long.
fn place(list: &mut Vec<Rc<ReportListItem>>, item: Rc<ReportListItem>) {
    let at = list
        .iter()
        .position(|r| r.time < item.time)
        .unwrap_or(list.len());
    list.insert(at, item);
    list.truncate(REPORT_LIMIT as usize);
}

/// An `eq.report.v1` message, `{"reason":0-3,"data":{…}}`. `data` is a list item with its
/// towns but no `int`, `md5` or `trem`; the nationwide maximum is its cities' highest.
pub fn parse_stream_report(text: &str) -> Option<(i64, ReportListItem)> {
    #[derive(Deserialize)]
    struct Message {
        reason: i64,
        data: ReportListItem,
    }
    let Message { reason, mut data } = serde_json::from_str(text).ok()?;
    if data.id.is_empty() {
        return None;
    }
    if data.int == 0 {
        data.int = data
            .list
            .0
            .iter()
            .map(|(_, city)| city.int)
            .max()
            .unwrap_or(0);
    }
    Some((reason, data))
}

const CACHE_FILE: &str = "cache.report.json";

impl App {
    fn remember(&mut self, r: &ReportListItem) {
        self.report.seen.retain(|(id, _)| *id != r.id);
        self.report.seen.push((r.id.clone(), report_key(r)));
        while self.report.seen.len() > SEEN_LIMIT {
            self.report.seen.remove(0);
        }
    }

    fn report_fetch(&self, url: String, purpose: ReportFetch) {
        let req = ProxyRequest::get(url.clone(), timeout::REPORT);
        self.host.fetch(req, move |answer| {
            let text = match answer {
                Ok(reply) if reply.ok() => {
                    Some(String::from_utf8_lossy(&reply.body).into_owned())
                }
                Ok(reply) => {
                    log::warn!(target: "report", "地震報告取得失敗（HTTP {}）：{url}", reply.status);
                    None
                }
                Err(err) => {
                    log::warn!(target: "report", "地震報告取得失敗：{url} {err}");
                    None
                }
            };
            Some(Msg::ReportText { purpose, text })
        });
    }

    fn fetch_list(&self) {
        self.report_fetch(
            format!("https://{CORE_API}/api/v2/eq/report?limit={REPORT_LIMIT}"),
            ReportFetch::List,
        );
    }

    fn fetch_detail(&self, id: &str, purpose: ReportFetch) {
        self.report_fetch(format!("https://{CORE_API}/api/v2/eq/report/{id}"), purpose);
    }

    /// Replay hides reports that had not happened yet, but the one that started it is
    /// five seconds newer than the start: its row stays, with its yellow frame.
    fn apply_visible_list(&mut self, list: &[Rc<ReportListItem>]) {
        let start = self.var.replay.start_time;
        let active = self.report.active_replay.as_deref();
        self.var.data.report = if start == 0.0 {
            list.to_vec()
        } else {
            list.iter()
                .filter(|item| item.time < start || Some(item.id.as_str()) == active)
                .cloned()
                .collect()
        };
    }

    fn camera_key(&self) -> (i64, i64, i64) {
        let (lon, lat) = self.map.camera.center();
        (
            (self.map.camera.zoom * 10_000.0).round() as i64,
            (lon * 10_000.0).round() as i64,
            (lat * 10_000.0).round() as i64,
        )
    }

    /// Fit the report, unless the camera is already there or on its way.
    fn fit_report(&mut self) {
        if self.config.checked("graphics-block-auto-zoom") || self.map.is_moving() {
            return;
        }
        let key = self.camera_key();
        if self.report.fitted_at == Some(key) {
            return;
        }
        let bounds = self.var.cache.bounds.report.clone();
        self.update_map_bounds(&bounds);
        self.report.fitted_at = if self.map.is_moving() {
            None
        } else {
            Some(self.camera_key())
        };
    }

    /// The markers were cleared; the next `show_report_point` must draw them again.
    pub fn forget_report_point(&mut self) {
        self.report.plotted = None;
        self.report.fitted_at = None;
    }

    pub fn report_point_shown(&self) -> bool {
        self.report.plotted.is_some()
    }

    /// Plot a report's town-level intensity points and its epicentre.
    pub fn show_report_point(&mut self, data: Option<&Rc<ReportListItem>>) {
        let Some(data) = data else {
            return;
        };
        // Idle calls this on every station frame with the same report.
        if self
            .report
            .plotted
            .as_ref()
            .is_some_and(|p| Rc::ptr_eq(p, data))
        {
            if !self.focus.lock {
                self.fit_report();
            }
            return;
        }
        let mut markers = Vec::new();
        let mut bounds = Vec::new();
        for (_, city) in &data.list.0 {
            for (_, town) in &city.town.0 {
                bounds.push(Coord {
                    lon: town.lon,
                    lat: town.lat,
                });
                // `report-markers` leaves out i = 0, drawn as the cross below.
                if town.int == 0 {
                    continue;
                }
                markers.push(Symbol {
                    lon: town.lon,
                    lat: town.lat,
                    icon: IconId::Intensity(town.int.clamp(0, 9) as u8),
                    sort: town.int as f32,
                    opacity: 1.0,
                });
            }
        }
        self.var.cache.bounds.report = bounds;
        let cross = vec![Symbol {
            lon: data.lon,
            lat: data.lat,
            icon: IconId::Cross,
            sort: 0.0,
            opacity: 1.0,
        }];
        self.report.plotted = Some(Rc::clone(data));
        self.report.fitted_at = None;
        self.fit_report();
        self.map.scene.set_report_markers(markers, cross);
    }

    pub fn report_text(&mut self, purpose: ReportFetch, text: Option<String>) {
        match purpose {
            ReportFetch::List => self.report_list(text),
            ReportFetch::Seed { epoch } => {
                let Some(detail) = parse_detail(text.as_deref()) else {
                    return;
                };
                if epoch != self.report.replay_epoch {
                    return;
                }
                self.var.cache.last_report = Some(Rc::clone(&detail));
                if self.config.idle_map == IdleMap::Report || self.var.event_holds_map() {
                    self.show_report_point(Some(&detail));
                }
            }
            ReportFetch::Release {
                epoch,
                update,
                fallback,
            } => {
                // Sent in real time, a report may not be stored yet, and its page answers
                // 404: then what the stream sent is the report.
                let detail = parse_detail(text.as_deref()).or_else(|| {
                    let item = fallback?;
                    log::info!(
                        target: "report",
                        "{} 的單筆報告還查不到（尚未入庫），用即時推送的內容發布",
                        item.id
                    );
                    Some(Rc::new(*item))
                });
                let Some(detail) = detail else {
                    return;
                };
                if epoch == self.report.replay_epoch && self.var.replay.start_time == 0.0 {
                    self.emit(Event::ReportRelease {
                        data: detail,
                        update,
                    });
                }
            }
            ReportFetch::EndUpdate => {
                let Some(detail) = parse_detail(text.as_deref()) else {
                    return;
                };
                if self.report.update_on_show.is_some() {
                    return;
                }
                self.var.cache.last_report = Some(detail);
                // Redrawn by the RTS handler, which shows the report only while the map
                // is not taken by an alert.
                let rts = self.var.data.rts.clone();
                self.emit(Event::DataRts(rts));
            }
        }
    }

    /// The full list as the latest. Kept apart from the replay-filtered panel: persisting
    /// the filtered list used to make newer reports look newly released after a replay.
    fn set_list(&mut self, list: &[Rc<ReportListItem>]) {
        self.report.latest_full = list.to_vec();
        self.apply_visible_list(list);
        self.emit(Event::ReportListUpdate);
    }

    /// Whether `r` is news against what was seen of it, remembering it either way:
    /// `Some(update)` for a new id or a changed earthquake under 48 h old. `stored_after`
    /// is the [`headline`] of the real-time version `r` is the stored copy of; then only
    /// a changed time or magnitude makes it an update.
    fn note(&mut self, r: &ReportListItem, stored_after: Option<&str>) -> Option<bool> {
        let before = self
            .report
            .seen
            .iter()
            .find(|(id, _)| *id == r.id)
            .map(|(_, key)| key.clone());
        if before.as_deref() == Some(report_key(r).as_str()) {
            return None;
        }
        self.remember(r);
        let update = before.is_some();
        if update && stored_after == Some(headline(r).as_str()) {
            log::info!(
                target: "report",
                "報告入庫 {}：時間與規模沒變，座標與測站改用入庫的版本，不另外發布",
                r.id
            );
            return None;
        }
        let fresh = self.var.now() - r.time < FRESH_MS;
        // Named, so the next "why did this report pop up" has an answer.
        log::info!(
            target: "report",
            "{} {}｜{} M{} 深 {} km{}",
            if update { "報告修正" } else { "新報告" },
            r.id,
            r.loc,
            r.mag,
            r.depth,
            if fresh { "" } else { "｜發震超過 48 小時，不發布" }
        );
        fresh.then_some(update)
    }

    fn report_list(&mut self, text: Option<String>) {
        let Some(text) = text else {
            return;
        };
        let hash = text_hash(&text);
        // An unchanged list is the usual answer, and nothing below does anything with one.
        if self.report.seeded && self.report.last_list == Some(hash) {
            return;
        }
        let Ok(list) = serde_json::from_str::<Vec<ReportListItem>>(&text) else {
            return;
        };
        self.report.last_list = Some(hash);
        if self.report.seeded {
            log::debug!(target: "report", "報告列表有變動，共 {} 筆", list.len());
        } else {
            log::info!(target: "report", "報告列表首次載入，共 {} 筆", list.len());
        }
        let mut list: Vec<Rc<ReportListItem>> = list.into_iter().map(Rc::new).collect();

        // A report the stream sent before it was stored is not listed yet: it stays. One
        // the list has is stored now, and the list's copy takes its place.
        let mut stored = Vec::new();
        for (id, head) in std::mem::take(&mut self.report.provisional) {
            if list.iter().any(|r| r.id == id) {
                stored.push((id, head));
            } else if let Some(r) = self.report.latest_full.iter().find(|r| r.id == id) {
                place(&mut list, Rc::clone(r));
                self.report.provisional.push((id, head));
            }
        }
        self.report
            .provisional
            .retain(|(id, _)| list.iter().any(|r| r.id == *id));

        self.set_list(&list);
        // The server's list as it came: a report only the stream has is not in it.
        if let Some(path) = self.host.data_file(CACHE_FILE) {
            self.host.background(move || {
                let _ = std::fs::write(path, text);
                None
            });
        }

        // First load: seed the seen ids, oldest first, and emit nothing.
        if !self.report.seeded {
            self.report.seeded = true;
            for r in list.iter().rev() {
                self.remember(r);
            }
            // Seed the idle map with the latest report's points. Without it the idle
            // frame clears the dots and has nothing to fall back to.
            if let Some(newest) = self.var.data.report.first().cloned() {
                let epoch = self.report.replay_epoch;
                self.fetch_detail(&newest.id, ReportFetch::Seed { epoch });
            }
            return;
        }

        // Afterwards: a new id, or a seen id whose earthquake changed.
        let mut changes: Vec<(Rc<ReportListItem>, bool)> = Vec::new();
        for r in &list {
            let stored_after = stored
                .iter()
                .find(|(id, _)| *id == r.id)
                .map(|(_, head)| head.as_str());
            if let Some(update) = self.note(r, stored_after) {
                changes.push((Rc::clone(r), update));
            }
        }
        // Remembered while replaying so they are not false news afterwards, but no live
        // alert in a replay.
        if self.var.replay.start_time != 0.0 {
            return;
        }
        if let Some((target, update)) = changes.first() {
            let epoch = self.report.replay_epoch;
            self.fetch_detail(
                &target.id,
                ReportFetch::Release {
                    epoch,
                    update: *update,
                    fallback: None,
                },
            );
        }
    }

    /// A connection of the live stream is up. The stream sends no report from before it,
    /// so the list is fetched once more for what came while there was none: a reconnect's
    /// gap, or for the first, the time since the list fetched at start.
    pub fn report_stream_up(&mut self) {
        log::info!(target: "report", "即時連線就緒：重抓一次報告列表，補上沒連線時發布的報告");
        self.fetch_list();
    }

    /// An `eq.report.v1` message. A report comes several times: in real time (reason 0)
    /// and once stored (1–3); each replaces the last by id in the list, which stays newest
    /// first and REPORT_LIMIT long. A new or changed report is released as a fetched one
    /// is. Reason 3 is mostly maintenance re-sending old reports.
    pub fn report_stream(&mut self, reason: i64, mut item: ReportListItem) {
        if reason == 3 && self.var.now() - item.time >= FRESH_MS {
            log::debug!(target: "report", "略過定期維護回填的舊報告 {}", item.id);
            return;
        }
        // As the fetched list, which leaves out reports felt nowhere (minIntensity 1).
        if item.int < 1 {
            log::debug!(target: "report", "略過全臺最大震度 0 級的報告 {}", item.id);
            return;
        }
        let pending = self
            .report
            .provisional
            .iter()
            .position(|(id, _)| *id == item.id);
        let stored_after = if reason == 0 {
            if pending.is_none() && self.report.seen.iter().any(|(id, _)| *id == item.id) {
                log::debug!(target: "report", "報告 {} 已經入庫，略過較早的即時版本", item.id);
                return;
            }
            let head = (item.id.clone(), headline(&item));
            match pending {
                Some(i) => self.report.provisional[i] = head,
                None => self.report.provisional.push(head),
            }
            None
        } else {
            pending.map(|i| self.report.provisional.remove(i).1)
        };
        // What the message lacks and a fetched copy has: the TREM event it matches.
        if let Some(listed) = self.report.latest_full.iter().find(|r| r.id == item.id) {
            if item.trem == 0.0 {
                item.trem = listed.trem;
            }
        }
        let item = Rc::new(item);
        let mut list = self.report.latest_full.clone();
        list.retain(|r| r.id != item.id);
        place(&mut list, Rc::clone(&item));
        if !list.iter().any(|r| Rc::ptr_eq(r, &item)) {
            log::debug!(target: "report", "報告 {} 比列表裡每一筆都舊，不收", item.id);
            self.report.provisional.retain(|(id, _)| *id != item.id);
            return;
        }
        if list != self.report.latest_full {
            self.set_list(&list);
        }
        let change = self.note(&item, stored_after.as_deref());
        if self.var.replay.start_time != 0.0 {
            return;
        }
        if let Some(update) = change {
            let epoch = self.report.replay_epoch;
            self.fetch_detail(
                &item.id,
                ReportFetch::Release {
                    epoch,
                    update,
                    fallback: Some(Box::new((*item).clone())),
                },
            );
        }
    }

    fn end_update(&mut self, id: &str) {
        if self.report.update_on_show.as_deref() != Some(id) {
            return; // a later report has taken over
        }
        self.report.update_on_show = None;
        let Some(latest) = self.report.latest_full.first().cloned() else {
            return;
        };
        if latest.id == id {
            return; // the update is the latest report
        }
        self.fetch_detail(&latest.id, ReportFetch::EndUpdate);
    }

    fn on_report_release(&mut self, data: &Rc<ReportListItem>, update: bool) {
        self.report.update_on_show = update.then(|| data.id.clone());
        self.var.cache.last_report = Some(Rc::clone(data));
        // Idle on the stations: a new report does not cover the map; the list updates.
        if self.config.idle_map == IdleMap::Report || self.var.event_holds_map() {
            self.show_report_point(Some(data));
        }
        if data.trem != 0.0 && (data.trem - self.var.cache.intensity_time).abs() < 15_000.0 {
            self.var.cache.intensity_time = 0.0;
            self.var.cache.intensity_max = 0;
        }
    }

    /// Open the CWA or TREM page for a report.
    pub fn open_report_url(&self, item: &ReportListItem) {
        let second = item.id.split('-').nth(1).unwrap_or("");
        let report_id = item.id.replacen(&format!("-{second}"), "", 1);
        let url = if item.trem != 0.0 {
            format!(
                "https://api.exptech.dev/file/trem_info.html?id={}",
                item.trem
            )
        } else {
            format!("https://www.cwa.gov.tw/V8/C/E/EQ/EQ{report_id}.html")
        };
        if let Err(err) = trem_io::paths::open_url(&url) {
            log::warn!(target: "report", "打不開 {url}：{err}");
        }
    }

    /// Toggle a replay of the report's time window.
    pub fn replay_report(&mut self, item: &ReportListItem) {
        let time = item.time - 5000.0;
        let was_active = self.report.active_replay.as_deref() == Some(item.id.as_str())
            && self.var.replay.start_time == time;
        self.stop_replay();
        if !was_active {
            self.start_replay(time, Some(item.id.clone()));
        }
    }

    pub fn active_replay_report(&self) -> Option<&str> {
        if self.var.replay.start_time != 0.0 {
            self.report.active_replay.as_deref()
        } else {
            None
        }
    }

    pub fn report_init(&mut self) {
        // Cold start: the last list at once, the fetch replaces it.
        let cached = self
            .host
            .data_file(CACHE_FILE)
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str::<Vec<ReportListItem>>(&text).ok());
        if let Some(list) = cached.filter(|list| !list.is_empty()) {
            let list: Vec<Rc<ReportListItem>> = list.into_iter().map(Rc::new).collect();
            self.report.latest_full.clone_from(&list);
            self.var.data.report = list;
            self.emit(Event::ReportListUpdate);
        }
        self.report.auto_zoom = !self.config.checked("graphics-block-auto-zoom");
        // The list is independent of the map: the panel fills even with no basemap yet.
        // Fetched once here; the live stream keeps it current.
        if !self.report.started {
            self.report.started = true;
            self.fetch_list();
        }
    }

    pub fn report_on_config(&mut self) {
        // The whole config arrives here: only the toggle itself is worth acting on.
        // Without the comparison, turning the volume down pulled the map back.
        let enabled = !self.config.checked("graphics-block-auto-zoom");
        if enabled == self.report.auto_zoom {
            return;
        }
        self.report.auto_zoom = enabled;
        if enabled && self.report.plotted.is_some() {
            self.fit_report();
        }
    }

    pub fn report_on(&mut self, ev: &Event) {
        match ev {
            Event::ReportRelease { data, update } => self.on_report_release(data, *update),
            Event::ReportSpeechEnd(id) => self.end_update(id),
            Event::ReplayStateChange { active, report_id } => {
                self.report.replay_epoch += 1;
                self.report.active_replay = if *active { report_id.clone() } else { None };
                let source = if self.report.latest_full.is_empty() {
                    self.var.data.report.clone()
                } else {
                    self.report.latest_full.clone()
                };
                self.apply_visible_list(&source);
                self.emit(Event::ReportListUpdate);
            }
            _ => {}
        }
    }

    // ---- Replay -----------------------------------------------------------

    pub fn start_replay(&mut self, time: f64, report_id: Option<String>) {
        log::info!(
            target: "replay",
            "開始重播{}，最長 {} 秒",
            report_id.as_ref().map_or_else(String::new, |id| format!("報告 {id}")),
            REPLAY_MAX_MS / 1000.0
        );
        self.switch_mode(
            2,
            Replay {
                start_time: time,
                local_time: 0.0,
            },
        );
        self.emit(Event::ReplayStateChange {
            active: true,
            report_id,
        });
        self.timers.clear_slot(&mut self.report.time_limit);
        self.report.time_limit = Some(self.timers.interval(1000.0, Task::ReplayLimit));
    }

    pub fn stop_replay(&mut self) {
        self.timers.clear_slot(&mut self.report.time_limit);
        self.switch_mode(0, Replay::default());
        self.emit(Event::ReplayStateChange {
            active: false,
            report_id: None,
        });
        if !self.focus.lock {
            self.timers.timeout(1500.0, Task::ReplayReturn);
        }
    }

    pub fn replay_limit_tick(&mut self) {
        if self.var.play_mode != 2 {
            self.timers.clear_slot(&mut self.report.time_limit);
            return;
        }
        // On the replay's own clock, so a machine that slept through part of it still
        // leaves at 600 s of replay.
        if self.var.now() - self.var.replay.start_time > REPLAY_MAX_MS {
            log::info!(target: "replay", "重播滿 {} 秒，自動結束", REPLAY_MAX_MS / 1000.0);
            self.stop_replay();
        }
    }
}

fn parse_detail(text: Option<&str>) -> Option<Rc<ReportListItem>> {
    serde_json::from_str::<ReportListItem>(text?)
        .ok()
        .map(Rc::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_is_what_makes_it_that_earthquake() {
        let a = ReportListItem {
            id: "1".to_string(),
            time: 5.0,
            mag: 4.2,
            ..Default::default()
        };
        let mut b = a.clone();
        b.loc = "另一個名字".to_string();
        assert_eq!(report_key(&a), report_key(&b));
        b.mag = 4.3;
        assert_ne!(report_key(&a), report_key(&b));
    }

    #[test]
    fn a_detail_keeps_its_places_in_order() {
        let detail = parse_detail(Some(
            r#"{"id":"x","list":{"花蓮縣":{"int":4,"town":{"秀林鄉":{"int":4,"lon":121.6,"lat":24.1},"吉安鄉":{"int":3,"lon":121.5,"lat":23.9}}},"臺東縣":{"int":2,"town":{}}}}"#,
        ));
        let detail = detail.unwrap_or_default();
        assert_eq!(detail.list.0[0].0, "花蓮縣");
        assert_eq!(detail.list.0[0].1.town.0[1].0, "吉安鄉");
        assert_eq!(detail.list.0[1].0, "臺東縣");
    }
}
