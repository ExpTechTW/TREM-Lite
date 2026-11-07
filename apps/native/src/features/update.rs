//! A downloaded update, restarted for once nothing is going on (features/update/update.ts):
//! no EEW, no station alert, no overlay, no replay, and no event for five minutes.

use crate::app::App;
use crate::backend::version;
use crate::events::Event;
use crate::features::window::WindowCommand;
use crate::timers::{Task, TimerId};

/// How long after the last event the app must stay quiet before it restarts.
const QUIET_MS: f64 = 5.0 * 60.0 * 1000.0;
const CHECK_MS: f64 = 10_000.0;

#[derive(Default)]
pub struct UpdateState {
    last_event: f64,
    waiting: Option<TimerId>,
}

impl App {
    fn quiet(&self) -> bool {
        self.var.play_mode == 0
            && self.var.data.eew.is_empty()
            && !self.var.cache.rts_alert
            && !self.var.cache.show_intensity
            && !self.var.cache.show_lpgm
            && self.var.real_now() - self.update.last_event > QUIET_MS
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
        if self.update.waiting.is_none() {
            self.update.waiting = Some(self.timers.interval(CHECK_MS, Task::UpdateWait));
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
            self.update.last_event = self.var.real_now();
        }
    }
}
