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

const REPORT_LIST: &str = "https://api.core.exptech.dev/api/v2/eq/report?limit=75";

fn listed(id: &str, time: f64, mag: f64) -> String {
    format!(
        r#"{{"id":"{id}","lat":23,"lon":121,"depth":10,"loc":"花蓮縣秀林鄉","mag":{mag},"time":{time},"int":3}}"#
    )
}

fn report_page(id: &str) -> String {
    format!("https://api.core.exptech.dev/api/v2/eq/report/{id}")
}

/// An `eq.report.v1` message as the stream's worker hands it over.
fn pushed(reason: i64, id: &str, time: f64, mag: f64, lat: f64, int: i32) -> crate::app::Msg {
    let text = serde_json::json!({
        "reason": reason,
        "data": {
            "id": id, "lat": lat, "lon": 121, "depth": 10, "loc": "花蓮縣秀林鄉",
            "mag": mag, "time": time,
            "list": {"花蓮縣": {"int": int, "town": {"秀林": {"lat": 24.1, "lon": 121.6, "int": int}}}}
        }
    })
    .to_string();
    let (reason, item) =
        crate::features::report::parse_stream_report(&text).expect("a report message");
    crate::app::Msg::ReportStream {
        reason,
        item: Box::new(item),
    }
}

/// The list's changes and releases since the last call.
fn report_events(h: &mut Harness) -> Vec<String> {
    h.settle();
    std::mem::take(&mut h.app.trace)
        .iter()
        .filter_map(|e| match e {
            Event::ReportListUpdate => Some("list".to_string()),
            Event::ReportRelease { data, update } => Some(format!("release {}:{update}", data.id)),
            _ => None,
        })
        .collect()
}

fn report_ids(h: &Harness) -> Vec<String> {
    h.app.var.data.report.iter().map(|r| r.id.clone()).collect()
}

fn list_fetches(h: &Harness) -> usize {
    h.requests
        .lock()
        .map(|r| r.iter().filter(|url| *url == REPORT_LIST).count())
        .unwrap_or_default()
}

fn report_harness(answers: &'static HashMap<String, String>) -> Harness {
    let mut h = Harness::new(NOW, answers, Harness::default_config());
    h.app.window.main_shown = true;
    h.logging = false;
    h.app.report_init();
    h.settle();
    std::mem::take(&mut h.app.trace);
    h
}

#[test]
fn reports_are_fetched_once_then_follow_the_stream() {
    static ANSWERS: OnceLock<HashMap<String, String>> = OnceLock::new();
    let answers = ANSWERS.get_or_init(|| {
        let mut m = HashMap::new();
        m.insert(
            REPORT_LIST.to_string(),
            format!("[{}]", listed("1", NOW - 3_600_000.0, 4.1)),
        );
        m.insert(
            report_page("3"),
            r#"{"id":"3","lat":23.5,"lon":121,"depth":10,"loc":"花蓮縣秀林鄉","mag":3.8,"time":1787641091000,"int":2,"trem":1787641090000,"list":{}}"#
                .to_string(),
        );
        m
    });
    let mut h = report_harness(answers);
    assert_eq!(report_ids(&h), ["1"]);
    assert_eq!(list_fetches(&h), 1);
    // Nothing polls.
    h.advance(30 * 60_000);
    assert_eq!(list_fetches(&h), 1);
    assert!(report_events(&mut h).is_empty());

    // In real time: its single report is not stored yet (404), so what came is released.
    h.app.on_msg(pushed(0, "2", NOW - 60_000.0, 4.2, 23.623, 4));
    assert_eq!(report_events(&mut h), ["list", "release 2:false"]);
    assert_eq!(report_ids(&h), ["2", "1"]);
    assert_eq!(h.app.var.data.report[0].int, 4);
    // The same message again changes nothing.
    h.app.on_msg(pushed(0, "2", NOW - 60_000.0, 4.2, 23.623, 4));
    assert!(report_events(&mut h).is_empty());
    // Stored: rounded, with the same time and size. The row takes it, and it is no news.
    h.app.on_msg(pushed(1, "2", NOW - 60_000.0, 4.2, 23.62, 4));
    assert_eq!(report_events(&mut h), ["list"]);
    assert_eq!(h.app.var.data.report[0].lat, 23.62);
    // A later revision of its size is an update.
    h.app.on_msg(pushed(2, "2", NOW - 60_000.0, 4.4, 23.62, 4));
    assert_eq!(report_events(&mut h), ["list", "release 2:true"]);

    // Maintenance re-sending an old report, and one felt nowhere, which the list leaves out.
    h.app
        .on_msg(pushed(3, "old", NOW - 40.0 * 86_400_000.0, 5.0, 23.0, 3));
    h.app
        .on_msg(pushed(1, "quiet", NOW - 30_000.0, 3.0, 23.0, 0));
    assert!(report_events(&mut h).is_empty());
    assert_eq!(report_ids(&h), ["2", "1"]);

    // A recent one with reason 3 counts. Stored, its single report is fetched and released.
    h.app.on_msg(pushed(3, "3", NOW - 120_000.0, 3.8, 23.5, 2));
    assert_eq!(report_events(&mut h), ["list", "release 3:false"]);
    assert_eq!(report_ids(&h), ["2", "3", "1"]);
    let shown = h.app.var.cache.last_report.as_ref().map(|r| r.trem);
    assert_eq!(shown, Some(1_787_641_090_000.0));
    assert_eq!(list_fetches(&h), 1);
}

#[test]
fn each_connection_fetches_the_list_again_and_keeps_what_is_not_stored_yet() {
    static ANSWERS: OnceLock<HashMap<String, String>> = OnceLock::new();
    let answers = ANSWERS.get_or_init(|| {
        let mut m = HashMap::new();
        m.insert(
            REPORT_LIST.to_string(),
            format!("[{}]", listed("1", NOW - 3_600_000.0, 4.1)),
        );
        m.insert(report_page("4"), listed("4", NOW - 20_000.0, 3.5));
        m
    });
    let mut h = report_harness(answers);
    // The stream is up: the list once more, the same, so nothing changes.
    h.app.on_msg(crate::app::Msg::StreamUp);
    assert!(report_events(&mut h).is_empty());
    assert_eq!(list_fetches(&h), 2);

    h.app.on_msg(pushed(0, "5", NOW - 10_000.0, 4.0, 23.004, 3));
    assert_eq!(report_events(&mut h), ["list", "release 5:false"]);

    // A reconnect: the list fetched then has one missed meanwhile, and not yet "5".
    h.app.on_msg(crate::app::Msg::StreamUp);
    h.settle();
    assert_eq!(list_fetches(&h), 3);
    let reconnected = format!(
        "[{},{}]",
        listed("4", NOW - 20_000.0, 3.5),
        listed("1", NOW - 3_600_000.0, 4.1)
    );
    h.app.report_text(
        crate::features::report::ReportFetch::List,
        Some(reconnected),
    );
    assert_eq!(report_events(&mut h), ["list", "release 4:false"]);
    assert_eq!(report_ids(&h), ["5", "4", "1"]);

    // Stored, "5" is in the list, rounded: no news.
    let stored = format!(
        "[{},{},{}]",
        listed("5", NOW - 10_000.0, 4.0),
        listed("4", NOW - 20_000.0, 3.5),
        listed("1", NOW - 3_600_000.0, 4.1)
    );
    h.app
        .report_text(crate::features::report::ReportFetch::List, Some(stored));
    assert_eq!(report_events(&mut h), ["list"]);
    assert_eq!(report_ids(&h), ["5", "4", "1"]);
    assert_eq!(h.app.var.data.report[0].lat, 23.0);
    // Its real-time copy, should it come late, is older news.
    h.app.on_msg(pushed(0, "5", NOW - 10_000.0, 4.0, 23.004, 3));
    assert!(report_events(&mut h).is_empty());
}

#[test]
fn the_list_stays_newest_first_and_as_long_as_the_fetched_one() {
    static ANSWERS: OnceLock<HashMap<String, String>> = OnceLock::new();
    let answers = ANSWERS.get_or_init(|| {
        let items: Vec<String> = (0..75)
            .map(|i| listed(&format!("r{i}"), NOW - f64::from(i + 1) * 3_600_000.0, 4.0))
            .collect();
        HashMap::from([(REPORT_LIST.to_string(), format!("[{}]", items.join(",")))])
    });
    let mut h = report_harness(answers);
    assert_eq!(h.app.var.data.report.len(), 75);
    h.app.on_msg(pushed(1, "new", NOW - 60_000.0, 4.0, 23.0, 2));
    assert_eq!(report_events(&mut h), ["list", "release new:false"]);
    let ids = report_ids(&h);
    assert_eq!(ids.len(), 75);
    assert_eq!((ids[0].as_str(), ids[74].as_str()), ("new", "r73"));
    // One older than every listed report has no place in it.
    h.app.on_msg(pushed(
        2,
        "ancient",
        NOW - 100.0 * 3_600_000.0,
        4.0,
        23.0,
        2,
    ));
    assert!(report_events(&mut h).is_empty());
    assert_eq!(report_ids(&h), ids);
}
