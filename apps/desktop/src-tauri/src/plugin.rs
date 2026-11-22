//! Extension (plugin) storage — file I/O only, no policy.
//!
//! The extension host itself lives in the webview
//! (`packages/core/src/features/plugin`): it reads manifests, verifies
//! `signature.json`, orders dependencies and evaluates each plugin's code.
//! Rust does the one thing the webview cannot — write files synchronously and
//! safely — and only ever touches `<app_config_dir>/plugins/<name>`, so a
//! plugin can reach its own directory and nothing else.
//!
//! Verifying a signature in Rust would mean the `rsa` crate; the webview
//! already has WebCrypto, whose RSASSA-PKCS1-v1_5 + SHA-256 is exactly what
//! `crypto.createVerify('SHA256')` did in the Electron build. Reading the whole
//! tree in one call is what lets the host hand plugins a synchronous `fs`: the
//! legacy API is `fs.readFileSync`, and a synchronous read cannot cross an
//! async IPC boundary.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::Manager;

/// One file of a plugin, base64 so binary assets survive the trip.
#[derive(Serialize, Deserialize)]
pub struct PluginFile {
    /// POSIX-style path relative to the plugin directory.
    path: String,
    data: String,
}

/// A plugin directory as the host sees it when it starts up.
#[derive(Serialize)]
pub struct PluginDir {
    name: String,
    files: Vec<PluginFile>,
}

/// A trusted signing key dropped in `<app_config_dir>/plugin-keys`.
#[derive(Serialize)]
pub struct PluginKey {
    /// File name without `.pem` — the `keyId` a signature refers to.
    id: String,
    /// The PEM body, as `PluginVerifier.loadKeysFromDirectory` returned it.
    pem: String,
}

/// `info.json`'s `name` is also the directory name, so it must not traverse.
pub(crate) fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub(crate) fn base_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("no config dir: {e}"))
}

pub(crate) fn plugins_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = base_dir(app)?.join("plugins");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub(crate) fn plugin_dir(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err(format!("插件名稱不合法：{name}"));
    }
    Ok(plugins_dir(app)?.join(name))
}

/// Reject absolute paths and `..`, so a plugin cannot escape its directory.
pub(crate) fn safe_relative(rel: &str) -> Result<PathBuf, String> {
    let mut out = PathBuf::new();
    for part in rel.replace('\\', "/").split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        out.push(part);
    }
    // Only plain names survive: a drive prefix (`C:foo`), a root, or a `..`
    // anywhere means the archive was not written by the signer.
    let plain = out
        .components()
        .all(|part| matches!(part, std::path::Component::Normal(_)));
    if out.as_os_str().is_empty() || !plain {
        return Err(format!("插件路徑不合法：{rel}"));
    }
    Ok(out)
}

/// Every regular file under `dir`, keyed by its path relative to `base`.
fn collect(dir: &Path, base: &Path, out: &mut Vec<PluginFile>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        // `file_type` does not follow symlinks: a link into the rest of the
        // disk is read as a link and skipped, never followed.
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() {
            collect(&path, base, out)?;
            continue;
        }
        if !kind.is_file() {
            continue;
        }
        let rel = path
            .strip_prefix(base)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let bytes = std::fs::read(&path).map_err(|e| format!("{rel}: {e}"))?;
        out.push(PluginFile {
            path: rel,
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Where plugins live, for the "open folder" button.
#[tauri::command]
pub fn plugin_root(app: tauri::AppHandle) -> Result<String, String> {
    Ok(plugins_dir(&app)?.to_string_lossy().into_owned())
}

/// Read every installed plugin: the directory name plus each file's bytes, so
/// the host can answer `fs.readFileSync` without another round trip.
#[tauri::command]
pub fn plugin_list(app: tauri::AppHandle) -> Result<Vec<PluginDir>, String> {
    let root = plugins_dir(&app)?;
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(e) => {
            log::warn!(target: "plugin", "讀不到插件資料夾 {}：{e}", root.display());
            return Ok(out);
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !valid_name(&name) {
            log::warn!(target: "plugin", "略過名稱不合法的插件資料夾：{name}");
            continue;
        }
        let mut files = Vec::new();
        match collect(&path, &path, &mut files) {
            Ok(()) => {
                log::debug!(target: "plugin", "讀取插件 {name}：{} 個檔案", files.len());
                out.push(PluginDir { name, files });
            }
            Err(e) => log::error!(target: "plugin", "讀取插件 {name} 失敗：{e}"),
        }
    }
    Ok(out)
}

/// Write one file inside a plugin directory (its own `config.yml`, a cache).
/// `data` of `None` removes the file, which is what `fs.unlinkSync` forwards.
#[tauri::command]
pub fn plugin_write(
    app: tauri::AppHandle,
    plugin: String,
    path: String,
    data: Option<String>,
) -> Result<(), String> {
    let dir = plugin_dir(&app, &plugin)?;
    let rel = safe_relative(&path)?;
    let target = dir.join(&rel);
    let Some(data) = data else {
        if target.exists() {
            std::fs::remove_file(&target).map_err(|e| e.to_string())?;
        }
        return Ok(());
    };
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("內容不是合法的 base64：{e}"))?;
    std::fs::write(&target, bytes).map_err(|e| {
        log::error!(target: "plugin", "寫入 {plugin}/{} 失敗：{e}", rel.display());
        e.to_string()
    })?;
    Ok(())
}

/// Install (or replace) a plugin directory. The webview unzips the `.trem`
/// and hands over the extracted files, so Rust needs no archive dependency.
#[tauri::command]
pub fn plugin_install(
    app: tauri::AppHandle,
    plugin: String,
    files: Vec<PluginFile>,
) -> Result<(), String> {
    let dir = plugin_dir(&app, &plugin)?;
    // Replace, not merge: a stale file left behind would still be hashed by the
    // next signature check and reported as an extra file.
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for file in &files {
        safe_relative(&file.path)?;
    }
    for file in files {
        let target = dir.join(safe_relative(&file.path)?);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(file.data.as_bytes())
            .map_err(|e| format!("{} 不是合法的 base64：{e}", file.path))?;
        std::fs::write(&target, bytes).map_err(|e| format!("{}: {e}", file.path))?;
    }
    log::info!(target: "plugin", "安裝插件 {plugin}");
    Ok(())
}

/// Remove a plugin directory and everything in it.
#[tauri::command]
pub fn plugin_remove(app: tauri::AppHandle, plugin: String) -> Result<(), String> {
    let dir = plugin_dir(&app, &plugin)?;
    if !dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    log::info!(target: "plugin", "移除插件 {plugin}");
    Ok(())
}

/// `.trem` archives sitting in the plugin folder, base64, `path` = file name.
///
/// A user who opens the folder can copy a package into it instead of dragging
/// one onto the settings page. The webview unzips what this returns; Rust only
/// carries the bytes. See `PluginLoader::importPackages`.
#[tauri::command]
pub fn plugin_packages(app: tauri::AppHandle) -> Result<Vec<PluginFile>, String> {
    let dir = plugins_dir(&app)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        // `file_type()` rather than `path.is_file()`: a link out of the folder
        // is not a package this host should read.
        if !entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false)
        {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("trem") {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()).map(str::to_owned) else {
            continue;
        };
        match std::fs::read(&path) {
            Ok(bytes) => out.push(PluginFile {
                path: name,
                data: base64::engine::general_purpose::STANDARD.encode(bytes),
            }),
            Err(e) => log::warn!(target: "plugin", "讀不到套件 {}：{e}", path.display()),
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Delete one of those archives: it has been installed, and keeping it would
/// install it again on the next start.
///
/// The name here is a file name (`demo.trem`), not a plugin name, so it is
/// checked for path traversal instead of against `valid_name`.
#[tauri::command]
pub fn plugin_discard(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let target = plugins_dir(&app)?.join(safe_relative(&name)?);
    if !target.is_file() {
        return Ok(());
    }
    std::fs::remove_file(&target).map_err(|e| e.to_string())?;
    log::info!(target: "plugin", "移除插件套件 {name}");
    Ok(())
}

/// Keys published by organisations other than ExpTech, dropped in as `.pem`.
#[tauri::command]
pub fn plugin_keys(app: tauri::AppHandle) -> Result<Vec<PluginKey>, String> {
    let dir = base_dir(&app)?.join("plugin-keys");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("pem") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_owned) else {
            continue;
        };
        match std::fs::read_to_string(&path) {
            Ok(pem) => out.push(PluginKey { id, pem }),
            Err(e) => log::warn!(target: "plugin", "讀不到金鑰 {}：{e}", path.display()),
        }
    }
    // Keys are small and unordered on disk; sort so both runs agree.
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}
