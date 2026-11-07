//! The app's log, which trem_io::logging writes: to `{data_dir}/logs`, or to the console
//! in a browser. It keeps DEBUG from the app, the libraries beside it and the custom
//! targets, INFO from every other crate, and writes the app's targets without the crate.

use std::path::PathBuf;

use log::LevelFilter;
use trem_io::logging::LogConfig;

/// The program, as the log counts it: this crate and the libraries it is made of.
const OWN_CRATES: &[&str] = &[env!("CARGO_CRATE_NAME"), "trem_core", "trem_io"];

fn root() -> Result<PathBuf, String> {
    crate::paths::PATHS
        .data_dir()
        .map(|d| d.join("logs"))
        .ok_or_else(|| "找不到資料目錄".to_string())
}

fn config() -> LogConfig {
    LogConfig {
        dir: root().ok(),
        own_crates: OWN_CRATES,
        own_level: LevelFilter::Debug,
        other_level: LevelFilter::Info,
        full_targets: false,
        // A debug build prints it too, to the terminal it was started from.
        stderr: cfg!(debug_assertions),
    }
}

/// 掛上檔案日誌與 panic 記錄，並開始定期整理。在 setup 一開始呼叫：
/// 在它之前的 `log::…!` 不會留下任何東西。
pub fn init() {
    trem_io::logging::init(config());
}

#[cfg(target_arch = "wasm32")]
pub fn logs_open() -> Result<(), String> {
    Err("瀏覽器版的日誌在開發者工具的 console".to_string())
}

/// 用系統檔案總管開啟日誌資料夾。
#[cfg(not(target_arch = "wasm32"))]
pub fn logs_open() -> Result<(), String> {
    trem_io::logging::open(&root()?)
}

#[cfg(test)]
mod tests {
    use log::{Level, Metadata};

    use super::*;

    #[test]
    fn targets_drop_the_crate_name_and_keep_custom_ones() {
        let config = config();
        // This very module, as `log` names it.
        assert_eq!(module_path!(), "trem_lite_native::backend::logging::tests");
        assert_eq!(
            config.short_target(module_path!()),
            "backend::logging::tests"
        );
        assert_eq!(config.short_target("trem_lite_native"), "app");
        assert_eq!(config.short_target("panic"), "panic");
        assert_eq!(config.short_target("reqwest::connect"), "reqwest::connect");
        // The libraries' modules are the app's, written as they were before they moved.
        assert_eq!(config.short_target("trem_io::net::http"), "net::http");
        assert_eq!(config.short_target("trem_core::region"), "region");
        assert!(config.is_ours(module_path!()) && config.is_ours("sse"));
        assert!(config.is_ours("trem_io::net::endpoints"));
        assert!(!config.is_ours("reqwest::connect"));
    }

    #[test]
    fn debug_is_written_for_ours_and_info_for_dependencies() {
        let config = config();
        let meta = |level, target| Metadata::builder().level(level).target(target).build();
        assert!(config.enabled(&meta(Level::Debug, module_path!())));
        assert!(!config.enabled(&meta(Level::Trace, module_path!())));
        assert!(config.enabled(&meta(Level::Debug, "trem_io::net::http")));
        assert!(config.enabled(&meta(Level::Info, "wgpu_core::device")));
        assert!(!config.enabled(&meta(Level::Debug, "wgpu_core::device")));
    }
}
