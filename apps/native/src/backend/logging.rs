//! 檔案日誌：`{app_data_dir}/logs/YYYY/MM/DD/HH.log`，格式、歸檔與壓縮照 trem-monitor。
//!
//! 每行 `[HH:MM:SS.mmm][LEVEL][target]: 訊息`——到毫秒，因為連線、問候、交接與
//! 一則預警的收到、發布、播音常在同一秒內接連發生。每小時換一個檔，開檔控制代碼留到跨小時
//! 才換，不必每行開關檔案。已經過去的小時壓成 `.log.gz`，超過 7 天的日期目錄整個
//! 刪掉；啟動時做一次，之後每小時再做——這個 app 會連續跑好幾天不重啟，只在啟動
//! 時整理等於沒整理。
//!
//! 用標準的 `log` 門面（`log::info!` 等），writer 自己寫，格式與 Tauri 版相同；
//! 自訂 target 沿用它前端的模組名（`sse`、`eew`…）。瀏覽器版沒有檔案系統，同樣的
//! 格式與等級規則寫到開發者工具的 console。
//!
//! 寫入的等級：本程式（本 crate 的模組與自訂 target）到 DEBUG，相依套件到 INFO。

#![cfg_attr(target_arch = "wasm32", allow(dead_code, unused_imports))]

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, Datelike, Local, Timelike};
use flate2::write::GzEncoder;
use flate2::Compression;
use log::{Level, LevelFilter, Log, Metadata, Record};

/// 保留天數。超過就整個日期目錄刪掉。
const KEEP_DAYS: i64 = 7;
/// 清理與壓縮的間隔。掃的是幾個目錄名，成本極低。
const PRUNE_INTERVAL: Duration = Duration::from_secs(3600);
/// 本程式 Rust 模組的 target 前綴：`trem_lite_native::render::text` 寫成 `render::text`。
const CRATE: &str = env!("CARGO_CRATE_NAME");

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
    /// 寫下已經排好的一或多行（[`push_line`]）：一次上鎖、一次寫入。寫進哪個檔看的
    /// 是現在，跨小時邊界時晚到幾毫秒的行不會把上一小時的檔再開回來。
    fn append(&self, lines: &str) {
        if cfg!(debug_assertions) {
            eprint!("{lines}");
        }
        if let Ok(mut sink) = self.sink.lock() {
            if let Some(file) = sink.file_for(&Local::now()) {
                let _ = file.write_all(lines.as_bytes());
            }
        }
    }
}

/// 在 `out` 後面接上一行 `[HH:MM:SS.mmm][LEVEL][target]: 訊息`。
fn push_line(
    out: &mut String,
    at: &DateTime<Local>,
    level: Level,
    target: &str,
    msg: &dyn std::fmt::Display,
) {
    use std::fmt::Write as _;
    // 寫進 String 不會失敗。
    let _ = writeln!(
        out,
        "[{:02}:{:02}:{:02}.{:03}][{}][{}]: {}",
        at.hour(),
        at.minute(),
        at.second(),
        at.timestamp_subsec_millis().min(999),
        level,
        target,
        msg,
    );
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
            let mut line = String::new();
            push_line(
                &mut line,
                &Local::now(),
                record.level(),
                target,
                record.args(),
            );
            self.append(&line);
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

pub fn root() -> Result<PathBuf, String> {
    crate::paths::data_dir()
        .map(|d| d.join("logs"))
        .ok_or_else(|| "找不到資料目錄".to_string())
}

/// 瀏覽器版：同樣格式的行寫到 console，等級規則相同。網頁沒有檔案，也就沒有歸檔。
#[cfg(target_arch = "wasm32")]
struct ConsoleLogger;

#[cfg(target_arch = "wasm32")]
impl Log for ConsoleLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        let max = if is_ours(metadata.target()) {
            Level::Debug
        } else {
            Level::Info
        };
        metadata.level() <= max
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let mut line = String::new();
        push_line(
            &mut line,
            &Local::now(),
            record.level(),
            short_target(record.target()),
            record.args(),
        );
        let text = wasm_bindgen::JsValue::from_str(line.trim_end());
        match record.level() {
            Level::Error => web_sys::console::error_1(&text),
            Level::Warn => web_sys::console::warn_1(&text),
            _ => web_sys::console::log_1(&text),
        }
    }

    fn flush(&self) {}
}

#[cfg(target_arch = "wasm32")]
pub fn init() {
    static LOGGER: ConsoleLogger = ConsoleLogger;
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(LevelFilter::Debug);
    }
    console_error_panic_hook::set_once();
}

#[cfg(target_arch = "wasm32")]
pub fn logs_open() -> Result<(), String> {
    Err("瀏覽器版的日誌在開發者工具的 console".to_string())
}

/// 掛上檔案日誌與 panic 記錄，並開始定期整理。在 setup 一開始呼叫：
/// 在它之前的 `log::…!` 不會留下任何東西。
#[cfg(not(target_arch = "wasm32"))]
pub fn init() {
    let Ok(root) = root() else {
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
    match log::set_logger(logger) {
        Ok(()) => log::set_max_level(LevelFilter::Debug),
        Err(e) => eprintln!(
            "日誌：已經有別的 logger，Rust 的日誌不會寫進 {}：{e}",
            root.display()
        ),
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

    spawn_prune(root);
}

/// 啟動先做一次，之後每小時再做：清掉過期的，順便把封存的壓起來。
///
/// 檔案 I/O 全部丟到 blocking 執行緒——壓縮一整天的日誌可能要掃上百個檔案，
/// 卡在 async runtime 的工作執行緒上會連帶拖慢 SSE 與 HTTP。
#[cfg(not(target_arch = "wasm32"))]
fn spawn_prune(root: PathBuf) {
    tokio::spawn(async move {
        loop {
            let dir = root.clone();
            let done = tokio::task::spawn_blocking(move || {
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

/// 用系統檔案總管開啟日誌資料夾。
#[cfg(not(target_arch = "wasm32"))]
pub fn logs_open() -> Result<(), String> {
    let dir = root()?;
    fs::create_dir_all(&dir).map_err(|e| format!("建立 {} 失敗：{e}", dir.display()))?;
    log::info!(target: "logging", "開啟日誌資料夾 {}", dir.display());
    crate::paths::open_path(&dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

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
        let mut text = String::new();
        push_line(&mut text, &at, Level::Info, "sse", &"trem 已連線");
        assert_eq!(text, "[03:05:09.042][INFO][sse]: trem 已連線\n");
        // 一批的行一個接一個
        push_line(&mut text, &at, Level::Warn, "http", &"x");
        assert_eq!(
            text,
            "[03:05:09.042][INFO][sse]: trem 已連線\n[03:05:09.042][WARN][http]: x\n"
        );
    }

    #[test]
    fn targets_drop_the_crate_name_and_keep_custom_ones() {
        // This very module, as `log` names it.
        assert_eq!(module_path!(), "trem_lite_native::backend::logging::tests");
        assert_eq!(short_target(module_path!()), "backend::logging::tests");
        assert_eq!(short_target("trem_lite_native"), "app");
        assert_eq!(short_target("panic"), "panic");
        assert_eq!(short_target("reqwest::connect"), "reqwest::connect");
        assert!(is_ours(module_path!()) && is_ours("sse"));
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
        assert!(logger.enabled(&meta(Level::Debug, module_path!())));
        assert!(!logger.enabled(&meta(Level::Trace, module_path!())));
        assert!(logger.enabled(&meta(Level::Info, "wgpu_core::device")));
        assert!(!logger.enabled(&meta(Level::Debug, "wgpu_core::device")));
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
        assert!(
            tmp.join("2026/07/29/09.log").exists(),
            "路徑要是 YYYY/MM/DD/HH.log"
        );

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
