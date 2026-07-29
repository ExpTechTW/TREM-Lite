//! 日誌設定。
//!
//! 用官方 `tauri-plugin-log` 作為底層：分級（trace/debug/info/warn/error）、
//! 寫檔到 app log 目錄、本地時區 + 毫秒時間戳、按檔案大小滾轉。前端透過
//! `@tauri-apps/plugin-log`（見 src/lib/logger.ts）呼叫，日誌會流經此處寫入檔案。
//!
//! 插件的滾轉是「按大小」而非「按天」，因此另外用 [`prune_old_logs`] 在啟動時
//! 清掉修改時間超過 `RETAIN_DAYS` 天的日誌檔，達成「最多保留 7 天」的滾轉語意。
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_log::{Builder, RotationStrategy, Target, TargetKind, TimezoneStrategy};
use time::macros::format_description;

/// 日誌檔名主幹（實際檔名為 `trem-lite.log`，滾轉歸檔會帶日期時間戳）。
const LOG_FILE_STEM: &str = "trem-lite";
/// 單一日誌檔超過此大小（bytes）就滾轉，避免單檔無限膨脹。
const MAX_FILE_SIZE: u128 = 5 * 1024 * 1024; // 5 MB
/// 保留天數：啟動時刪除比這更舊的日誌檔。
const RETAIN_DAYS: u64 = 7;

/// 建立設定好的 log 插件。level 在 debug build 為 Debug、release 為 Info。
pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let level = if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };

    Builder::new()
        .clear_targets()
        // 寫檔 + 開發時同步輸出 stdout。
        .target(Target::new(TargetKind::Stdout))
        .target(Target::new(TargetKind::LogDir {
            file_name: Some(LOG_FILE_STEM.into()),
        }))
        .level(level)
        // 第三方 crate 降噪，只留警告以上，避免蓋掉我們自己的日誌。
        .level_for("tao", log::LevelFilter::Warn)
        .level_for("wry", log::LevelFilter::Warn)
        .level_for("reqwest", log::LevelFilter::Warn)
        .level_for("hyper", log::LevelFilter::Warn)
        .level_for("hyper_util", log::LevelFilter::Warn)
        .level_for("h2", log::LevelFilter::Warn)
        .max_file_size(MAX_FILE_SIZE)
        // 保留所有滾轉歸檔；真正的「7 天」由 prune_old_logs 依修改時間清理。
        .rotation_strategy(RotationStrategy::KeepAll)
        .timezone_strategy(TimezoneStrategy::UseLocal)
        // 格式：`2026-07-12 00:15:20.482 [INFO] [webview] [map] MapLoad emitted`
        .format(|out, message, record| {
            let fmt = format_description!(
                "[year]-[month]-[day] [hour]:[minute]:[second].[subsecond digits:3]"
            );
            let ts = TimezoneStrategy::UseLocal
                .get_now()
                .format(&fmt)
                .unwrap_or_default();
            out.finish(format_args!(
                "{ts} [{}] [{}] {}",
                record.level(),
                record.target(),
                message
            ))
        })
        .build()
}

/// 刪除 log 目錄裡修改時間超過 [`RETAIN_DAYS`] 天的本 app 日誌檔（含滾轉歸檔）。
/// 在 `setup` 中呼叫一次即可；目錄不存在或讀取失敗時安靜略過。
pub fn prune_old_logs<R: Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = app.path().app_log_dir() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let cutoff = SystemTime::now() - Duration::from_secs(RETAIN_DAYS * 24 * 60 * 60);
    let mut removed = 0u32;

    for entry in entries.flatten() {
        let path = entry.path();
        // 只碰本 app 的日誌檔（trem-lite.log 及帶日期的滾轉歸檔）。
        // 大小寫不敏感比對：macOS 檔案系統預設不分大小寫，實際檔名可能是
        // "TREM-Lite.log"，若用大小寫敏感的 starts_with 會漏掉、導致清理失效。
        let is_ours = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| {
                let n = n.to_ascii_lowercase();
                n.starts_with(LOG_FILE_STEM) && n.contains("log")
            })
            .unwrap_or(false);
        if !is_ours {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if modified < cutoff && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }

    if removed > 0 {
        log::info!("[log] pruned {removed} log file(s) older than {RETAIN_DAYS} days");
    }
}
