//! The recorded earthquake, replayed from its report, end to end: every event, sound,
//! notification, spoken line and window request, and the state every few seconds. The
//! golden files are what the app did when they were written; a change to them is a change
//! of behaviour, to be read before it is accepted.

use super::{check_golden, quake_answers, quake_report, Harness};

/// Some time after the recorded earthquake: what a person replaying it would see.
const NOW_MS: f64 = super::QUAKE_ORIGIN_MS + 30.0 * 24.0 * 3600.0 * 1000.0;

fn replay(main_shown: bool) -> String {
    let mut h = Harness::new(NOW_MS, quake_answers(), Harness::default_config());
    h.start(main_shown);
    let line = h.snapshot();
    h.note(&line);
    h.advance(2000);
    let report = quake_report(&h.app);
    h.note(&format!("replay {}", report.id));
    h.app.replay_report(&report);
    h.settle();
    // Past the EEW's 240 s and the replay's 600 s, back to live.
    for _ in 0..125 {
        h.advance(5000);
        let line = h.snapshot();
        h.note(&line);
    }
    h.log.join("\n") + "\n"
}

#[test]
fn a_report_replay_with_the_window_open() {
    check_golden("replay_window_open", &replay(true));
}

#[test]
fn a_report_replay_with_the_window_in_the_tray() {
    check_golden("replay_window_hidden", &replay(false));
}

#[test]
fn starting_live_seeds_the_reports_without_announcing_them() {
    let mut h = Harness::new(NOW_MS, quake_answers(), Harness::default_config());
    h.start(true);
    h.advance(65_000);
    let line = h.snapshot();
    h.note(&line);
    let requests = h.requests.lock().map(|r| r.join("\n")).unwrap_or_default();
    check_golden(
        "start_live",
        &(h.log.join("\n") + "\n--- requests\n" + &requests + "\n"),
    );
}
