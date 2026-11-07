//! Predicted intensity per town while an EEW is up (features/estimate/estimate.ts).

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::Instant;

use crate::app::{App, Msg};
use crate::backend::logging::fmt_dur;
use crate::backend::math::EewAreaResult;
use crate::domain::constants::INTENSITY_LIST;
use crate::domain::region;
use crate::domain::types::EewData;
use crate::domain::utils::town_colors;
use crate::events::Event;
use crate::variable::MergedArea;

#[derive(Default)]
pub struct EstimateState {
    /// Cities already alerted this episode.
    alerted_cities: HashSet<String>,
}

fn label(level: i32) -> String {
    usize::try_from(level)
        .ok()
        .and_then(|l| INTENSITY_LIST.get(l))
        .map_or_else(|| level.to_string(), |s| (*s).to_string())
}

fn merge_area(area: &EewAreaResult, reported: &crate::domain::types::Area) -> MergedArea {
    let mut towns: HashMap<i32, i32> = area
        .area
        .iter()
        .map(|(code, entry)| (*code as i32, i32::from(entry.level)))
        .collect();
    for (level, codes) in reported {
        for code in codes {
            if let Some(known) = towns.get_mut(code) {
                if *known < *level {
                    *known = *level;
                }
            }
        }
    }
    let max_i = towns.values().copied().max().unwrap_or(0).max(0);
    MergedArea { max_i, towns }
}

impl App {
    fn update_eew_area(&mut self, data: &Rc<EewData>) {
        let (lat, lon, depth, mag) = (data.eq.lat, data.eq.lon, data.eq.depth, data.eq.mag);
        let id = data.id.clone();
        let serial = data.serial;
        let reported = data.eq.area.clone();
        let post = self.post.clone();
        // The model takes tens of milliseconds: off the main thread.
        self.rt.spawn_blocking(move || {
            let started = Instant::now();
            let result = crate::backend::math::eew_area_intensity(lat, lon, depth, mag);
            post(Msg::EewArea {
                id,
                serial,
                reported,
                result,
                elapsed: started.elapsed(),
            });
        });
    }

    pub fn estimate_done(
        &mut self,
        id: String,
        serial: i64,
        reported: crate::domain::types::Area,
        result: Result<EewAreaResult, String>,
        elapsed: std::time::Duration,
    ) {
        let which = format!("預警 {id} 第 {serial} 報");
        let area = match result {
            Ok(area) => area,
            Err(err) => {
                log::warn!(target: "estimate", "{which} 的預估震度算不出來，地圖不上色：{err}");
                return;
            }
        };
        // It can finish after an update, an end or a replay transition. Only the still
        // active serial may repaint.
        let active = self
            .var
            .data
            .eew
            .iter()
            .any(|e| e.id == id && e.serial == serial && !e.eew_end);
        if !active {
            log::debug!(target: "estimate", "{which} 的預估震度算完時，這一報已被更新或結束，丟棄");
            return;
        }
        let merged = merge_area(&area, &reported);
        let mut felt: Vec<(i64, u8, f64)> = area
            .area
            .iter()
            .filter(|(_, t)| t.level > 0)
            .map(|(code, t)| (*code, t.level, t.dist))
            .collect();
        felt.sort_by(|a, b| b.1.cmp(&a.1).then(a.2.total_cmp(&b.2)));
        let top: Vec<String> = felt
            .iter()
            .take(8)
            .map(|(code, level, _)| {
                let name = region::town_name(*code as i32);
                let name = if name.is_empty() {
                    code.to_string()
                } else {
                    name
                };
                format!("{name} {}", label(i32::from(*level)))
            })
            .collect();
        log::info!(
            target: "estimate",
            "{which} 預估震度：{} 個鄉鎮有感，最大 {}｜{}｜計算 {}",
            felt.len(),
            label(merged.max_i),
            if top.is_empty() { "無".to_string() } else { top.join("、") },
            fmt_dur(elapsed),
        );
        self.var.cache.eew_intensity_area.insert(id, merged);
        self.draw_eew_area(false);
    }

    /// Repaint the towns for the active EEWs' predicted areas.
    pub fn draw_eew_area(&mut self, end: bool) {
        // The episode is over whether or not anything is painted: a city alerted for
        // this EEW must be able to alert again for the next one.
        if end {
            self.estimate.alerted_cities.clear();
        }
        if self.var.cache.show_lpgm || self.var.cache.show_intensity {
            return;
        }
        // Only an EEW still held as active may colour the towns.
        let eew = &self.var.data.eew;
        self.var
            .cache
            .eew_intensity_area
            .retain(|id, _| eew.iter().any(|e| e.id == *id));
        if self.var.cache.eew_intensity_area.is_empty() {
            self.map.scene.paint_towns(None);
            return;
        }
        let mut combined: HashMap<i32, i32> = HashMap::new();
        for merged in self.var.cache.eew_intensity_area.values() {
            for (code, level) in &merged.towns {
                let known = combined.entry(*code).or_insert(*level);
                if *known < *level {
                    *known = *level;
                }
            }
        }
        let mut high: Vec<String> = Vec::new();
        for (code, level) in &combined {
            if *level >= 5 {
                if let Some(town) = region::town_of(*code) {
                    if !high.iter().any(|c| c == town.city) {
                        high.push(town.city.to_string());
                    }
                }
            }
        }
        high.sort();
        let new_cities: Vec<String> = high
            .iter()
            .filter(|c| !self.estimate.alerted_cities.contains(*c))
            .cloned()
            .collect();
        if !new_cities.is_empty() {
            self.emit(Event::EewNewAreaAlert(Rc::new(high)));
            self.estimate.alerted_cities.extend(new_cities);
        }
        self.map
            .scene
            .paint_towns(Some(town_colors(&combined, false)));
    }

    pub fn estimate_on(&mut self, ev: &Event) {
        match ev {
            Event::EewRelease(data) | Event::EewUpdate(data) => self.update_eew_area(data),
            Event::EewEnd(data) => {
                self.var.cache.eew_intensity_area.remove(&data.id);
                self.draw_eew_area(true);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::math::AreaEntry;

    #[test]
    fn what_was_reported_lifts_but_never_lowers_a_town() {
        let mut area = HashMap::new();
        area.insert(
            100,
            AreaEntry {
                dist: 1.0,
                level: 3,
            },
        );
        area.insert(
            101,
            AreaEntry {
                dist: 2.0,
                level: 5,
            },
        );
        let result = EewAreaResult { area };
        let merged = merge_area(&result, &vec![(4, vec![100, 101, 999])]);
        assert_eq!(merged.towns[&100], 4);
        assert_eq!(merged.towns[&101], 5);
        assert!(!merged.towns.contains_key(&999));
        assert_eq!(merged.max_i, 5);
    }
}
