//! What flashes on the map: the EEW crosses (features/cross/cross.ts), the detection
//! boxes or their stand-in wavefronts (features/box/box.ts), and the 500 ms beat and
//! the disconnection check that drive them (features/loop/loop.ts).

use trem_core::intensity::intensity_float_to_int;
use trem_core::region;
use trem_core::travel_time::ps_wave_dist;

use crate::app::App;
use crate::domain::constants::{level_color, LAST_DATA_TIMEOUT_ERROR};
use crate::domain::types::{EewData, RtsData, RtsEq};
use crate::domain::utils::{circle_ring, distance};
use crate::events::Event;
use crate::map::icons::IconId;
use crate::map::scene::{rel, DotInstance, Stroke, Symbol};
use crate::timers::{Task, TimerId};

/// An EEW this close (km, horizontal) to a listed earthquake is taken to be it.
const EEW_NEAR_KM: f64 = 50.0;

#[derive(Default)]
pub struct FlashState {
    box_alert: bool,
    eq_alert: bool,
    flash: bool,
    map_initialized: bool,
    beat: Option<TimerId>,
}

/// True when the EEW's S wave has engulfed all four corners of a box.
fn box_engulfed(eew: &EewData, ring: &[[f64; 2]]) -> bool {
    let Some(dist) = eew.dist else {
        return false;
    };
    ring.iter().take(4).all(|c| {
        let km = distance(eew.eq.lat, eew.eq.lon, c[1], c[0]);
        dist.s_dist > km
    })
}

impl App {
    pub fn refresh_cross(&mut self, show: bool) {
        let list: Vec<&EewData> = self
            .var
            .data
            .eew
            .iter()
            .filter(|e| e.status == 3 || self.map.scene.has_wave(&e.id))
            .collect();
        let many = list.len() > 1;
        let mut markers = Vec::new();
        for (index, eew) in list.iter().enumerate() {
            let no = if many { index + 1 } else { index };
            if !(show || eew.status == 3) {
                continue;
            }
            let no = if no < 5 { no as u8 } else { 0 };
            markers.push(Symbol {
                lon: eew.eq.lon,
                lat: eew.eq.lat,
                icon: if (1..=4).contains(&no) {
                    IconId::CrossNumbered(no)
                } else {
                    IconId::Cross
                },
                sort: f32::from(no),
                opacity: if eew.status == 3 { 0.6 } else { 1.0 },
            });
        }
        self.map.scene.set_cross(markers);
    }

    fn clear_boxes(&mut self) {
        if !self.flash.box_alert {
            return;
        }
        self.flash.box_alert = false;
        self.map.scene.set_boxes(Vec::new());
    }

    fn clear_eq_waves(&mut self) {
        if !self.flash.eq_alert {
            return;
        }
        self.flash.eq_alert = false;
        self.map.scene.set_eq_waves(Vec::new(), Vec::new());
    }

    /// Each earthquake's colour level: the highest among the triggered stations nearer
    /// to it than to any other listed one.
    fn eq_levels(&self, rts: &RtsData, eqs: &[RtsEq]) -> Vec<i32> {
        let mut levels = vec![0; eqs.len()];
        for (id, s) in &rts.station {
            if !s.alert {
                continue;
            }
            let mut nearest = 0;
            if eqs.len() > 1 {
                let Some(at) = self.var.station.as_ref().and_then(|list| list.get(id)) else {
                    continue;
                };
                let mut best = f64::INFINITY;
                for (n, eq) in eqs.iter().enumerate() {
                    let km = distance(eq[0], eq[1], at.lat, at.lon);
                    if km < best {
                        best = km;
                        nearest = n;
                    }
                }
            }
            levels[nearest] = levels[nearest].max(intensity_float_to_int(s.i));
        }
        levels
    }

    fn refresh_eq_waves(&mut self, rts: &RtsData, eqs: &[RtsEq], show: bool) {
        let mut rings = Vec::new();
        let mut dots = Vec::new();
        if show {
            let levels = self.eq_levels(rts, eqs);
            let time = self.var.now();
            let zoom = self.map.camera.zoom;
            for (n, eq) in eqs.iter().enumerate() {
                let [lat, lon, depth, origin] = *eq;
                let near_eew = self
                    .var
                    .data
                    .eew
                    .iter()
                    .any(|e| distance(lat, lon, e.eq.lat, e.eq.lon) <= EEW_NEAR_KM);
                if near_eew {
                    continue;
                }
                let color = level_color(levels[n]);
                dots.push(DotInstance {
                    pos: rel(lon, lat),
                    color,
                });
                let radius = ps_wave_dist(depth, origin * 1000.0, time).s_dist;
                // 0 until the S wave has left the hypocentre and reached the surface.
                if radius <= 0.0 || radius.is_nan() {
                    continue;
                }
                rings.push(Stroke {
                    points: circle_ring(lon, lat, radius, zoom),
                    color,
                });
            }
        }
        if !rings.is_empty() || !dots.is_empty() {
            self.flash.eq_alert = true;
            self.map.scene.set_eq_waves(rings, dots);
        } else if self.flash.eq_alert {
            self.flash.eq_alert = false;
            self.map.scene.set_eq_waves(Vec::new(), Vec::new());
        }
    }

    /// Rebuild the flashing overlay from the latest frame; `show` is the flash phase.
    pub fn refresh_box(&mut self, show: bool) {
        let rts = match &self.var.data.rts {
            Some(rts) if !rts.boxes.is_empty() => std::rc::Rc::clone(rts),
            _ => {
                // No boxes to show, so nothing to stand in for them either.
                self.clear_boxes();
                self.clear_eq_waves();
                return;
            }
        };
        if !rts.eq.is_empty() {
            self.clear_boxes();
            self.refresh_eq_waves(&rts, &rts.eq, show);
            return;
        }
        self.clear_eq_waves();

        let mut strokes: Vec<(i32, Stroke)> = Vec::new();
        if show {
            for area in region::boxes() {
                let Some(level) = rts.box_level(area.id) else {
                    continue;
                };
                if self
                    .var
                    .data
                    .eew
                    .iter()
                    .any(|eew| box_engulfed(eew, &area.ring))
                {
                    continue;
                }
                strokes.push((
                    level,
                    Stroke {
                        points: area.ring.clone(),
                        color: level_color(level),
                    },
                ));
            }
        }
        strokes.sort_by_key(|(level, _)| *level);
        self.flash.box_alert = true;
        self.map
            .scene
            .set_boxes(strokes.into_iter().map(|(_, s)| s).collect());
    }

    // ---- The beat ---------------------------------------------------------

    /// A cross that blinks, or detection boxes and their stand-ins.
    fn needs_beat(&self) -> bool {
        self.var.data.eew.iter().any(|e| e.status != 3)
            || self
                .var
                .data
                .rts
                .as_ref()
                .is_some_and(|rts| !rts.boxes.is_empty())
    }

    pub fn loop_beat(&mut self) {
        if !self.needs_beat() {
            self.refresh_cross(false);
            self.refresh_box(false);
            self.timers.clear_slot(&mut self.flash.beat);
            return;
        }
        self.flash.flash = !self.flash.flash;
        let flash = self.flash.flash;
        self.refresh_cross(flash);
        self.refresh_box(flash);
    }

    /// Start the blink if something needs it. Idle, this timer does not run.
    fn poke(&mut self) {
        if !self.flash.map_initialized || self.flash.beat.is_some() || !self.needs_beat() {
            return;
        }
        self.flash.flash = true;
        self.refresh_cross(true);
        self.refresh_box(true);
        self.flash.beat = Some(self.timers.interval(500.0, Task::LoopBeat));
    }

    pub fn loop_init(&mut self) {
        self.timers.interval(1000.0, Task::LoopInternet);
        // Fixture mode and tests never touch the network.
        if self.host.online() {
            self.clock_sync();
            self.timers.interval(600_000.0, Task::ClockSync);
        }
    }

    /// The flag changes only with a change; a hidden window's stream sleeps, so no data
    /// then is not a lost connection.
    pub fn loop_internet(&mut self) {
        let err = self.var.play_mode != 2
            && self.var.play_mode != 3
            && !self.data_state.asleep
            && self.var.real_now() - self.var.cache.last_data_time > LAST_DATA_TIMEOUT_ERROR;
        if err != self.ui.internet_error {
            self.ui.internet_error = err;
            self.emit(Event::InternetErrorChange(err));
        }
    }

    pub fn loop_on(&mut self, ev: &Event) {
        match ev {
            Event::MapLoad => {
                if self.flash.map_initialized {
                    return;
                }
                self.flash.map_initialized = true;
                self.poke();
            }
            Event::DataRts(_) | Event::EewRelease(_) | Event::EewUpdate(_) => self.poke(),
            _ => {}
        }
    }
}
