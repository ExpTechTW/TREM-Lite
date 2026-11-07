//! Where this build keeps its files. A separate identifier from the Tauri app,
//! so trying the native build touches none of its config, cache, logs or model.

use std::path::PathBuf;

use trem_io::paths::Paths;

/// This build's directories. The Tauri app's identifier is the legacy one: read once for
/// its settings, never written.
pub const PATHS: Paths = Paths::new(
    "com.exptech.trem-lite.native",
    Some("com.exptech.trem-lite"),
);

pub fn tauri_config_file() -> Option<PathBuf> {
    PATHS.legacy_config_dir().map(|d| d.join("config.yml"))
}
