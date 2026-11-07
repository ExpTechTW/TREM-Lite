//! Where an app keeps its files: the system's config, cache and data directories, each
//! with a folder named by the app's identifier.

use std::path::{Path, PathBuf};

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

/// An app's directories, by its identifier.
#[derive(Clone, Copy, Debug)]
pub struct Paths {
    identifier: &'static str,
    legacy: Option<&'static str>,
}

impl Paths {
    /// `legacy`: the identifier of an earlier build of the app, whose settings are read
    /// once and never written.
    pub const fn new(identifier: &'static str, legacy: Option<&'static str>) -> Self {
        Self { identifier, legacy }
    }

    pub fn config_dir(&self) -> Option<PathBuf> {
        dirs::config_dir().map(|d| d.join(self.identifier))
    }

    /// The earlier build's config directory, to read its settings from.
    pub fn legacy_config_dir(&self) -> Option<PathBuf> {
        let legacy = self.legacy?;
        dirs::config_dir().map(|d| d.join(legacy))
    }

    pub fn cache_dir(&self) -> Option<PathBuf> {
        dirs::cache_dir().map(|d| d.join(self.identifier))
    }

    pub fn data_dir(&self) -> Option<PathBuf> {
        dirs::data_dir().map(|d| d.join(self.identifier))
    }

    pub fn local_data_dir(&self) -> Option<PathBuf> {
        dirs::data_local_dir().map(|d| d.join(self.identifier))
    }
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
