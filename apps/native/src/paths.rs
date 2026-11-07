//! Where this build keeps its files. A separate identifier from the Tauri app,
//! so trying the native build touches none of its config, cache, logs or model.

use std::path::{Path, PathBuf};

const IDENTIFIER: &str = "com.exptech.trem-lite.native";
/// The Tauri app's identifier: read once for its settings, never written.
const TAURI_IDENTIFIER: &str = "com.exptech.trem-lite";

// A browser keeps no files of ours: no directories at all, and links open in a new tab.
#[cfg(target_arch = "wasm32")]
mod dirs {
    use std::path::PathBuf;

    pub fn config_dir() -> Option<PathBuf> {
        None
    }
    pub fn cache_dir() -> Option<PathBuf> {
        None
    }
    pub fn data_dir() -> Option<PathBuf> {
        None
    }
    pub fn data_local_dir() -> Option<PathBuf> {
        None
    }
}

pub fn config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(IDENTIFIER))
}

pub fn tauri_config_file() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(TAURI_IDENTIFIER).join("config.yml"))
}

pub fn cache_dir() -> Option<PathBuf> {
    dirs::cache_dir().map(|d| d.join(IDENTIFIER))
}

pub fn data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(IDENTIFIER))
}

pub fn local_data_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join(IDENTIFIER))
}

#[cfg(target_arch = "wasm32")]
pub fn open_path(path: &Path) -> Result<(), String> {
    Err(format!("瀏覽器開不了資料夾：{}", path.display()))
}

#[cfg(target_arch = "wasm32")]
pub fn open_url(url: &str) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(format!("不開啟這個網址：{url}"));
    }
    let window = web_sys::window().ok_or("沒有 window")?;
    window
        .open_with_url_and_target(url, "_blank")
        .map(|_| ())
        .map_err(|e| format!("無法開啟：{e:?}"))
}

/// Open a folder or URL with the system's default handler.
#[cfg(not(target_arch = "wasm32"))]
pub fn open_path(path: &Path) -> Result<(), String> {
    open_target(path.as_os_str())
}

#[cfg(not(target_arch = "wasm32"))]
pub fn open_url(url: &str) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(format!("不開啟這個網址：{url}"));
    }
    open_target(std::ffi::OsStr::new(url))
}

#[cfg(not(target_arch = "wasm32"))]
fn open_target(target: &std::ffi::OsStr) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = std::process::Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = std::process::Command::new("xdg-open");
    command
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("無法開啟：{e}"))
}
