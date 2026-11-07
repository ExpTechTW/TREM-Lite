//! The reported-intensity and long-period overlays on the map
//! (features/intensity/intensity.ts, features/lpgm/lpgm.ts).

use std::collections::HashMap;
use std::rc::Rc;

use crate::app::App;
use crate::domain::region;
use crate::domain::types::{area_by_code, IntensityReport, LpgmData, StationId};
use crate::domain::utils::town_colors;
use crate::events::Event;
use crate::map::icons::IconId;
use crate::map::scene::Symbol;
use crate::timers::Task;
use crate::variable::Coord;

const INTENSITY_SHOWN_MS: f64 = 7500.0;
/// How long the LPGM overlay stays visible before reverting.
const LPGM_SHOWN_MS: f64 = 15_000.0;

impl App {
    fn emit_rts_again(&mut self) {
        let rts = self.var.data.rts.clone();
        self.emit(Event::DataRts(rts));
    }

    fn show_intensity(&mut self, data: &IntensityReport) {
        self.map.scene.set_lpgm_markers(Vec::new());
        self.var.cache.bounds.lpgm.clear();
        self.var.cache.show_lpgm = false;

        self.var.cache.show_intensity = true;
        self.emit_rts_again();

        self.var.cache.intensity_time = data.id;
        self.var.cache.intensity_max = data.max;
        self.emit(Event::ReportListUpdate);

        let by_code = area_by_code(&data.area);
        self.map
            .scene
            .paint_towns(Some(town_colors(&by_code, false)));
        self.map.scene.set_rts_opacity(0.2);

        // By code, as `Object.keys` gave them: it decides which of two colliding icons
        // of one level stays.
        let mut ordered: Vec<(&i32, &i32)> = by_code.iter().collect();
        ordered.sort_unstable();
        let mut bounds = Vec::new();
        let mut markers = Vec::new();
        for (code, level) in ordered {
            let Some(town) = region::town_of(*code) else {
                continue;
            };
            bounds.push(Coord {
                lon: town.lon,
                lat: town.lat,
            });
            markers.push(Symbol {
                lon: town.lon,
                lat: town.lat,
                icon: IconId::IntensitySquare((*level).clamp(0, 9) as u8),
                sort: -((*level).max(1) as f32),
                opacity: 1.0,
            });
        }
        self.var.cache.bounds.intensity = bounds;
        self.map.scene.set_intensity_markers(markers);
        self.timers.timeout(INTENSITY_SHOWN_MS, Task::IntensityOff);
    }

    /// The 7.5 s are up.
    pub fn intensity_off(&mut self) {
        if !self.var.cache.show_intensity {
            return;
        }
        self.var.cache.show_intensity = false;
        self.emit_rts_again();
        self.var.cache.bounds.intensity.clear();
        if !self.focus.lock {
            self.focus_now();
        }
        self.map.scene.set_rts_opacity(1.0);
        self.map.scene.set_intensity_markers(Vec::new());
        self.draw_eew_area(false);
    }

    pub fn intensity_on(&mut self, ev: &Event) {
        match ev {
            Event::DataModeReset => {
                self.var.cache.show_intensity = false;
                self.var.cache.bounds.intensity.clear();
                self.map.scene.set_intensity_markers(Vec::new());
                self.map.scene.set_rts_opacity(1.0);
                self.draw_eew_area(false);
            }
            Event::IntensityRelease(data) | Event::IntensityUpdate(data) => {
                self.show_intensity(data);
            }
            Event::IntensityEnd(_) => {
                self.var.cache.intensity_time = 0.0;
                self.var.cache.intensity_max = 0;
                self.emit(Event::ReportListUpdate);
                self.draw_eew_area(false);
            }
            _ => {}
        }
    }

    fn show_lpgm(&mut self, data: &Rc<LpgmData>) {
        self.map.scene.set_intensity_markers(Vec::new());
        self.var.cache.bounds.intensity.clear();
        self.var.cache.show_intensity = false;

        self.var.cache.show_lpgm = true;
        self.emit_rts_again();

        let mut markers = Vec::new();
        let mut bounds = Vec::new();
        let mut code_level: HashMap<i32, i32> = HashMap::new();
        for station in &data.list {
            if station.lpgm == 0 {
                continue;
            }
            let at = StationId::new(&station.id).and_then(|id| {
                self.var
                    .legacy_station
                    .as_ref()
                    .and_then(|list| list.get(&id))
                    .copied()
            });
            let Some(at) = at else {
                continue;
            };
            let level = code_level.entry(at.code).or_insert(0);
            if *level < station.lpgm {
                *level = station.lpgm;
            }
            bounds.push(Coord {
                lon: at.lon,
                lat: at.lat,
            });
            markers.push(Symbol {
                lon: at.lon,
                lat: at.lat,
                icon: IconId::Lpgm(station.lpgm.clamp(1, 4) as u8),
                sort: -(station.lpgm.clamp(1, 4) as f32),
                opacity: 1.0,
            });
        }
        self.map
            .scene
            .paint_towns(Some(town_colors(&code_level, true)));
        self.map.scene.set_rts_opacity(0.2);
        self.var.cache.bounds.lpgm = bounds;
        self.focus_now();
        self.map.scene.set_lpgm_markers(markers);
        self.timers.timeout(LPGM_SHOWN_MS, Task::LpgmOff);
    }

    pub fn lpgm_off(&mut self) {
        if !self.var.cache.show_lpgm {
            return;
        }
        self.var.cache.show_lpgm = false;
        self.emit_rts_again();
        self.var.cache.bounds.lpgm.clear();
        if !self.focus.lock {
            self.focus_now();
        }
        self.map.scene.set_rts_opacity(1.0);
        self.map.scene.set_lpgm_markers(Vec::new());
        self.draw_eew_area(false);
    }

    pub fn lpgm_on(&mut self, ev: &Event) {
        match ev {
            Event::DataModeReset => {
                self.var.cache.show_lpgm = false;
                self.var.cache.bounds.lpgm.clear();
                self.map.scene.set_lpgm_markers(Vec::new());
                self.map.scene.set_rts_opacity(1.0);
                self.draw_eew_area(false);
            }
            Event::LpgmRelease(data) => self.show_lpgm(data),
            _ => {}
        }
    }
}
