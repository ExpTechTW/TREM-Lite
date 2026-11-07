//! TREM-Lite, native: winit windows, wgpu drawing, no web view.

mod app;

mod backend;

mod domain;

mod events;

mod features;

mod map;

mod net;

mod paths;

mod platform;
mod preview;
mod render;
mod runner;

mod timers;

mod ui;

mod variable;

use std::path::PathBuf;

const HELP: &str = "\
trem-lite-native [--start]

  --start             只在系統匣啟動（開機自動啟動用）

截圖：
  --screenshot PATH   離屏畫完就結束，不開視窗
  --size WxH          邏輯像素，預設 1280x815
  --scale N           DPI scale，預設 1
  --page NAME         debug、map、main、pip、settings、run
  --preview STATE     idle、trigger、eew、cancel、rts、warnings、survey
  --settings-tab ID   一般、警報、音效、關於
  --camera L,L,Z      map 頁的相機
  --replay ID         run 頁：重播這則報告
  --after SECS        run 頁：跑這麼久才截圖，預設 10
";

pub struct Args {
    pub help: bool,
    pub start_hidden: bool,
    pub restarted: bool,
    pub screenshot: Option<PathBuf>,
    pub camera: Option<(f64, f64, f64)>,
    pub width: f32,
    pub height: f32,
    pub scale: f32,
    pub page: String,
    pub preview: String,
    pub settings_tab: String,
    pub replay: Option<String>,
    pub after: f64,
}

fn main() {
    let args = match Args::from_env() {
        Ok(args) => args,
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(2);
        }
    };
    if args.help {
        println!("{HELP}");
        return;
    }
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("無法建立 runtime：{err}");
            std::process::exit(1);
        }
    };
    let _guard = rt.enter();

    if let Some(path) = args.screenshot.clone() {
        init_stderr_log();
        let done = preview::screenshot(&rt, &args, &path);
        // Whatever still runs ends with the process; waiting for it would only delay it.
        drop(_guard);
        rt.shutdown_background();
        match done {
            Ok((w, h)) => log::info!("截圖已寫入 {}（{w}x{h}）", path.display()),
            Err(err) => {
                log::error!("{err}");
                std::process::exit(1);
            }
        }
        return;
    }

    let instance = claim_instance(args.restarted);
    let listener = match instance {
        Some(platform::lifecycle::Instance::Second) => {
            println!("TREM-Lite 已經在執行：叫出它的主視窗");
            return;
        }
        Some(platform::lifecycle::Instance::First(listener)) => Some(listener),
        None => None,
    };
    backend::logging::init();
    log::info!(target: "app", "程式啟動（參數 {:?}）", std::env::args().skip(1).collect::<Vec<_>>());
    backend::awake::keep_awake();
    backend::awake::log_state();
    if let Err(err) = runner::run(&rt, &args, listener) {
        log::error!(target: "app", "{err}");
        log::logger().flush();
        std::process::exit(1);
    }
    log::info!(target: "app", "程式結束");
    log::logger().flush();
    // The streams and workers end with the process; waiting for them would only delay it.
    drop(_guard);
    rt.shutdown_background();
}

/// A restart waits for the old process to let go of the lock.
fn claim_instance(restarted: bool) -> Option<platform::lifecycle::Instance> {
    if restarted {
        for _ in 0..30 {
            match platform::lifecycle::claim_instance() {
                Some(platform::lifecycle::Instance::First(listener)) => {
                    return Some(platform::lifecycle::Instance::First(listener));
                }
                _ => std::thread::sleep(std::time::Duration::from_millis(100)),
            }
        }
        return None;
    }
    platform::lifecycle::claim_instance()
}

impl Args {
    fn from_env() -> Result<Self, String> {
        let mut args = std::env::args().skip(1);
        let mut parsed = Self {
            help: false,
            start_hidden: false,
            restarted: false,
            screenshot: None,
            camera: None,
            width: 1280.0,
            height: 815.0,
            scale: 1.0,
            page: "main".to_string(),
            preview: "idle".to_string(),
            settings_tab: "一般".to_string(),
            replay: None,
            after: 10.0,
        };
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--help" | "-h" => parsed.help = true,
                "--start" => parsed.start_hidden = true,
                "--restarted" => parsed.restarted = true,
                "--screenshot" => {
                    let path = args.next().ok_or("--screenshot 需要路徑")?;
                    parsed.screenshot = Some(PathBuf::from(path));
                }
                "--size" => {
                    let value = args.next().ok_or("--size 需要 WxH")?;
                    let (w, h) = parse_size(&value).ok_or("--size 格式要是 WxH")?;
                    parsed.width = w;
                    parsed.height = h;
                }
                "--scale" => {
                    let value = args.next().ok_or("--scale 需要數字")?;
                    parsed.scale = parse_scale(&value).ok_or("--scale 要是正數")?;
                }
                "--page" => parsed.page = args.next().ok_or("--page 需要名稱")?,
                "--preview" => parsed.preview = args.next().ok_or("--preview 需要狀態")?,
                "--settings-tab" => {
                    parsed.settings_tab = args.next().ok_or("--settings-tab 需要分頁")?;
                }
                "--replay" => parsed.replay = Some(args.next().ok_or("--replay 需要報告編號")?),
                "--after" => {
                    let value = args.next().ok_or("--after 需要秒數")?;
                    parsed.after = value.parse().map_err(|_| "--after 要是數字")?;
                }
                "--camera" => {
                    let value = args.next().ok_or("--camera 需要 lon,lat,zoom")?;
                    let parts: Vec<f64> = value.split(',').filter_map(|v| v.parse().ok()).collect();
                    let [lon, lat, zoom] = parts[..] else {
                        return Err("--camera 格式要是 lon,lat,zoom".to_string());
                    };
                    parsed.camera = Some((lon, lat, zoom));
                }
                other => return Err(format!("不認識的參數：{other}")),
            }
        }
        Ok(parsed)
    }
}

fn parse_size(text: &str) -> Option<(f32, f32)> {
    let (w, h) = text.split_once('x').or_else(|| text.split_once('X'))?;
    let w: f32 = w.parse().ok()?;
    let h: f32 = h.parse().ok()?;
    (w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0).then_some((w, h))
}

fn parse_scale(text: &str) -> Option<f32> {
    let scale: f32 = text.parse().ok()?;
    (scale.is_finite() && scale > 0.0).then_some(scale)
}

fn init_stderr_log() {
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Info);
}

static LOGGER: Logger = Logger;

struct Logger;

impl log::Log for Logger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            eprintln!("[{}] {}", record.level(), record.args());
        }
    }

    fn flush(&self) {}
}
