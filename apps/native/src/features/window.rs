//! Bringing the main window forward and PiP (features/window/window.ts, lib/pipBridge.ts),
//! and a downloaded update's restart (features/update/update.ts). The windows themselves
//! belong to the event loop, which carries out what these ask for.

use crate::app::{App, Micro};
use crate::backend::version;
use crate::events::Event;
use crate::timers::{Task, TimerId};

/// How long after the last event the app must stay quiet before it restarts.
const QUIET_MS: f64 = 5.0 * 60.0 * 1000.0;
const CHECK_MS: f64 = 10_000.0;

/// What the features ask of the windows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowCommand {
    ShowPip,
    HidePip,
    HideSettings,
    OpenSettings,
    FocusMain { critical: bool },
    ToggleMain,
    Restart { hidden: bool },
    Quit,
}

#[derive(Default)]
pub struct WindowState {
    /// Whether the main window was hidden or minimised, as last checked.
    pub main_unavailable: bool,
    /// As the event loop last saw it: visible and not minimised.
    pub main_shown: bool,
    /// The PiP window was shown and not hidden since.
    pub pip_shown: bool,
    last_event: f64,
    waiting: Option<TimerId>,
    last_wall_ms: i64,
}

impl App {
    fn has_pip_content(&self) -> bool {
        self.ui.current_eew.is_some() || self.ui.current_trigger.is_some()
    }

    fn hide_pip(&mut self) {
        if !self.window.pip_shown {
            return;
        }
        self.window.pip_shown = false;
        self.commands.push(WindowCommand::HidePip);
    }

    fn show_pip_for_alert(&mut self) -> bool {
        if !self.has_pip_content() || self.window.main_shown {
            return false;
        }
        self.window.pip_shown = true;
        self.commands.push(WindowCommand::ShowPip);
        true
    }

    /// PiP stands in only while the main window is hidden or minimised. Deferred past the
    /// event's other handlers, which update what PiP shows.
    fn surface_alert(&mut self, critical: bool, pip_eligible: bool) {
        self.after_dispatch(Micro::SurfaceAlert {
            critical,
            pip_eligible,
        });
    }

    pub fn surface_alert_now(&mut self, critical: bool, pip_eligible: bool) {
        if pip_eligible && !self.window.main_shown && self.show_pip_for_alert() {
            return;
        }
        self.hide_pip();
        self.commands.push(WindowCommand::FocusMain { critical });
    }

    pub fn window_init(&mut self, main_shown: bool) {
        self.window.main_shown = main_shown;
        self.window.main_unavailable = !main_shown;
        self.window.last_wall_ms = self.var.wall_ms() as i64;
        // Started to the tray: the stream sleeps from the outset.
        if !main_shown {
            self.emit(Event::MainWindowHidden(true));
        }
        self.timers.interval(500.0, Task::WindowWatch);
    }

    /// The 500 ms check, of the state the event loop keeps current. It is also what
    /// notices a machine that slept: the stream's connection may be dead.
    pub fn window_watch(&mut self) {
        let wall = self.var.wall_ms() as i64;
        if wall - self.window.last_wall_ms > 10_000 {
            self.data_network_back();
        }
        self.window.last_wall_ms = wall;

        let unavailable = !self.window.main_shown;
        if unavailable != self.window.main_unavailable {
            self.emit(Event::MainWindowHidden(unavailable));
        }
        if !unavailable {
            self.window.main_unavailable = false;
            // The invariant, not only the transition: never PiP beside a visible main.
            self.hide_pip();
            return;
        }
        if self.window.main_unavailable {
            return;
        }
        self.window.main_unavailable = true;
        if self.has_pip_content() {
            self.show_pip_for_alert();
        }
    }

    pub fn window_on(&mut self, ev: &Event) {
        let enabled = |app: &Self, key: &str| app.config.checked(key);
        match ev {
            Event::EewRelease(_) | Event::EewAlert(_) | Event::EewNewAreaAlert(_) => {
                if enabled(self, "show-window-eew") {
                    self.surface_alert(true, true);
                }
            }
            Event::RtsPga2 => {
                if enabled(self, "show-window-detect") {
                    self.surface_alert(true, false);
                }
            }
            Event::RtsPga1 => {
                if enabled(self, "show-window-detect") {
                    self.surface_alert(false, false);
                }
            }
            Event::RtsShindo2 => {
                if enabled(self, "show-window-detect") {
                    self.surface_alert(true, true);
                }
            }
            Event::RtsShindo1 | Event::RtsShindo0 => {
                if enabled(self, "show-window-detect") {
                    self.surface_alert(false, true);
                }
            }
            Event::ReportRelease { .. } => {
                if enabled(self, "show-window-report") {
                    self.surface_alert(false, false);
                }
            }
            Event::IntensityRelease(_) | Event::LpgmRelease(_)
                if enabled(self, "show-window-rts-intensity") =>
            {
                self.surface_alert(true, false);
            }
            _ => {}
        }
        // What is on the map then matters more than the page on top of it.
        if matches!(
            ev,
            Event::EewRelease(_)
                | Event::EewAlert(_)
                | Event::EewNewAreaAlert(_)
                | Event::RtsPga2
                | Event::RtsPga1
                | Event::RtsShindo2
                | Event::RtsShindo1
                | Event::RtsShindo0
                | Event::ReportRelease { .. }
                | Event::IntensityRelease(_)
                | Event::LpgmRelease(_)
        ) {
            self.commands.push(WindowCommand::HideSettings);
        }
    }

    /// What PiP shows changed. Nothing left to show hides it.
    pub fn pip_on(&mut self, ev: &Event) {
        if matches!(ev, Event::EewDisplayUpdate) && !self.has_pip_content() {
            self.hide_pip();
        }
    }

    // ---- The update's restart ---------------------------------------------

    fn quiet(&self) -> bool {
        self.var.play_mode == 0
            && self.var.data.eew.is_empty()
            && !self.var.cache.rts_alert
            && !self.var.cache.show_intensity
            && !self.var.cache.show_lpgm
            && self.var.real_now() - self.window.last_event > QUIET_MS
    }

    pub fn restart_for_update(&mut self) {
        self.commands.push(WindowCommand::Restart {
            hidden: self.window.main_unavailable,
        });
    }

    /// An update is downloaded and waits for a restart.
    pub fn update_staged(&mut self, version_text: &str) {
        self.ui.update_ready = version::label(version_text);
        let label = self.ui.update_ready.clone();
        self.emit(Event::UpdateReady(label.clone()));
        if self.config.checked("update-auto-restart") {
            log::info!(target: "update", "更新 {label} 等待重新啟動：沒有預警、測站警報、震度速報、重播，且 5m 沒有新事件時自動重啟");
        } else {
            log::info!(target: "update", "更新 {label} 等待重新啟動：自動重啟已關閉，等使用者按");
        }
        if self.window.waiting.is_none() {
            self.window.waiting = Some(self.timers.interval(CHECK_MS, Task::UpdateWait));
        }
    }

    pub fn update_wait(&mut self) {
        if self.config.checked("update-auto-restart") && self.quiet() {
            log::info!(target: "update", "已安靜，自動重新啟動以完成更新 {}", self.ui.update_ready);
            self.restart_for_update();
        }
    }

    pub fn update_on(&mut self, ev: &Event) {
        if matches!(
            ev,
            Event::EewRelease(_)
                | Event::EewUpdate(_)
                | Event::RtsShindo0
                | Event::IntensityRelease(_)
                | Event::ReportRelease { .. }
        ) {
            self.window.last_event = self.var.real_now();
        }
    }
}
