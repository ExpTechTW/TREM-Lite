//! The station dots, the alert sounds' state machine and the numbers beside them
//! (features/rts/rts.ts).

use std::rc::Rc;

use trem_core::color::COLOR_INTENSITY;
use trem_core::intensity::{intensity_float_to_int, shake_level};
use trem_core::region;

use crate::app::App;
use crate::backend::config::IdleMap;
use crate::domain::palette::{rts_color_index, RTS_PALETTE};
use crate::domain::types::RtsData;
use crate::domain::utils::{int_to_string, TownPeaks};
use crate::events::Event;
use crate::map::icons::IconId;
use crate::map::scene::{rel, DotInstance, Symbol};
use crate::variable::{AudioCache, Coord, CurrentStation, TriggerLocation};

/// One station on the map. Kept across frames so a quiet second writes nothing.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Dot {
    kind: DotKind,
    lon: f64,
    lat: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum DotKind {
    /// A coloured dot, indexing the palette.
    Color(usize),
    /// An alert icon of this level.
    Alert(i32),
    /// A zero dot while an EEW is up.
    Zero,
}

pub struct RtsState {
    dots: Vec<Dot>,
    prev_dots: Vec<Dot>,
    /// The map lost its picture (a mode change) and must be drawn again.
    dots_need_draw: bool,
    town_peaks: TownPeaks,
    idle_shown: IdleMap,
}

impl RtsState {
    pub fn new(idle_shown: IdleMap) -> Self {
        Self {
            dots: Vec::with_capacity(1024),
            prev_dots: Vec::with_capacity(1024),
            dots_need_draw: true,
            town_peaks: TownPeaks::default(),
            idle_shown,
        }
    }
}

/// `int` and `box` of a frame: its alerting stations' highest level per detection box
/// and per town (features/data/rtsV1.ts).
pub fn fill_derived(rts: &mut RtsData, station: Option<&crate::domain::types::Stations>) {
    let mut towns: Vec<(&str, &str, i32, i32)> = Vec::new();
    for (id, s) in &rts.station {
        if !s.alert {
            continue;
        }
        let Some(at) = station.and_then(|list| list.get(id)) else {
            continue;
        };
        let level = intensity_float_to_int(s.i);
        if let Some(box_id) = region::box_of(at.lon, at.lat) {
            match rts.boxes.iter_mut().find(|(b, _)| *b == box_id) {
                Some((_, known)) => *known = (*known).max(level),
                None => rts.boxes.push((box_id, level)),
            }
        }
        let Some(town) = region::town_of(at.code) else {
            continue;
        };
        match towns
            .iter_mut()
            .find(|t| t.0 == town.city && t.1 == town.town)
        {
            Some(known) => {
                if known.3 < level {
                    known.2 = at.code;
                    known.3 = level;
                }
            }
            None => towns.push((town.city, town.town, at.code, level)),
        }
    }
    towns.sort_by_key(|t| std::cmp::Reverse(t.3));
    rts.int = towns.iter().map(|t| (t.2, t.3)).collect();
}

fn filter_int(data: &[(i32, i32)]) -> Vec<(i32, i32)> {
    let Some(max) = data.first().map(|d| d.1) else {
        return Vec::new();
    };
    if max > 3 {
        data.iter().filter(|d| d.1 > 3).copied().collect()
    } else if max > 1 {
        data.iter().filter(|d| d.1 > 1).copied().collect()
    } else {
        data.to_vec()
    }
}

fn top_intensities(list: &[(i32, i32)], max_count: usize) -> Vec<TriggerLocation> {
    if list.len() <= max_count {
        return list
            .iter()
            .map(|(code, i)| TriggerLocation {
                i: *i,
                name: region::town_name(*code),
            })
            .collect();
    }
    let mut cities: Vec<TriggerLocation> = Vec::new();
    for (code, i) in list {
        let Some(town) = region::town_of(*code) else {
            continue;
        };
        match cities.iter_mut().find(|c| c.name == town.city) {
            Some(city) => city.i = city.i.max(*i),
            None => cities.push(TriggerLocation {
                i: *i,
                name: town.city.to_string(),
            }),
        }
    }
    cities.sort_by_key(|c| std::cmp::Reverse(c.i));
    cities.truncate(max_count);
    cities
}

/// Pushes the alert sounds, by the frame's maximum so far (rts.ts's chain, as is).
fn alert_audio(audio: &mut AudioCache, pga: f64, level: i32, out: &mut Vec<Event>) {
    if pga > audio.pga {
        if pga > 200.0 && audio.status_pga != 2 {
            out.push(Event::RtsPga2);
            audio.status_pga = 2;
        } else if pga > 8.0 && audio.status_pga == 0 {
            out.push(Event::RtsPga1);
            audio.status_pga = 1;
        }
        audio.pga = pga;
        if pga > 8.0 {
            audio.count.pga_1 = 0;
        }
        if pga > 200.0 {
            audio.count.pga_2 = 0;
        }
    }
    if level > audio.shindo {
        if level > 3 && audio.status_shindo != 3 {
            out.push(Event::RtsShindo2);
            audio.status_shindo = 3;
        } else if level > 1 && audio.status_shindo < 2 {
            out.push(Event::RtsShindo1);
            audio.status_shindo = 2;
        } else if audio.status_shindo == 0 {
            out.push(Event::RtsShindo0);
            audio.status_shindo = 1;
        }
        if level > 3 {
            audio.count.shindo_2 = 0;
        }
        if level > 1 {
            audio.count.shindo_1 = 0;
        }
        audio.shindo = level;
    }
}

/// The alert levels easing back: 30 frames below the bound for PGA, 15 for intensity.
fn audio_decay(audio: &mut AudioCache, max_pga: f64, max_shindo: i32) {
    if audio.pga != 0.0 && !audio.pga.is_nan() && max_pga < audio.pga {
        if audio.status_pga == 2 {
            if max_pga < 200.0 {
                audio.count.pga_2 += 1;
                if audio.count.pga_2 >= 30 {
                    audio.count.pga_2 = 0;
                    audio.status_pga = 1;
                }
            } else {
                audio.count.pga_2 = 0;
            }
        } else if audio.status_pga == 1 {
            if max_pga < 8.0 {
                audio.count.pga_1 += 1;
                if audio.count.pga_1 >= 30 {
                    audio.count.pga_1 = 0;
                    audio.status_pga = 0;
                }
            } else {
                audio.count.pga_1 = 0;
            }
        }
        audio.pga = max_pga;
    }
    if audio.shindo != 0 && max_shindo < audio.shindo {
        if audio.status_shindo == 3 {
            if max_shindo < 4 {
                audio.count.shindo_2 += 1;
                if audio.count.shindo_2 >= 15 {
                    audio.count.shindo_2 = 0;
                    audio.status_shindo = 2;
                }
            } else {
                audio.count.shindo_2 = 0;
            }
        } else if audio.status_shindo == 2 {
            if max_shindo < 2 {
                audio.count.shindo_1 += 1;
                if audio.count.shindo_1 >= 15 {
                    audio.count.shindo_1 = 0;
                    audio.status_shindo = 1;
                }
            } else {
                audio.count.shindo_1 = 0;
            }
        }
        audio.shindo = max_shindo;
    }
}

impl App {
    pub fn rts_on(&mut self, ev: &Event) {
        match ev {
            Event::DataModeReset => {
                self.ui.current_station = None;
                self.ui.rts_level = 0;
                self.ui.rts_trigger = 0;
                self.ui.rts_intensity_rows.clear();
                self.rts.town_peaks.clear();
                self.ui.max_intensity = (0, int_to_string(0));
                self.ui.max_pga = 0.0;
                self.ui.max_pga_intensity = 0;
                self.ui.unstable = false;
                self.rts.dots_need_draw = true;
                self.forget_report_point();
            }
            Event::DataRts(data) => self.rts_frame(data.as_ref()),
            _ => {}
        }
    }

    /// The idle map changed: redraw at once. During an earthquake nothing changes, and
    /// the first idle frame after it takes the new choice.
    pub fn rts_on_config(&mut self) {
        let next = self.config.idle_map;
        if next == self.rts.idle_shown {
            return;
        }
        self.rts.idle_shown = next;
        if self.var.event_holds_map() {
            return;
        }
        let rts = self.var.data.rts.clone();
        self.emit(Event::DataRts(rts));
    }

    /// Drops the report from the map when idle shows the stations. Untouched when there
    /// is none.
    fn drop_idle_report(&mut self) {
        if !self.report_point_shown() && self.var.cache.bounds.report.is_empty() {
            return;
        }
        self.var.cache.bounds.report.clear();
        self.forget_report_point();
        self.map.scene.set_report_markers(Vec::new(), Vec::new());
    }

    fn publish_dots(&mut self) {
        let mut rts = Vec::new();
        let mut zero = Vec::new();
        let mut markers = Vec::new();
        for d in &self.rts.dots {
            match d.kind {
                DotKind::Color(c) => rts.push(DotInstance {
                    pos: rel(d.lon, d.lat),
                    color: RTS_PALETTE[c],
                }),
                DotKind::Alert(level) => markers.push(Symbol {
                    lon: d.lon,
                    lat: d.lat,
                    icon: IconId::Intensity(level.clamp(0, 9) as u8),
                    sort: level as f32,
                    opacity: 1.0,
                }),
                DotKind::Zero => zero.push(DotInstance {
                    pos: rel(d.lon, d.lat),
                    color: COLOR_INTENSITY[0],
                }),
            }
        }
        self.map.scene.set_station_dots(rts, zero, markers);
        self.rts.prev_dots.clone_from(&self.rts.dots);
        self.rts.dots_need_draw = false;
    }

    fn rts_frame(&mut self, data: Option<&Rc<RtsData>>) {
        let mut coordinates: Vec<Coord> = Vec::new();
        let mut pga = 0.0_f64;
        let mut trigger = 0;
        let mut level = 0;
        let mut rts_max_pga = -1.0_f64;
        let mut rts_max_shindo = -1;
        self.rts.dots.clear();

        let Some(stations) = self.var.station.clone() else {
            return;
        };
        let idle = self.config.idle_map;
        let eew_alert = !self.var.data.eew.is_empty();
        let mut alert = false;

        if let Some(rts) = data {
            // A frame without a single station reading is ignored.
            if !rts.station.iter().any(|(_, s)| s.pga > f64::NEG_INFINITY) {
                return;
            }
            alert = !rts.boxes.is_empty();
            if !alert {
                self.var.cache.rts_alert = false;
                self.var.cache.audio = AudioCache::default();
            } else {
                if !self.var.cache.rts_alert
                    && self.var.cache.last_rts_alert != 0.0
                    && rts.time - self.var.cache.last_rts_alert < 300_000.0
                {
                    self.var.cache.unstable = rts.time;
                }
                self.var.cache.last_rts_alert = rts.time;
                self.var.cache.rts_alert = true;
            }
            let own = crate::domain::types::StationId::new(&self.config.station_id);
            let show_overlay = self.var.cache.show_intensity || self.var.cache.show_lpgm;
            let mut audio = self.var.cache.audio;
            let mut sounds = Vec::new();

            for (id, st) in &rts.station {
                let Some(at) = stations.get(id) else {
                    continue;
                };
                if st.pga > pga {
                    pga = st.pga;
                }
                if Some(*id) == own {
                    self.ui.current_station = Some(CurrentStation {
                        loc: region::town_name(at.code),
                        i: intensity_float_to_int(st.i),
                        raw_i: st.i,
                        pga: st.pga,
                    });
                }
                if st.alert {
                    trigger += 1;
                }
                if alert && st.alert {
                    let i = intensity_float_to_int(st.i);
                    let kind = if show_overlay {
                        DotKind::Color(rts_color_index(f64::from(i)))
                    } else if i > 0 {
                        DotKind::Alert(i)
                    } else if eew_alert {
                        DotKind::Zero
                    } else {
                        DotKind::Color(rts_color_index(f64::from(i)))
                    };
                    self.rts.dots.push(Dot {
                        kind,
                        lon: at.lon,
                        lat: at.lat,
                    });
                    coordinates.push(Coord {
                        lon: at.lon,
                        lat: at.lat,
                    });
                    if rts_max_pga < st.pga {
                        rts_max_pga = st.pga;
                    }
                    if rts_max_shindo < i {
                        rts_max_shindo = i;
                    }
                    alert_audio(&mut audio, pga, i, &mut sounds);
                } else if !eew_alert {
                    self.rts.dots.push(Dot {
                        kind: DotKind::Color(rts_color_index(st.i)),
                        lon: at.lon,
                        lat: at.lat,
                    });
                }
            }
            // Every station scores, alerting or not: quiet ones add nothing.
            level = shake_level(
                rts.station
                    .iter()
                    .filter_map(|(id, st)| stations.get(id).map(|at| (at.lon, at.lat, st.i))),
            );
            audio_decay(&mut audio, rts_max_pga, rts_max_shindo);
            self.var.cache.audio = audio;
            for sound in sounds {
                self.emit(sound);
            }

            if rts.time - self.var.cache.last_rts_alert < 15_000.0
                || self.var.cache.show_lpgm
                || self.var.cache.show_intensity
                || eew_alert
                || self.var.play_mode == 2
                || self.var.play_mode == 3
            {
                self.var.cache.bounds.report.clear();
                self.forget_report_point();
                self.map.scene.set_report_markers(Vec::new(), Vec::new());
            } else if idle == IdleMap::Report {
                self.rts.dots.clear();
                // A map the user has locked to read a report is not redrawn under them.
                if self.var.cache.bounds.report.is_empty() || !self.focus.lock {
                    let report = self.var.cache.last_report.clone();
                    self.show_report_point(report.as_ref());
                }
            } else {
                // Idle shows the stations: this frame's dots stay, the report goes.
                self.drop_idle_report();
            }
        }

        // No new frame, live, idle on the stations and nothing holding the map: last
        // frame's dots stay and no report goes up below.
        let keep_dots = data.is_none()
            && self.var.play_mode == 0
            && idle == IdleMap::Rts
            && !self.var.event_holds_map();
        if keep_dots {
            self.rts.dots.clone_from(&self.rts.prev_dots);
        }

        if self.rts.dots_need_draw || self.rts.dots != self.rts.prev_dots {
            self.publish_dots();
        }

        // Nothing live, so the latest report rather than an empty map, unless idle
        // keeps the dots.
        if data.is_none() && self.var.play_mode == 0 {
            if keep_dots {
                self.drop_idle_report();
            } else if self.var.cache.bounds.report.is_empty() || !self.focus.lock {
                let report = self.var.cache.last_report.clone();
                self.show_report_point(report.as_ref());
            }
        }

        // This frame's highest per town. Only the bottom-right ranking holds a peak; a
        // frame without data leaves the ranking as it was.
        let int_list: &[(i32, i32)] = data.map_or(&[], |rts| rts.int.as_slice());
        if let Some(rts) = data {
            let peaks = self.rts.town_peaks.update(int_list, rts.time);
            let mut rows = top_intensities(&peaks, 6);
            rows.sort_by_key(|r| std::cmp::Reverse(r.i));
            self.ui.rts_intensity_rows = rows;
        }
        if let Some(first) = int_list.first() {
            self.var.cache.rts_trigger.loc = top_intensities(&filter_int(int_list), 8);
            self.var.cache.rts_trigger.max = first.1;
            self.show_eew(false);
        } else {
            self.var.cache.rts_trigger.loc.clear();
        }

        let max_i = int_list.first().map_or(0, |d| d.1);
        self.ui.max_intensity = (max_i, int_to_string(max_i));
        self.ui.max_pga = pga;
        self.ui.max_pga_intensity = if alert && pga >= 5.0 {
            intensity_float_to_int(2.0 * pga.log10() + 0.7)
        } else {
            0
        };
        self.ui.rts_level = level;
        self.ui.rts_trigger = trigger;
        self.var.cache.bounds.rts = coordinates;
        let frame_time = data.map_or(0.0, |rts| rts.time);
        self.ui.unstable =
            self.var.cache.unstable != 0.0 && frame_time - self.var.cache.unstable < 300_000.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sounds_fire_once_per_level_and_ease_back() {
        let mut audio = AudioCache::default();
        let mut out = Vec::new();
        alert_audio(&mut audio, 1.0, 0, &mut out);
        assert!(matches!(out.as_slice(), [Event::RtsShindo0]));
        out.clear();
        alert_audio(&mut audio, 300.0, 4, &mut out);
        assert!(matches!(
            out.as_slice(),
            [Event::RtsPga2, Event::RtsShindo2]
        ));
        out.clear();
        alert_audio(&mut audio, 300.0, 4, &mut out);
        assert!(out.is_empty());
        for _ in 0..15 {
            audio_decay(&mut audio, 300.0, 3);
            audio.shindo = 4;
        }
        assert_eq!(audio.status_shindo, 2);
    }

    #[test]
    fn many_towns_collapse_into_their_cities() {
        let towns: Vec<(i32, i32)> = region::towns()
            .iter()
            .take(9)
            .enumerate()
            .map(|(n, t)| (t.code, n as i32))
            .collect();
        let rows = top_intensities(&towns, 6);
        assert!(rows.len() <= 6);
        assert!(rows.windows(2).all(|w| w[0].i >= w[1].i));
        assert!(region::towns().iter().any(|t| t.city == rows[0].name));
    }

    #[test]
    fn filtering_keeps_only_the_stronger_tier() {
        assert_eq!(filter_int(&[(1, 5), (2, 3)]), vec![(1, 5)]);
        assert_eq!(filter_int(&[(1, 2), (2, 1)]), vec![(1, 2)]);
        assert_eq!(filter_int(&[(1, 1), (2, 0)]), vec![(1, 1), (2, 0)]);
    }
}
