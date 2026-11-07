//! The rules the features keep, each pinned on its own. The TS modules' comments are the
//! spec; the scenario files pin what the rules add up to.

use std::collections::HashMap;
use std::sync::OnceLock;

use super::{Harness, QUAKE_ORIGIN_MS};
use crate::domain::types::{parse_eew_list, IntensityReport};
use crate::events::Event;
use crate::features::window::WindowCommand;
use crate::host::Output;

const NOW: f64 = QUAKE_ORIGIN_MS;

fn harness() -> Harness {
    let mut h = Harness::new(NOW, super::spec_answers(), Harness::default_config());
    h.app.window.main_shown = true;
    h.logging = false;
    h
}

fn eew(id: &str, author: &str, serial: i64, status: i32, eq_time: f64) -> String {
    format!(
        r#"{{"id":"{id}","author":"{author}","serial":{serial},"status":{status},"time":{eq_time},
            "eq":{{"lat":22.8,"lon":121.3,"depth":20,"mag":5.9,"max":5,"loc":"臺東縣近海","time":{eq_time}}}}}"#
    )
}

fn feed(h: &mut Harness, items: &[String]) {
    let list = parse_eew_list(
        &serde_json::from_str(&format!("[{}]", items.join(","))).expect("test JSON"),
    );
    h.app.process_eew(list);
    h.settle();
}

fn events(h: &mut Harness) -> Vec<String> {
    std::mem::take(&mut h.app.trace)
        .iter()
        .filter(|e| !matches!(e, Event::EewDisplayUpdate))
        .map(|e| e.name().to_string())
        .collect()
}

#[test]
fn an_eew_is_released_once_updated_by_serial_and_cancelled() {
    let mut h = harness();
    let t = NOW - 10_000.0;
    feed(&mut h, &[eew("1", "cwa", 3, 0, t)]);
    // Predicted 5弱 in Taitung: the area alert follows.
    assert_eq!(events(&mut h), ["EewRelease", "EewNewAreaAlert"]);
    // The same serial again (a reconnect, another EEW's change) is no update.
    feed(&mut h, &[eew("1", "cwa", 3, 0, t)]);
    assert!(events(&mut h).is_empty());
    feed(&mut h, &[eew("1", "cwa", 4, 1, t)]);
    assert_eq!(events(&mut h), ["EewUpdate", "EewAlert"]);
    feed(&mut h, &[eew("1", "cwa", 5, 3, t)]);
    assert_eq!(events(&mut h), ["EewUpdate", "EewCancel"]);
    // A cancelled EEW ends 60 s after the cancel.
    h.advance(59_000);
    events(&mut h);
    feed(&mut h, &[]);
    assert!(!events(&mut h).contains(&"EewEnd".to_string()));
    h.advance(2_000);
    feed(&mut h, &[]);
    assert!(events(&mut h).contains(&"EewEnd".to_string()));
    assert!(h.app.var.data.eew.is_empty());
}

#[test]
fn only_cwa_is_shown_and_an_old_eew_never_appears() {
    let mut h = harness();
    feed(&mut h, &[eew("2", "jma", 1, 0, NOW - 5_000.0)]);
    feed(&mut h, &[eew("3", "cwa", 1, 0, NOW - 241_000.0)]);
    assert!(events(&mut h).is_empty());
    assert!(h.app.var.data.eew.is_empty());
}

#[test]
fn an_eew_ends_240_seconds_after_its_origin() {
    let mut h = harness();
    feed(&mut h, &[eew("4", "cwa", 1, 0, NOW)]);
    events(&mut h);
    h.advance(240_000);
    feed(&mut h, &[]);
    assert!(!events(&mut h).contains(&"EewEnd".to_string()));
    h.advance(1_000);
    feed(&mut h, &[]);
    assert!(events(&mut h).contains(&"EewEnd".to_string()));
}

#[test]
fn an_eew_sounds_notifies_and_speaks_by_its_settings() {
    let mut h = harness();
    feed(&mut h, &[eew("5", "cwa", 1, 1, NOW)]);
    let outputs = std::mem::take(&mut h.app.host.outputs);
    assert!(outputs.contains(&Output::Enqueue {
        queue: "eew".into(),
        sound: "ALERT".into()
    }));
    assert!(outputs
        .iter()
        .any(|o| matches!(o, Output::Notify { title, .. } if title.contains("緊急地震速報"))));
    // The place and the predicted maximum are read out on the 3 s tick, once the area
    // alert, which goes first, has been spoken.
    assert!(outputs.iter().any(
        |o| matches!(o, Output::Speak { text, queue: false } if text.contains("慎防強烈搖晃"))
    ));
    h.app
        .speech_ended(crate::features::alerts::SpeechEnd::AreaAlert);
    h.app.run_task(crate::timers::Task::SpeechTick);
    let spoken: Vec<_> = std::mem::take(&mut h.app.host.outputs)
        .into_iter()
        .filter_map(|o| match o {
            Output::Speak { text, .. } => Some(text),
            _ => None,
        })
        .collect();
    assert_eq!(spoken, ["臺東縣近海發生地震", "預估最大震度5弱"]);

    let mut quiet = harness();
    let mut config = quiet.app.config.clone();
    config.check_box.insert("sound-effects-EEW2".into(), false);
    config.check_box.insert("other-tts".into(), false);
    quiet.app.write_config(config);
    feed(&mut quiet, &[eew("6", "cwa", 1, 1, NOW)]);
    quiet.app.run_task(crate::timers::Task::SpeechTick);
    let outputs = std::mem::take(&mut quiet.app.host.outputs);
    assert!(!outputs
        .iter()
        .any(|o| matches!(o, Output::Enqueue { .. } | Output::Speak { .. })));
}

#[test]
fn an_alert_brings_the_window_or_pip_by_whether_the_window_is_hidden() {
    let mut h = harness();
    feed(&mut h, &[eew("7", "cwa", 1, 1, NOW)]);
    let commands = std::mem::take(&mut h.app.commands);
    assert!(commands.contains(&WindowCommand::FocusMain { critical: true }));
    assert!(commands.contains(&WindowCommand::HideSettings));

    let mut hidden = harness();
    hidden.app.window.main_shown = false;
    feed(&mut hidden, &[eew("8", "cwa", 1, 1, NOW)]);
    let commands = std::mem::take(&mut hidden.app.commands);
    assert!(commands.contains(&WindowCommand::ShowPip));
    assert!(!commands
        .iter()
        .any(|c| matches!(c, WindowCommand::FocusMain { .. })));

    let mut off = harness();
    let mut config = off.app.config.clone();
    config.check_box.insert("show-window-eew".into(), false);
    off.app.write_config(config);
    feed(&mut off, &[eew("9", "cwa", 1, 1, NOW)]);
    let commands = std::mem::take(&mut off.app.commands);
    // The settings window still goes: what is on the map matters more.
    assert!(!commands.is_empty());
    assert!(commands.iter().all(|c| *c == WindowCommand::HideSettings));
}

fn intensity(id: f64, serial: i64, area: Vec<(i32, Vec<i32>)>) -> IntensityReport {
    IntensityReport {
        id,
        serial,
        status: String::new(),
        max: area.iter().map(|(l, _)| *l).max().unwrap_or(0),
        area,
        ended: false,
    }
}

#[test]
fn a_shake_report_updates_only_when_its_area_changes_and_ends_after_600_seconds() {
    let mut h = harness();
    let id = NOW - 1_000.0;
    h.app
        .process_intensity(vec![intensity(id, 1, vec![(3, vec![970])])]);
    assert_eq!(
        events(&mut h),
        ["IntensityRelease", "DataRts", "ReportListUpdate"]
    );
    h.app
        .process_intensity(vec![intensity(id, 2, vec![(3, vec![970])])]);
    assert!(events(&mut h).is_empty());
    h.app
        .process_intensity(vec![intensity(id, 3, vec![(3, vec![970, 971])])]);
    assert_eq!(
        events(&mut h),
        ["IntensityUpdate", "DataRts", "ReportListUpdate"]
    );
    h.advance(600_000);
    h.app.process_intensity(Vec::new());
    assert!(events(&mut h).contains(&"IntensityEnd".to_string()));
}

#[test]
fn the_map_shows_a_shake_report_for_7_5_seconds() {
    let mut h = harness();
    h.app
        .process_intensity(vec![intensity(NOW, 1, vec![(4, vec![1001, 970])])]);
    assert!(h.app.var.cache.show_intensity);
    assert_eq!(h.app.map.scene.rts_opacity, 0.2);
    assert!(!h.app.map.scene.intensity_markers.is_empty());
    h.advance(7_400);
    assert!(h.app.var.cache.show_intensity);
    h.advance(200);
    assert!(!h.app.var.cache.show_intensity);
    assert!(h.app.map.scene.intensity_markers.is_empty());
    assert_eq!(h.app.map.scene.rts_opacity, 1.0);
}

#[test]
fn switching_mode_ends_everything_and_silences_it() {
    let mut h = harness();
    feed(&mut h, &[eew("10", "cwa", 1, 0, NOW)]);
    h.app
        .process_intensity(vec![intensity(NOW, 1, vec![(2, vec![970])])]);
    events(&mut h);
    h.app.host.outputs.clear();
    h.app.start_replay(NOW - 60_000.0, None);
    h.settle();
    let seen = events(&mut h);
    let wanted = [
        "EewEnd",
        "IntensityEnd",
        "DataModeReset",
        "DataRts",
        "ReplayStateChange",
    ];
    for name in wanted {
        assert!(seen.contains(&name.to_string()), "{name} in {seen:?}");
    }
    assert!(h.app.var.data.eew.is_empty() && h.app.var.data.intensity.is_empty());
    let outputs = std::mem::take(&mut h.app.host.outputs);
    assert!(outputs.contains(&Output::StopSounds) && outputs.contains(&Output::StopSpeech));
    assert_eq!(h.app.var.play_mode, 2);
}

#[test]
fn a_touch_of_the_map_stops_auto_focus_until_the_button() {
    let mut h = harness();
    h.app.focus_on_map_event(crate::map::MapEvent::Wheel);
    assert!(h.app.focus.lock);
    let before = h.app.map.camera.center();
    feed(&mut h, &[eew("11", "cwa", 1, 0, NOW)]);
    h.advance(3_000);
    assert_eq!(h.app.map.camera.center(), before);
    h.app.focus_reset(true);
    assert!(!h.app.focus.lock);
}

#[test]
fn reports_are_seeded_silently_then_new_ones_released() {
    // The list as the server first gives it, and later with one more on top.
    static ANSWERS: OnceLock<HashMap<String, String>> = OnceLock::new();
    let answers = ANSWERS.get_or_init(|| {
        let item = |id: &str, time: f64| {
            format!(
                r#"{{"id":"{id}","lat":23,"lon":121,"depth":10,"loc":"花蓮縣秀林鄉","mag":4.1,"time":{time},"int":3}}"#
            )
        };
        let mut m = HashMap::new();
        let list = "https://api.core.exptech.dev/api/v2/eq/report?limit=75";
        m.insert(list.to_string(), format!("[{}]", item("1", NOW - 3_600_000.0)));
        m.insert(
            "https://api.core.exptech.dev/api/v2/eq/report/2".to_string(),
            item("2", NOW - 60_000.0),
        );
        m.insert(
            "later".to_string(),
            format!("[{},{}]", item("2", NOW - 60_000.0), item("1", NOW - 3_600_000.0)),
        );
        m
    });
    let mut h = Harness::new(NOW, answers, Harness::default_config());
    h.app.window.main_shown = true;
    h.logging = false;
    h.app.report_init();
    h.settle();
    assert_eq!(h.app.var.data.report.len(), 1);
    assert!(!events(&mut h).contains(&"ReportRelease".to_string()));

    let later = answers.get("later").cloned();
    h.app
        .report_text(crate::features::report::ReportFetch::List, later);
    h.settle();
    let released: Vec<String> = std::mem::take(&mut h.app.trace)
        .iter()
        .filter_map(|e| match e {
            Event::ReportRelease { data, update } => Some(format!("{}:{update}", data.id)),
            _ => None,
        })
        .collect();
    assert_eq!(released, ["2:false"]);
}
