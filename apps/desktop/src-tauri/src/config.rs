//! YAML config store — replaces the old `src/js/core/config.js` (electron-store
//! was never used; it read/wrote a YAML file under userData).
//!
//! User config lives at `<app_config_dir>/config.yml`. The bundled `default.yml`
//! is the template; when its `ver` is newer than the user's, we deep-merge the
//! user's values onto the new defaults (schema migration) and rewrite.

use std::path::PathBuf;

use serde_yaml::Value;
use tauri::{Emitter, Manager};

const DEFAULT_YML: &str = include_str!("../default.yml");

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.yml"))
}

fn default_value() -> Value {
    serde_yaml::from_str(DEFAULT_YML).expect("bundled default.yml is invalid")
}

/// Overwrite the config file with the bundled defaults and return them.
fn reset_to_defaults(app: &tauri::AppHandle) -> Result<Value, String> {
    let path = config_path(app)?;
    std::fs::write(&path, DEFAULT_YML).map_err(|e| e.to_string())?;
    Ok(default_value())
}

/// Recursively fill any keys present in `defaults` but missing in `user`.
/// Existing user values win; new default keys are added. This is the migration.
fn merge_defaults(user: &mut Value, defaults: &Value) {
    if let (Value::Mapping(user_map), Value::Mapping(def_map)) = (&mut *user, defaults) {
        for (k, dv) in def_map {
            match user_map.get_mut(k) {
                Some(uv) => merge_defaults(uv, dv),
                None => {
                    user_map.insert(k.clone(), dv.clone());
                }
            }
        }
    }
}

fn version_of(v: &Value) -> i64 {
    v.get("ver").and_then(Value::as_i64).unwrap_or(0)
}

fn load_or_init(app: &tauri::AppHandle) -> Result<Value, String> {
    let path = config_path(app)?;
    let defaults = default_value();

    if !path.exists() {
        return reset_to_defaults(app);
    }

    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut user: Value = serde_yaml::from_str(&raw).map_err(|e| e.to_string())?;

    // Migrate when the bundled schema is newer.
    if version_of(&defaults) > version_of(&user) {
        // backup, then merge new default keys onto the user's values.
        let _ = std::fs::write(path.with_extension("yml.backup"), &raw);
        merge_defaults(&mut user, &defaults);
        if let Value::Mapping(ref mut m) = user {
            m.insert(Value::from("ver"), Value::from(version_of(&defaults)));
        }
        write_value(app, &user)?;
    }

    Ok(user)
}

fn write_value(app: &tauri::AppHandle, value: &Value) -> Result<(), String> {
    let path = config_path(app)?;
    let text = serde_yaml::to_string(value).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Return the full config as JSON (webview-friendly).
#[tauri::command]
pub fn config_get(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let value = load_or_init(&app)?;
    serde_json::to_value(value).map_err(|e| e.to_string())
}

/// Replace the whole config with `value` (JSON from the webview), persist it,
/// and notify all windows so they re-read.
#[tauri::command]
pub fn config_set(app: tauri::AppHandle, value: serde_json::Value) -> Result<(), String> {
    let yaml_value: Value = serde_yaml::to_value(&value).map_err(|e| e.to_string())?;
    write_value(&app, &yaml_value)?;
    let _ = app.emit("config-updated", ());
    Ok(())
}

/// Reset config back to the bundled defaults.
#[tauri::command]
pub fn config_reset(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let value = reset_to_defaults(&app)?;
    let _ = app.emit("config-updated", ());
    serde_json::to_value(value).map_err(|e| e.to_string())
}

/// Ensure the config file exists on startup (creates it from defaults if absent).
pub fn ensure_initialized(app: &tauri::AppHandle) {
    let _ = load_or_init(app);
}
