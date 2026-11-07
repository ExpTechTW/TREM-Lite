//! YAML config store. `<config_dir>/config.yml`, with the bundled `default.yml` as
//! the template; when its `ver` is newer than the user's, the user's values are
//! deep-merged onto the new defaults (schema migration) and rewritten.
//!
//! The first run reads the Tauri app's settings once, if it has any, so trying
//! this build keeps the chosen station. `other-auto-start` is not carried over:
//! a trial build does not register itself to start at login unless asked.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_yaml::Value;

const DEFAULT_YML: &str = include_str!("../../assets/default.yml");

/// What the map shows while no earthquake holds it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IdleMap {
    #[default]
    Report,
    Rts,
}

/// Config shape mirrors default.yml.
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub ver: i64,
    pub station_id: String,
    pub idle_map: IdleMap,
    pub check_box: BTreeMap<String, bool>,
}

impl Config {
    pub fn checked(&self, key: &str) -> bool {
        self.check_box.get(key).copied().unwrap_or(false)
    }

    fn from_value(value: &Value) -> Self {
        let station_id = match value.get("realtime-station-id") {
            // YAML reads an all-digit hex id back as a number.
            Some(Value::Number(n)) => n.to_string(),
            Some(Value::String(s)) => s.clone(),
            _ => String::new(),
        };
        // Old files predate `idle-map`. Anything other than the live-station choice
        // stays on the report, which is what those files already showed.
        let idle_map = match value.get("idle-map").and_then(Value::as_str) {
            Some("rts") => IdleMap::Rts,
            _ => IdleMap::Report,
        };
        let mut check_box = BTreeMap::new();
        if let Some(Value::Mapping(map)) = value.get("check-box") {
            for (k, v) in map {
                if let (Some(k), Some(v)) = (k.as_str(), v.as_bool()) {
                    check_box.insert(k.to_string(), v);
                }
            }
        }
        Self {
            ver: version_of(value),
            station_id,
            idle_map,
            check_box,
        }
    }

    fn to_value(&self) -> Value {
        let mut root = serde_yaml::Mapping::new();
        root.insert("ver".into(), self.ver.into());
        root.insert(
            "realtime-station-id".into(),
            self.station_id.as_str().into(),
        );
        root.insert(
            "idle-map".into(),
            match self.idle_map {
                IdleMap::Report => "report".into(),
                IdleMap::Rts => "rts".into(),
            },
        );
        let mut boxes = serde_yaml::Mapping::new();
        for (k, v) in &self.check_box {
            boxes.insert(k.as_str().into(), (*v).into());
        }
        root.insert("check-box".into(), Value::Mapping(boxes));
        Value::Mapping(root)
    }

    /// `{ a: { b: 1 } }` → `a.b=1`, one line for the log.
    pub fn describe(&self) -> String {
        let mut out = format!(
            "ver={} realtime-station-id=\"{}\" idle-map=\"{}\"",
            self.ver,
            self.station_id,
            self.idle_name()
        );
        for (k, v) in &self.check_box {
            out.push_str(&format!(" check-box.{k}={v}"));
        }
        out
    }

    pub fn idle_name(&self) -> &'static str {
        match self.idle_map {
            IdleMap::Report => "report",
            IdleMap::Rts => "rts",
        }
    }

    /// One piece per changed setting: `鍵：舊 → 新`.
    pub fn changes(&self, next: &Self) -> Vec<String> {
        let mut out = Vec::new();
        if self.station_id != next.station_id {
            out.push(format!(
                "realtime-station-id：\"{}\" → \"{}\"",
                self.station_id, next.station_id
            ));
        }
        if self.idle_map != next.idle_map {
            out.push(format!(
                "idle-map：\"{}\" → \"{}\"",
                self.idle_name(),
                next.idle_name()
            ));
        }
        for (k, v) in &next.check_box {
            let before = self.check_box.get(k).copied();
            if before != Some(*v) {
                let before = before.map_or("undefined".to_string(), |b| b.to_string());
                out.push(format!("check-box.{k}：{before} → {v}"));
            }
        }
        out
    }
}

fn config_path() -> Result<PathBuf, String> {
    let dir = crate::paths::config_dir().ok_or("no config dir")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.yml"))
}

fn default_value() -> Value {
    serde_yaml::from_str(DEFAULT_YML).unwrap_or(Value::Null)
}

/// Overwrite the config file with the bundled defaults and return them.
fn reset_to_defaults() -> Result<Value, String> {
    let path = config_path()?;
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

/// The Tauri app's settings on top of `defaults`, leaving `other-auto-start` out.
fn with_tauri_settings(defaults: &Value, tauri: &Value) -> Value {
    let mut out = defaults.clone();
    let Value::Mapping(root) = &mut out else {
        return out;
    };
    for key in ["realtime-station-id", "idle-map"] {
        if let Some(value) = tauri.get(key) {
            root.insert(key.into(), value.clone());
        }
    }
    if let (Some(Value::Mapping(boxes)), Some(Value::Mapping(theirs))) =
        (root.get_mut("check-box"), tauri.get("check-box"))
    {
        for (k, v) in theirs {
            if k.as_str() != Some("other-auto-start") {
                boxes.insert(k.clone(), v.clone());
            }
        }
    }
    out
}

fn first_run_value() -> Result<Value, String> {
    let defaults = default_value();
    let imported = crate::paths::tauri_config_file()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_yaml::from_str::<Value>(&raw).ok());
    match imported {
        Some(tauri) => {
            log::info!("第一次啟動：匯入正式版的設定（只讀取，不動正式版的檔案）");
            let merged = with_tauri_settings(&defaults, &tauri);
            write_value(&merged)?;
            Ok(merged)
        }
        None => reset_to_defaults(),
    }
}

fn load_or_init() -> Result<Value, String> {
    let path = config_path()?;
    let defaults = default_value();

    if !path.exists() {
        log::info!("沒有設定檔，用預設值建立 {}", path.display());
        return first_run_value();
    }

    let raw = std::fs::read_to_string(&path).map_err(|e| {
        log::error!("讀不到設定檔 {}：{e}", path.display());
        e.to_string()
    })?;
    let mut user: Value = serde_yaml::from_str(&raw).map_err(|e| {
        log::error!("設定檔 {} 不是合法的 YAML：{e}", path.display());
        e.to_string()
    })?;

    // Migrate when the bundled schema is newer.
    if version_of(&defaults) > version_of(&user) {
        log::info!(
            "設定檔格式 {} → {}：舊檔備份成 .yml.backup，補上新的預設項目",
            version_of(&user),
            version_of(&defaults)
        );
        // backup, then merge new default keys onto the user's values.
        let _ = std::fs::write(path.with_extension("yml.backup"), &raw);
        merge_defaults(&mut user, &defaults);
        if let Value::Mapping(ref mut m) = user {
            m.insert(Value::from("ver"), Value::from(version_of(&defaults)));
        }
        write_value(&user)?;
    }

    Ok(user)
}

fn write_value(value: &Value) -> Result<(), String> {
    let path = config_path()?;
    let text = serde_yaml::to_string(value).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| {
        log::error!("寫不進設定檔 {}：{e}", path.display());
        e.to_string()
    })?;
    log::debug!("設定已寫入 {}", path.display());
    Ok(())
}

/// The settings, or the bundled defaults when the file cannot be read. The app
/// must still show the map.
/// A browser keeps no settings file yet: the defaults, every time.
#[cfg(target_arch = "wasm32")]
pub fn load() -> Config {
    let config = Config::from_value(&default_value());
    log::info!("瀏覽器版用預設設定：{}", config.describe());
    config
}

#[cfg(not(target_arch = "wasm32"))]
pub fn load() -> Config {
    match load_or_init() {
        Ok(value) => {
            let config = Config::from_value(&value);
            log::info!("載入設定：{}", config.describe());
            config
        }
        Err(e) => {
            log::error!("設定載入失敗，改用預設值：{e}");
            Config::from_value(&default_value())
        }
    }
}

/// Persist the whole config.
pub fn save(config: &Config) -> Result<(), String> {
    write_value(&config.to_value())
}

/// Reset config back to the bundled defaults.
pub fn reset() -> Result<Config, String> {
    log::info!("設定還原為預設值");
    let value = reset_to_defaults()?;
    let config = Config::from_value(&value);
    log::info!("所有設定還原為預設值：{}", config.describe());
    Ok(config)
}

/// For headless runs: the defaults, without touching the disk.
pub fn defaults() -> Config {
    Config::from_value(&default_value())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_defaults_parse_and_never_autostart() {
        let config = defaults();
        assert_eq!(config.ver, 7);
        assert_eq!(config.station_id, "1C10848");
        assert_eq!(config.idle_map, IdleMap::Report);
        assert!(config.checked("show-window-eew"));
        assert!(!config.checked("other-auto-start"));
    }

    #[test]
    fn importing_the_tauri_config_leaves_autostart_out() {
        let tauri: Value = serde_yaml::from_str(
            "ver: 7\nrealtime-station-id: 1234567\nidle-map: rts\ncheck-box:\n  other-auto-start: true\n  other-tts: false\n",
        )
        .unwrap();
        let merged = with_tauri_settings(&default_value(), &tauri);
        let config = Config::from_value(&merged);
        assert_eq!(config.station_id, "1234567");
        assert_eq!(config.idle_map, IdleMap::Rts);
        assert!(!config.checked("other-tts"));
        assert!(!config.checked("other-auto-start"));
        assert!(config.checked("sound-effects-EEW"));
    }

    #[test]
    fn merging_keeps_user_values_and_adds_new_defaults() {
        let mut user: Value = serde_yaml::from_str("a: 1\nb:\n  c: 2\n").unwrap();
        let defaults: Value = serde_yaml::from_str("a: 9\nb:\n  c: 9\n  d: 3\ne: 4\n").unwrap();
        merge_defaults(&mut user, &defaults);
        assert_eq!(user["a"], Value::from(1));
        assert_eq!(user["b"]["c"], Value::from(2));
        assert_eq!(user["b"]["d"], Value::from(3));
        assert_eq!(user["e"], Value::from(4));
    }

    #[test]
    fn a_saved_config_reads_back_the_same() {
        let mut config = defaults();
        config.station_id = "ABC1234".into();
        config.idle_map = IdleMap::Rts;
        config.check_box.insert("other-tts".into(), false);
        assert_eq!(Config::from_value(&config.to_value()), config);
    }

    #[test]
    fn changes_name_what_moved() {
        let a = defaults();
        let mut b = a.clone();
        b.idle_map = IdleMap::Rts;
        b.check_box.insert("other-tts".into(), false);
        let diff = b.changes(&a);
        assert_eq!(diff.len(), 2);
        assert!(diff[0].starts_with("idle-map"));
        assert!(a.changes(&a).is_empty());
    }
}
