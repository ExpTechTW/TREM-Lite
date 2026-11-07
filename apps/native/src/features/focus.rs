//! The auto-focus camera (features/focus/focus.ts). Any touch of the map locks it until
//! the nav button releases it.

use std::time::Instant;

use crate::app::App;
use crate::domain::constants::{MAP_BOUNDS, MAP_PADDING};
use crate::events::Event;
use crate::map::camera::{Bounds, Padding};
use crate::map::MapEvent;
use crate::timers::{Task, TimerId};
use crate::variable::Coord;

/// The quickest the camera follows a change, and a fit's own duration: a frame every
/// 0.5 s must not restart the move before it lands.
const FOCUS_GAP_MS: f64 = 800.0;

pub struct FocusState {
    pub lock: bool,
    pub mouse_down: bool,
    last_focus: Option<Instant>,
    pending: Option<TimerId>,
    /// The triggered stations last followed, sorted, as a key.
    rts_key: Vec<(u64, u64)>,
    /// The stations `rts_key` was taken from: the same list is not sorted again.
    rts_key_from: Vec<Coord>,
    auto_zoom: bool,
}

impl FocusState {
    pub fn new(auto_zoom: bool) -> Self {
        Self {
            lock: false,
            mouse_down: false,
            last_focus: None,
            pending: None,
            rts_key: Vec::new(),
            rts_key_from: Vec::new(),
            auto_zoom,
        }
    }
}

impl App {
    pub fn focus_init(&mut self) {
        self.timers.interval(3000.0, Task::FocusTick);
    }

    /// Focus now, or within the gap, once it has passed, however many changes came.
    fn focus_soon(&mut self) {
        if self.focus.pending.is_some() {
            return;
        }
        let wait = self.focus.last_focus.map_or(0.0, |at| {
            FOCUS_GAP_MS - self.timers.now().duration_since(at).as_secs_f64() * 1000.0
        });
        if wait <= 0.0 {
            self.focus.last_focus = Some(self.timers.now());
            self.focus_now();
            return;
        }
        self.focus.pending = Some(self.timers.timeout(wait, Task::FocusPending));
    }

    pub fn focus_pending_fired(&mut self) {
        self.focus.pending = None;
        self.focus.last_focus = Some(self.timers.now());
        self.focus_now();
    }

    fn set_lock(&mut self, value: bool) {
        if self.focus.lock == value {
            return;
        }
        self.focus.lock = value;
        self.emit(Event::FocusLockChange(value));
    }

    /// The triggered stations changed: follow at once, after the frame's other
    /// handlers, rts's among them, which sets the bounds.
    pub fn focus_after_rts(&mut self) {
        if self.var.cache.bounds.rts == self.focus.rts_key_from {
            return;
        }
        self.focus
            .rts_key_from
            .clone_from(&self.var.cache.bounds.rts);
        let mut key: Vec<(u64, u64)> = self
            .focus
            .rts_key_from
            .iter()
            .map(|c| (c.lon.to_bits(), c.lat.to_bits()))
            .collect();
        key.sort_unstable();
        if key == self.focus.rts_key {
            return;
        }
        self.focus.rts_key = key;
        self.focus_soon();
    }

    /// Input reaching the map. Any touch locks auto-focus so the camera stops fighting.
    pub fn focus_on_map_event(&mut self, event: MapEvent) {
        let how = match event {
            MapEvent::MouseDown => {
                self.focus.mouse_down = true;
                "點擊"
            }
            MapEvent::MouseUp => {
                self.focus.mouse_down = false;
                return;
            }
            MapEvent::TouchStart => "觸控",
            MapEvent::Wheel => "捲動縮放",
            MapEvent::UserMove => "操作",
        };
        if !self.focus.lock {
            log::debug!(target: "focus", "使用者{how}地圖，自動聚焦暫停，按定位鈕恢復");
            self.set_lock(true);
        }
    }

    /// Recompute and apply the camera from the cached bounds and the live EEWs.
    pub fn focus_now(&mut self) {
        if self.config.checked("graphics-block-auto-zoom") || self.focus.lock {
            return;
        }
        if !self.var.cache.bounds.lpgm.is_empty() {
            let bounds = self.var.cache.bounds.lpgm.clone();
            self.update_map_bounds(&bounds);
            return;
        }
        if !self.var.cache.bounds.intensity.is_empty() {
            let bounds = self.var.cache.bounds.intensity.clone();
            self.update_map_bounds(&bounds);
            return;
        }
        let mut combined = self.var.cache.bounds.rts.clone();
        combined.extend(self.var.data.eew.iter().map(|e| Coord {
            lon: e.eq.lon,
            lat: e.eq.lat,
        }));
        if !combined.is_empty() {
            self.update_map_bounds(&combined);
        } else if self.var.cache.bounds.report.is_empty() {
            self.focus_reset(false);
        }
    }

    /// Back to all of Taiwan. The nav button also clears the lock.
    pub fn focus_reset(&mut self, is_btn: bool) {
        if self.config.checked("graphics-block-auto-zoom") && !is_btn {
            return;
        }
        if is_btn {
            self.set_lock(false);
        }
        self.fit_taiwan();
    }

    pub fn fit_taiwan(&mut self) {
        let [[west, south], [east, north]] = MAP_BOUNDS;
        self.map.fit_bounds(
            Bounds {
                west,
                south,
                east,
                north,
            },
            Padding::all(MAP_PADDING),
            f64::INFINITY,
            0.0,
        );
    }

    /// Fit the coordinates: 150 px clear on each side, no nearer than zoom 8, in 500 ms.
    pub fn update_map_bounds(&mut self, coordinates: &[Coord]) {
        let Some(bounds) = Bounds::around(coordinates.iter().map(|c| (c.lon, c.lat))) else {
            return;
        };
        self.map.fit_bounds(bounds, Padding::all(150.0), 8.0, 500.0);
    }

    pub fn focus_on_config(&mut self) {
        let enabled = !self.config.checked("graphics-block-auto-zoom");
        if enabled == self.focus.auto_zoom {
            return;
        }
        self.focus.auto_zoom = enabled;
        if enabled {
            self.focus_soon();
        } else {
            // Back to the normal view as soon as auto-zoom is disabled.
            self.focus_reset(true);
        }
    }

    pub fn focus_on(&mut self, ev: &Event) {
        match ev {
            Event::EewRelease(_) | Event::EewUpdate(_) | Event::EewEnd(_) => self.focus_now(),
            Event::DataRts(_) => self.after_dispatch(crate::app::Micro::FocusRts),
            // Brought forward, by an alert or by hand: where things are, now.
            Event::MainWindowHidden(false) => self.focus_soon(),
            _ => {}
        }
    }
}
