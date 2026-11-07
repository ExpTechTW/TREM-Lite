//! The sound effects' rules, the same on the desktop and in a browser.

/// Per-clip volume (mirrors constant.js overrides).
pub fn volume_for(name: &str) -> f32 {
    match name {
        "SHINDO0" => 0.4,
        "UPDATE" => 0.2,
        _ => 1.0,
    }
}

/// Which pending clips a newly enqueued clip evicts from its queue.
/// Mirrors `priorityRules` in audio.js:104-116.
pub fn preempts(sound: &str) -> &'static [&'static str] {
    match sound {
        "PGA2" => &["PGA1", "PGA0"],
        "PGA1" => &["PGA0"],
        "SHINDO2" => &["SHINDO1", "SHINDO0"],
        "SHINDO1" => &["SHINDO0"],
        "ALERT" => &["EEW"],
        _ => &[],
    }
}

/// The queues an alert sound waits in; each plays one clip at a time.
pub const QUEUES: [&str; 4] = ["eew", "pga", "shindo", "update"];
