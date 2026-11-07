//! Durations and sizes the way the logs write them, after trem-monitor.

use std::time::Duration;

/// 時間長度，照 trem-monitor：`850ms`、`1.2s`、`3m05s`、`2h10m`。
pub fn fmt_dur(d: Duration) -> String {
    let ms = d.as_millis();
    let secs = d.as_secs();
    match secs {
        0 => format!("{ms}ms"),
        1..=59 => format!("{:.1}s", d.as_secs_f64()),
        60..=3599 => format!("{}m{:02}s", secs / 60, secs % 60),
        _ => format!("{}h{:02}m", secs / 3600, secs % 3600 / 60),
    }
}

/// 大小，照 trem-monitor：`512 B`、`1.2 KB`、`3.4 MB`。
pub fn fmt_bytes(n: u64) -> String {
    match n {
        0..=1023 => format!("{n} B"),
        1024..=1_048_575 => format!("{:.1} KB", n as f64 / 1024.0),
        _ => format!("{:.1} MB", n as f64 / 1_048_576.0),
    }
}
