//! 檔案日誌：`{app_data_dir}/logs/YYYY/MM/DD/HH.log`，格式、歸檔與壓縮照 trem-monitor。
//!
//! 每行 `[HH:MM:SS.mmm][LEVEL][target]: 訊息`——到毫秒，因為連線、問候、交接與
//! 一則預警的收到、發布、播音常在同一秒內接連發生。每小時換一個檔，開檔控制代碼留到跨小時
//! 才換，不必每行開關檔案。已經過去的小時壓成 `.log.gz`，超過 7 天的日期目錄整個
//! 刪掉；啟動時做一次，之後每小時再做——這個 app 會連續跑好幾天不重啟，只在啟動
//! 時整理等於沒整理。
//!
//! 用標準的 `log` 門面（`log::info!` 等），writer 自己寫：tauri-plugin-log 能滾轉，
//! 但檔名是平的，做不出按日期分層的目錄。前端的日誌經 [`log_write`] 寫進同一個
//! 檔案，target 是前端模組名（`sse`、`eew`…）；網頁版沒有檔案系統，同樣的格式與
//! 規則改存 localStorage（packages/core/src/lib/logStore.ts）。
//!
//! 寫入的等級：本程式（Rust 模組與前端）到 DEBUG，相依套件到 INFO。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use chrono::{DateTime, Datelike, Local, TimeZone, Timelike};
use flate2::write::GzEncoder;
use flate2::Compression;
use log::{Level, LevelFilter, Log, Metadata, Record};
use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

/// 保留天數。超過就整個日期目錄刪掉。
const KEEP_DAYS: i64 = 7;
/// 清理與壓縮的間隔。掃的是幾個目錄名，成本極低。
const PRUNE_INTERVAL: Duration = Duration::from_secs(3600);
/// 本程式 Rust 模組的 target 前綴：`trem_lite_lib::audio` 寫成 `audio`。
const CRATE: &str = "trem_lite_lib";

struct Sink {
    /// 目前開著的檔案與它對應的小時鍵（YYYYMMDDHH）
    open: Option<(i64, File)>,
    root: PathBuf,
}

impl Sink {
    /// 取得這個時間點該寫的檔案，跨小時就換一個。
    fn file_for(&mut self, at: &DateTime<Local>) -> Option<&mut File> {
        let key = at.year() as i64 * 1_000_000
            + at.month() as i64 * 10_000
            + at.day() as i64 * 100
            + at.hour() as i64;

        if self.open.as_ref().is_none_or(|(k, _)| *k != key) {
            let dir = self
                .root
                .join(format!("{:04}", at.year()))
                .join(format!("{:02}", at.month()))
                .join(format!("{:02}", at.day()));
            fs::create_dir_all(&dir).ok()?;
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join(format!("{:02}.log", at.hour())))
                .ok()?;
            self.open = Some((key, file));
        }
        self.open.as_mut().map(|(_, f)| f)
    }
}

pub struct FileLogger {
    sink: Mutex<Sink>,
}

impl FileLogger {
    /// 寫一行。`at` 是事情發生的時間（前端的行帶著自己的時間過來）；寫進哪個檔
    /// 看的是現在，跨小時邊界時晚到幾毫秒的行不會把上一小時的檔再開回來。
    fn write(&self, at: &DateTime<Local>, level: Level, target: &str, msg: &dyn std::fmt::Display) {
        let line = format_line(at, level, target, msg);
        if cfg!(debug_assertions) {
            eprint!("{line}");
        }
        if let Ok(mut sink) = self.sink.lock() {
            if let Some(file) = sink.file_for(&Local::now()) {
                let _ = file.write_all(line.as_bytes());
            }
        }
    }
}

/// `[HH:MM:SS.mmm][LEVEL][target]: 訊息`
fn format_line(
    at: &DateTime<Local>,
    level: Level,
    target: &str,
    msg: &dyn std::fmt::Display,
) -> String {
    format!(
        "[{:02}:{:02}:{:02}.{:03}][{}][{}]: {}\n",
        at.hour(),
        at.minute(),
        at.second(),
        at.timestamp_subsec_millis().min(999),
        level,
        target,
        msg,
    )
}

/// 本程式的模組路徑去掉 crate 名；自訂 target（`log::info!(target: "app", …)`）照舊。
fn short_target(target: &str) -> &str {
    match target.strip_prefix(CRATE) {
        Some("") => "app",
        Some(rest) => rest.trim_start_matches("::"),
        None => target,
    }
}

/// 本程式的 target：本 crate 的模組，或沒有 `::` 的自訂 target。
fn is_ours(target: &str) -> bool {
    target.starts_with(CRATE) || !target.contains("::")
}

impl Log for FileLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        let max = if is_ours(metadata.target()) {
            Level::Debug
        } else {
            Level::Info
        };
        metadata.level() <= max
    }

    fn log(&self, record: &Record) {
        if self.enabled(record.metadata()) {
            let target = short_target(record.target());
            self.write(&Local::now(), record.level(), target, record.args());
        }
    }

    fn flush(&self) {
        if let Ok(mut sink) = self.sink.lock() {
            if let Some((_, f)) = sink.open.as_mut() {
                let _ = f.flush();
            }
        }
    }
}

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

static LOGGER: OnceLock<&'static FileLogger> = OnceLock::new();

pub fn root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("logs"))
        .map_err(|e| format!("找不到資料目錄：{e}"))
}

/// 掛上檔案日誌與 panic 記錄，並開始定期整理。在 setup 一開始呼叫：
/// 在它之前的 `log::…!` 不會留下任何東西。
pub fn init(app: &AppHandle) {
    let Ok(root) = root(app) else {
        return;
    };
    if fs::create_dir_all(&root).is_err() {
        return;
    }

    let logger: &'static FileLogger = Box::leak(Box::new(FileLogger {
        sink: Mutex::new(Sink {
            open: None,
            root: root.clone(),
        }),
    }));
    // The frontend's lines are written even if another logger got there first.
    let _ = LOGGER.set(logger);
    match log::set_logger(logger) {
        Ok(()) => log::set_max_level(LevelFilter::Debug),
        Err(e) => eprintln!("日誌：已經有別的 logger，Rust 的日誌不會寫進 {}：{e}", root.display()),
    }

    // panic 印到 stderr 就沒了：release 版沒有終端機，Windows 更是連 stderr 都沒有。
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        log::error!(
            target: "panic",
            "執行緒 {} panic：{info}\n{}",
            thread.name().unwrap_or("<unnamed>"),
            std::backtrace::Backtrace::force_capture()
        );
        default_hook(info);
    }));

    remove_old_plugin_logs(app);
    spawn_prune(root);
}

/// 舊版（tauri-plugin-log）寫在 app log 目錄的 `trem-lite*.log`。那裡不會再有新的
/// 內容，也就沒有別人會清：照舊版的規則，超過 7 天的刪掉，更新前幾天的日誌留到
/// 自然過期。
fn remove_old_plugin_logs(app: &AppHandle) {
    let Ok(dir) = app.path().app_log_dir() else {
        return;
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let cutoff = Duration::from_secs(KEEP_DAYS as u64 * 24 * 60 * 60);
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > cutoff);
        if name.starts_with("trem-lite") && name.contains(".log") && old && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    if removed > 0 {
        log::info!(target: "logging", "清掉 {removed} 個超過 7 天的舊版日誌檔（{}）", dir.display());
    }
}

/// 啟動先做一次，之後每小時再做：清掉過期的，順便把封存的壓起來。
///
/// 檔案 I/O 全部丟到 blocking 執行緒——壓縮一整天的日誌可能要掃上百個檔案，
/// 卡在 async runtime 的工作執行緒上會連帶拖慢 SSE 與 HTTP。
fn spawn_prune(root: PathBuf) {
    tauri::async_runtime::spawn(async move {
        loop {
            let dir = root.clone();
            let done = tauri::async_runtime::spawn_blocking(move || {
                let now = Local::now();
                (prune(&dir, now), compress_closed(&dir, now))
            })
            .await;

            if let Ok((removed, zipped)) = done {
                if removed > 0 {
                    log::info!(target: "logging", "清掉 {removed} 天份的舊日誌");
                }
                if zipped > 0 {
                    log::info!(target: "logging", "壓縮 {zipped} 個已封存的日誌");
                }
            }
            tokio::time::sleep(PRUNE_INTERVAL).await;
        }
    });
}

/// 把「不會再被寫入」的日誌壓成 .log.gz。
///
/// 只碰早於當前小時的檔案——當前這個小時的還開著控制代碼、隨時會續寫，
/// 壓了會遺失後面的內容。壓完才刪原檔，中途失敗最多留下一個 .gz 沒接上。
fn compress_closed(root: &Path, now: DateTime<Local>) -> usize {
    let current = now.format("%Y/%m/%d/%H.log").to_string();
    let mut count = 0;

    for path in log_files(root) {
        let Some(rel) = path.strip_prefix(root).ok().and_then(|p| p.to_str()) else {
            continue;
        };
        if rel.replace('\\', "/") == current {
            continue;
        }

        let gz = path.with_extension("log.gz");
        if gz.exists() {
            continue;
        }
        if gzip_file(&path, &gz).is_ok() && fs::remove_file(&path).is_ok() {
            count += 1;
        }
    }
    count
}

fn gzip_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    let raw = fs::read(src)?;
    let mut enc = GzEncoder::new(Vec::new(), Compression::best());
    enc.write_all(&raw)?;
    fs::write(dst, enc.finish()?)
}

/// 走 YYYY/MM/DD 三層找出所有 .log
fn log_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(years) = fs::read_dir(root) else {
        return out;
    };
    for year in years.flatten().filter(|e| e.path().is_dir()) {
        let Ok(months) = fs::read_dir(year.path()) else {
            continue;
        };
        for month in months.flatten().filter(|e| e.path().is_dir()) {
            let Ok(days) = fs::read_dir(month.path()) else {
                continue;
            };
            for day in days.flatten().filter(|e| e.path().is_dir()) {
                let Ok(files) = fs::read_dir(day.path()) else {
                    continue;
                };
                out.extend(
                    files
                        .flatten()
                        .map(|f| f.path())
                        .filter(|p| p.extension().is_some_and(|e| e == "log")),
                );
            }
        }
    }
    out
}

/// 刪掉 7 天前的日期目錄。整個目錄刪掉，所以 .log 與 .log.gz 一起走。
///
/// 走 YYYY/MM/DD 三層比對日期，不靠檔案的 mtime——
/// 備份還原或搬移檔案都會把 mtime 弄亂。
fn prune(root: &Path, now: DateTime<Local>) -> usize {
    let cutoff = now.date_naive() - chrono::Duration::days(KEEP_DAYS);
    let mut removed = 0;

    let Ok(years) = fs::read_dir(root) else {
        return removed;
    };
    for year in years.flatten() {
        let Some(y) = parse_dir(&year.path()) else {
            continue;
        };
        let Ok(months) = fs::read_dir(year.path()) else {
            continue;
        };
        for month in months.flatten() {
            let Some(m) = parse_dir(&month.path()) else {
                continue;
            };
            let Ok(days) = fs::read_dir(month.path()) else {
                continue;
            };
            for day in days.flatten() {
                let Some(d) = parse_dir(&day.path()) else {
                    continue;
                };
                let Some(date) = chrono::NaiveDate::from_ymd_opt(y, m as u32, d as u32) else {
                    continue;
                };
                if date < cutoff && fs::remove_dir_all(day.path()).is_ok() {
                    removed += 1;
                }
            }
            // 月份空了就一起收掉，不要留一堆空目錄
            let _ = fs::remove_dir(month.path());
        }
        let _ = fs::remove_dir(year.path());
    }
    removed
}

fn parse_dir(path: &Path) -> Option<i32> {
    path.file_name()?.to_str()?.parse().ok()
}

/// 前端一行最多幾個字元。
const MAX_JS_CHARS: usize = 8_000;

/// 前端的一行日誌。
#[derive(Deserialize)]
pub struct JsLine {
    /// 發生時間，Unix 毫秒
    t: i64,
    /// `error` `warn` `info` `debug`
    l: String,
    /// 前端模組名，當作 target
    s: String,
    m: String,
}

/// 前端的日誌寫進同一個檔案。前端把同一個工作階段（task）裡產生的行合成一批送來。
#[tauri::command]
pub fn log_write(lines: Vec<JsLine>) {
    let Some(logger) = LOGGER.get() else {
        return;
    };
    for line in lines {
        let level = match line.l.as_str() {
            "error" => Level::Error,
            "warn" => Level::Warn,
            "info" => Level::Info,
            "debug" => Level::Debug,
            _ => continue,
        };
        let at = Local
            .timestamp_millis_opt(line.t)
            .single()
            .unwrap_or_else(Local::now);
        // 一筆的長度設上限（同 trem-monitor）：一個巨大的物件不該把日誌撐爆。
        let message = if line.m.chars().count() > MAX_JS_CHARS {
            let mut cut: String = line.m.chars().take(MAX_JS_CHARS).collect();
            cut.push_str("…（截斷）");
            cut
        } else {
            line.m
        };
        logger.write(&at, level, &line.s, &message);
    }
}

/// 用系統檔案總管開啟日誌資料夾。
#[tauri::command]
pub fn logs_open(app: AppHandle) -> Result<(), String> {
    let dir = root(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("建立 {} 失敗：{e}", dir.display()))?;
    log::info!(target: "logging", "開啟日誌資料夾 {}", dir.display());
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(root: &Path, y: i32, m: u32, d: u32) {
        let dir = root
            .join(format!("{y:04}"))
            .join(format!("{m:02}"))
            .join(format!("{d:02}"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("12.log"), "x").unwrap();
    }

    fn exists(root: &Path, y: i32, m: u32, d: u32) -> bool {
        root.join(format!("{y:04}"))
            .join(format!("{m:02}"))
            .join(format!("{d:02}"))
            .exists()
    }

    fn write_log(root: &Path, y: i32, m: u32, d: u32, h: u32, body: &str) -> PathBuf {
        let dir = root
            .join(format!("{y:04}"))
            .join(format!("{m:02}"))
            .join(format!("{d:02}"));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{h:02}.log"));
        fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn a_line_is_trem_monitors_format() {
        let at = Local.with_ymd_and_hms(2026, 9, 29, 3, 5, 9).unwrap()
            + chrono::Duration::milliseconds(42);
        assert_eq!(
            format_line(&at, Level::Info, "sse", &"trem 已連線"),
            "[03:05:09.042][INFO][sse]: trem 已連線\n"
        );
    }

    #[test]
    fn the_frontends_batch_deserializes() {
        // What lib/logger.ts sends: `invoke("log_write", { lines })`.
        let lines: Vec<JsLine> = serde_json::from_str(
            r#"[{"t":1790000000042,"l":"info","s":"sse","m":"trem#1 撥出 https://x"},
                {"t":1790000000043,"l":"debug","s":"http","m":"GET /a → 200"}]"#,
        )
        .unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!((lines[0].l.as_str(), lines[0].s.as_str()), ("info", "sse"));
        assert_eq!(lines[1].t, 1_790_000_000_043);
    }

    #[test]
    fn targets_drop_the_crate_name_and_keep_custom_ones() {
        assert_eq!(short_target("trem_lite_lib::http_proxy"), "http_proxy");
        assert_eq!(short_target("trem_lite_lib"), "app");
        assert_eq!(short_target("panic"), "panic");
        assert_eq!(short_target("reqwest::connect"), "reqwest::connect");
        assert!(is_ours("trem_lite_lib::audio") && is_ours("sse"));
        assert!(!is_ours("reqwest::connect"));
    }

    #[test]
    fn debug_is_written_for_ours_and_info_for_dependencies() {
        let logger = FileLogger {
            sink: Mutex::new(Sink {
                open: None,
                root: PathBuf::new(),
            }),
        };
        let meta = |level, target| Metadata::builder().level(level).target(target).build();
        assert!(logger.enabled(&meta(Level::Debug, "trem_lite_lib::audio")));
        assert!(!logger.enabled(&meta(Level::Trace, "trem_lite_lib::audio")));
        assert!(logger.enabled(&meta(Level::Info, "tauri::manager")));
        assert!(!logger.enabled(&meta(Level::Debug, "tauri::manager")));
    }

    #[test]
    fn prune_keeps_the_last_seven_days_and_drops_older() {
        let tmp = std::env::temp_dir().join(format!("trem-lite-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let now = Local.with_ymd_and_hms(2026, 7, 29, 15, 0, 0).unwrap();

        touch(&tmp, 2026, 7, 29); // 今天
        touch(&tmp, 2026, 7, 23); // 6 天前，保留
        touch(&tmp, 2026, 7, 22); // 7 天前，正好在界線上
        touch(&tmp, 2026, 7, 21); // 8 天前，刪
        touch(&tmp, 2026, 6, 30); // 上個月，刪

        prune(&tmp, now);

        assert!(exists(&tmp, 2026, 7, 29), "今天要留著");
        assert!(exists(&tmp, 2026, 7, 23), "6 天前要留著");
        assert!(exists(&tmp, 2026, 7, 22), "界線上那天要留著");
        assert!(!exists(&tmp, 2026, 7, 21), "8 天前該刪");
        assert!(!exists(&tmp, 2026, 6, 30), "上個月該刪");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn prune_ignores_unexpected_names() {
        let tmp = std::env::temp_dir().join(format!("trem-lite-log-junk-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("readme")).unwrap();
        fs::write(tmp.join("stray.txt"), "x").unwrap();

        // 不該 panic，也不該把不認得的東西刪掉
        prune(&tmp, Local.with_ymd_and_hms(2026, 7, 29, 0, 0, 0).unwrap());
        assert!(tmp.join("readme").exists());
        assert!(tmp.join("stray.txt").exists());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_new_hour_opens_a_new_file() {
        let tmp = std::env::temp_dir().join(format!("trem-lite-log-path-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let mut sink = Sink {
            open: None,
            root: tmp.clone(),
        };

        let at = Local.with_ymd_and_hms(2026, 7, 29, 9, 30, 0).unwrap();
        assert!(sink.file_for(&at).is_some());
        assert!(tmp.join("2026/07/29/09.log").exists(), "路徑要是 YYYY/MM/DD/HH.log");

        let next = Local.with_ymd_and_hms(2026, 7, 29, 10, 0, 0).unwrap();
        assert!(sink.file_for(&next).is_some());
        assert!(tmp.join("2026/07/29/10.log").exists());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn closed_hours_are_compressed_and_the_current_one_is_not() {
        let tmp = std::env::temp_dir().join(format!("trem-lite-gz-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let now = Local.with_ymd_and_hms(2026, 7, 29, 15, 30, 0).unwrap();

        let current = write_log(&tmp, 2026, 7, 29, 15, "現在\n");
        let earlier = write_log(
            &tmp,
            2026,
            7,
            29,
            14,
            "[14:00:00][INFO][x]: 舊的\n".repeat(50).as_str(),
        );
        let yesterday = write_log(&tmp, 2026, 7, 28, 23, "昨天\n");

        assert_eq!(compress_closed(&tmp, now), 2, "只有兩個封存的小時該被壓");
        assert!(current.exists(), "當前小時的檔案還開著，不能動");
        assert!(!current.with_extension("log.gz").exists());
        assert!(!earlier.exists(), "壓完要刪原檔");
        assert!(earlier.with_extension("log.gz").exists());
        assert!(!yesterday.exists());
        assert!(yesterday.with_extension("log.gz").exists());

        // 內容要能還原
        let gz = fs::read(earlier.with_extension("log.gz")).unwrap();
        let mut out = Vec::new();
        std::io::copy(&mut flate2::read::GzDecoder::new(&gz[..]), &mut out).unwrap();
        assert_eq!(String::from_utf8(out).unwrap().lines().count(), 50);
        // 而且真的變小了
        assert!(gz.len() < 50 * 24, "壓縮後 {} bytes 沒有比較小", gz.len());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn already_compressed_files_are_left_alone() {
        let tmp = std::env::temp_dir().join(format!("trem-lite-gz2-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let now = Local.with_ymd_and_hms(2026, 7, 29, 15, 0, 0).unwrap();
        write_log(&tmp, 2026, 7, 29, 10, "a\n");

        assert_eq!(compress_closed(&tmp, now), 1);
        // 第二次跑不該重做，也不該把 .gz 再壓一次
        assert_eq!(compress_closed(&tmp, now), 0);

        let _ = fs::remove_dir_all(&tmp);
    }
}
