//! The EEW rings and which EEW the info box shows (features/eew/eew.ts). PiP,
//! notifications and speech each follow the same events on their own.

use std::rc::Rc;

use crate::app::App;
use crate::domain::constants::{EEW_S_ALERT, EEW_S_WARN};
use crate::domain::types::EewData;
use crate::domain::utils::{circle_ring, ps_wave_dist, ring_step_km};
use crate::events::Event;
use crate::timers::{Task, TimerId};
use crate::variable::{EewDisplay, EewStatus, TriggerDisplay};

const EEW_CACHE_TTL_MS: f64 = 600_000.0;

struct Cached {
    data: Rc<EewData>,
    cache_time: f64,
}

/// The ring last sent to the map, so a sub-pixel step does not rebuild it.
#[derive(Clone, Copy, PartialEq)]
struct Drawn {
    lon: f64,
    lat: f64,
    zoom: f64,
    bg: bool,
    p: f64,
    s: f64,
}

#[derive(Default)]
pub struct EewState {
    rotation: usize,
    cache: Vec<(String, Cached)>,
    drawn: Vec<(String, Drawn)>,
    waves: Option<TimerId>,
}

impl App {
    pub fn eew_init(&mut self) {
        self.timers.interval(60_000.0, Task::EewCacheSweep);
        self.timers.interval(5000.0, Task::EewRotate);
    }

    fn eew_cache_put(&mut self, data: &Rc<EewData>) {
        let cache_time = self.var.real_now();
        let entry = Cached {
            data: Rc::clone(data),
            cache_time,
        };
        match self.eew.cache.iter_mut().find(|(id, _)| *id == data.id) {
            Some((_, slot)) => *slot = entry,
            None => self.eew.cache.push((data.id.clone(), entry)),
        }
    }

    fn create_eew_layer(&mut self, data: &EewData) {
        if !self.map.scene.has_wave(&data.id) {
            let color = if data.status == 1 {
                EEW_S_ALERT
            } else {
                EEW_S_WARN
            };
            self.map.scene.add_wave(&data.id, color);
        }
        if self.eew.waves.is_none() {
            self.eew.waves = Some(self.timers.interval(100.0, Task::EewWaves));
        }
    }

    fn remove_eew_layers(&mut self, id: &str) {
        self.eew.drawn.retain(|(known, _)| known != id);
        self.map.scene.remove_wave(id);
    }

    /// Grow every EEW's rings, every 100 ms while there is one to grow.
    pub fn eew_waves(&mut self) {
        if self.var.data.eew.is_empty() {
            self.timers.clear_slot(&mut self.eew.waves);
            return;
        }
        // No S background while dragging: it flickers under the drag.
        let bg = !self.focus.mouse_down;
        let zoom = (self.map.camera.zoom * 1000.0).round() / 1000.0;
        let now = self.var.now();
        for eew in &mut self.var.data.eew {
            if !self.map.scene.has_wave(&eew.id) {
                continue;
            }
            let dist = ps_wave_dist(eew.eq.depth, eew.eq.time, now);
            eew.dist = Some(dist);
            let step = ring_step_km(eew.eq.lat, zoom);
            let prev = self.eew.drawn.iter().find(|(id, _)| *id == eew.id);
            if let Some((_, prev)) = prev {
                if prev.bg == bg
                    && prev.lon == eew.eq.lon
                    && prev.lat == eew.eq.lat
                    && prev.zoom == zoom
                    && (prev.p - dist.p_dist).abs() < step
                    && (prev.s - dist.s_dist).abs() < step
                {
                    continue;
                }
            }
            let p = circle_ring(eew.eq.lon, eew.eq.lat, dist.p_dist, zoom);
            let s = circle_ring(eew.eq.lon, eew.eq.lat, dist.s_dist, zoom);
            self.map.scene.set_wave_rings(&eew.id, p, s, bg);
            let drawn = Drawn {
                lon: eew.eq.lon,
                lat: eew.eq.lat,
                zoom,
                bg,
                p: dist.p_dist,
                s: dist.s_dist,
            };
            match self.eew.drawn.iter_mut().find(|(id, _)| *id == eew.id) {
                Some((_, slot)) => *slot = drawn,
                None => self.eew.drawn.push((eew.id.clone(), drawn)),
            }
        }
    }

    /// Refresh the info box's choice, rotating through the active EEWs when `rotation`.
    pub fn show_eew(&mut self, rotation: bool) {
        let count = self.var.data.eew.len();
        let listed = self.eew.cache.len();
        if count > 0 && listed > 0 {
            self.var.cache.show_eew_box = true;
            self.ui.current_trigger = None;
            let at = self.eew.rotation;
            if let Some((_, cached)) = self.eew.cache.get(at) {
                let eew = &cached.data;
                let unit = eew.author.to_uppercase();
                self.ui.current_eew = Some(EewDisplay {
                    id: eew.id.clone(),
                    status: match eew.status {
                        3 => EewStatus::Cancel,
                        1 => EewStatus::Alert,
                        _ => EewStatus::Warn,
                    },
                    serial: eew.serial,
                    is_final: eew.is_final,
                    unit_text: if count == 1 {
                        unit
                    } else {
                        format!("{unit} {}/{count}", at + 1)
                    },
                    loc: eew.eq.loc.clone(),
                    depth: eew.eq.depth,
                    mag: eew.eq.mag,
                    max: eew.eq.max,
                    time: eew.eq.time,
                });
            }
            if rotation {
                self.eew.rotation += 1;
                if self.eew.rotation >= listed {
                    self.eew.rotation = 0;
                }
            }
        } else {
            self.var.cache.show_eew_box = false;
            self.ui.current_eew = None;
            let trigger = &self.var.cache.rts_trigger;
            self.ui.current_trigger = if trigger.loc.is_empty() {
                None
            } else {
                Some(TriggerDisplay {
                    max: trigger.max,
                    locations: trigger.loc.iter().take(8).cloned().collect(),
                })
            };
        }
        self.emit(Event::EewDisplayUpdate);
    }

    /// Announced as an end, so every module clears what it drew for that EEW.
    pub fn eew_sweep(&mut self) {
        let now = self.var.real_now();
        let expired: Vec<Rc<EewData>> = self
            .eew
            .cache
            .iter()
            .filter(|(_, c)| now - c.cache_time > EEW_CACHE_TTL_MS)
            .map(|(_, c)| {
                let mut data = (*c.data).clone();
                data.eew_end = true;
                Rc::new(data)
            })
            .collect();
        for data in expired {
            self.emit(Event::EewEnd(data));
        }
    }

    pub fn eew_on(&mut self, ev: &Event) {
        match ev {
            Event::EewRelease(data) => {
                self.eew_cache_put(data);
                self.show_eew(false);
                self.create_eew_layer(data);
            }
            Event::EewAlert(data) => {
                // Moved, not only recoloured: they go back on top.
                if self.map.scene.has_wave(&data.id) {
                    self.map.scene.recolour_wave(&data.id, EEW_S_ALERT);
                }
            }
            Event::EewUpdate(data) => {
                self.eew_cache_put(data);
                self.create_eew_layer(data);
                self.show_eew(false);
                self.refresh_cross(false);
                if data.status == 3 {
                    self.remove_eew_layers(&data.id);
                }
            }
            Event::EewEnd(data) => {
                self.remove_eew_layers(&data.id);
                self.eew.cache.retain(|(id, _)| *id != data.id);
                self.show_eew(true);
                self.refresh_cross(false);
            }
            _ => {}
        }
    }
}
