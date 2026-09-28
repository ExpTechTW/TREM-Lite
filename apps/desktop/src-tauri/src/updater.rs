//! Over-the-air updates: downloaded in the background whenever one exists,
//! applied the next time the app starts — never while it is running.
//!
//! Installing is not the same act on every platform. For the macOS bundle it
//! swaps files under the running app, which is harmless until it needs an
//! administrator password; on Windows the plugin hands over to the installer
//! and calls `exit(0)`; the Linux .deb asks for a password through pkexec. So
//! nothing is installed mid-session anywhere: a download is staged
//! on disk and installed at the next launch, before the main window is shown.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use tauri::async_runtime::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{UpdaterBuilder, UpdaterExt};

/// How often to look for an update. Matches the legacy client.
const CHECK_EVERY: Duration = Duration::from_secs(300);

/// The launch-time check waits at most this long. A staged package is only
/// installed once the server confirms it is still the latest, and an offline
/// start must not keep the main window hidden waiting for that answer.
const LAUNCH_CHECK_TIMEOUT: Duration = Duration::from_secs(5);

/// Where a snapshot looks for the next one: the snapshot channel, chosen at
/// runtime as tauri-plugin-updater's docs set channels up. `releases/latest` —
/// tauri.conf.json's endpoint, for a release — never points at a pre-release,
/// so the newest snapshot's latest.json is served as a static file on the web
/// build's Pages site (web.yml, release.yml).
const SNAPSHOT_MANIFEST: &str = "https://exptechtw.github.io/TREM-Lite/updater/snapshot.json";

/// Left by [`update_restart`] when the main window is hidden, so the restarted
/// app comes back hidden too. Honoured only this long, lest a crash before it
/// is cleared hide the window from a later, ordinary launch.
const HIDDEN_MARKER: &str = "restart-hidden";
const HIDDEN_MARKER_TTL: Duration = Duration::from_secs(120);

/// One check at a time: the timer and the settings button share it, and two
/// concurrent downloads would race to write the same staged package.
#[derive(Default)]
pub struct UpdaterState(Mutex<()>);

/// What a check found, for the settings page.
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CheckResult {
    UpToDate { current: String },
    /// Downloaded — by this check or an earlier one — and applied next launch.
    Staged { version: String },
}

#[derive(Clone, Serialize)]
pub struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

fn staging_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|dir| dir.join("update"))
        .map_err(|e| e.to_string())
}

/// The version file is what marks a staged package complete, so it is removed
/// first when staging and written last: a crash mid-write leaves a package
/// with no version, which launch ignores.
fn staged_version(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join("version"))
        .ok()
        .filter(|v| !v.is_empty())
}

fn stage(dir: &Path, version: &str, bytes: &[u8]) -> Result<(), String> {
    let _ = std::fs::remove_file(dir.join("version"));
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("package"), bytes).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("version"), version).map_err(|e| e.to_string())
}

/// Checks the signature again before a staged package is installed.
///
/// It was verified when it was downloaded, but it then sat on disk for as long
/// as the app kept running, and on Windows the MSI installs with elevation:
/// whoever can write the cache directory could otherwise have their own
/// installer run as administrator the moment the user accepts the prompt.
fn verify(app: &AppHandle, bytes: &[u8], signature: &str) -> Result<(), String> {
    let pubkey = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str())
        .ok_or("no updater pubkey configured")?;
    verify_with(pubkey, bytes, signature)
}

/// The plugin's own check, repeated: both the key and the signature arrive as
/// base64 of minisign's text format.
fn verify_with(pubkey: &str, bytes: &[u8], signature: &str) -> Result<(), String> {
    let decode = |b64: &str| -> Result<String, String> {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| e.to_string())?;
        String::from_utf8(raw).map_err(|e| e.to_string())
    };
    let key = minisign_verify::PublicKey::decode(&decode(pubkey)?).map_err(|e| e.to_string())?;
    let sig = minisign_verify::Signature::decode(&decode(signature)?).map_err(|e| e.to_string())?;
    key.verify(bytes, &sig, true).map_err(|e| e.to_string())
}

async fn check_and_stage(
    app: &AppHandle,
    progress: impl Fn(u64, Option<u64>),
) -> Result<CheckResult, String> {
    let state = app.state::<UpdaterState>();
    let _one_at_a_time = state.0.lock().await;

    let current = app.package_info().version.to_string();
    let snapshot = !app.package_info().version.pre.is_empty();
    log::debug!(
        "檢查更新：目前 {current}，{}通道",
        if snapshot { "快照（Pages 上的 snapshot.json）" } else { "正式版（releases/latest）" }
    );
    let checked = channel(app)?
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await;
    let update = match checked {
        Ok(update) => update,
        // Every endpoint answered, none with a manifest: nothing has been
        // published to update to (for a release build, until the first
        // release is). Not an error to show anyone.
        Err(tauri_plugin_updater::Error::ReleaseNotFound) => {
            log::debug!("這個通道還沒有發布任何更新資訊");
            None
        }
        Err(e) => {
            log::warn!("檢查更新失敗：{e}");
            return Err(e.to_string());
        }
    };
    let Some(update) = update else {
        log::debug!("已是最新版 {current}");
        return Ok(CheckResult::UpToDate { current });
    };
    log::info!("有新版本 {}（目前 {current}），開始下載", update.version);

    let dir = staging_dir(app)?;
    if staged_version(&dir).as_deref() == Some(update.version.as_str()) {
        log::debug!("{} 已經下載好了，等重新啟動", update.version);
        let _ = app.emit("update-staged", &update.version);
        return Ok(CheckResult::Staged {
            version: update.version,
        });
    }

    let mut downloaded = 0u64;
    let started = std::time::Instant::now();
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                progress(downloaded, total);
            },
            || {},
        )
        .await
        .map_err(|e| {
            log::warn!("下載 {} 失敗：{e}", update.version);
            e.to_string()
        })?;
    stage(&dir, &update.version, &bytes)?;
    log::info!(
        "{} 下載完成（{}，花了 {}），下次啟動時安裝",
        update.version,
        crate::logging::fmt_bytes(bytes.len() as u64),
        crate::logging::fmt_dur(started.elapsed())
    );

    let _ = app
        .notification()
        .builder()
        .title(format!(
            "TREM Lite {} 已下載",
            crate::version::label(&update.version)
        ))
        .body("將在下次啟動時自動更新。")
        .show();

    let _ = app.emit("update-staged", &update.version);
    Ok(CheckResult::Staged {
        version: update.version,
    })
}

/// The version downloaded and waiting for a restart, if any: for a window that
/// opens after `update-staged` was sent.
#[tauri::command]
pub fn update_pending(app: AppHandle) -> Option<String> {
    staging_dir(&app).ok().and_then(|dir| staged_version(&dir))
}

/// Restart to install the staged update (it is installed at launch, before the
/// window shows). `hidden`: the main window is hidden, so the app comes back
/// hidden as well.
#[tauri::command]
pub fn update_restart(app: AppHandle, hidden: bool) {
    if hidden {
        if let Ok(dir) = app.path().app_local_data_dir() {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join(HIDDEN_MARKER), "");
        }
    }
    log::info!(
        "重新啟動以安裝已下載的更新（主視窗{}）",
        if hidden { "隱藏中，重啟後維持隱藏" } else { "顯示中" }
    );
    app.restart();
}

/// Whether a restart for an update left the window hidden. The marker stays
/// until [`clear_restart_hidden`], so a second restart — the install at launch
/// — keeps it hidden too.
pub fn restart_hidden(app: &AppHandle) -> bool {
    let Ok(dir) = app.path().app_local_data_dir() else {
        return false;
    };
    std::fs::metadata(dir.join(HIDDEN_MARKER))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|at| at.elapsed().ok())
        .is_some_and(|age| age < HIDDEN_MARKER_TTL)
}

pub fn clear_restart_hidden(app: &AppHandle) {
    if let Ok(dir) = app.path().app_local_data_dir() {
        let _ = std::fs::remove_file(dir.join(HIDDEN_MARKER));
    }
}

/// Installs the package staged by an earlier session, if it is still the
/// latest. Returns only when nothing was installed: installing restarts the app
/// (or, on Windows, exits it for the installer, which relaunches it).
async fn apply_staged(app: &AppHandle) -> Result<(), String> {
    let dir = staging_dir(app)?;
    let Some(version) = staged_version(&dir) else {
        return Ok(());
    };
    log::info!("啟動時發現已下載的更新 {version}，先確認它仍是最新版");

    // Offline, this fails and the package stays staged for the next launch.
    let update = channel(app)?
        .timeout(LAUNCH_CHECK_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;

    // Past this point the package is either installed or stale, so it is gone
    // either way — a package that fails to verify or install is fetched afresh
    // rather than retried at every launch.
    let bytes = std::fs::read(dir.join("package"));
    let _ = std::fs::remove_dir_all(&dir);

    // `check` only answers with a version newer than this build, so a match also
    // proves the package is still an upgrade. Anything else is stale: the
    // running version already has it, or a newer one has shipped since, which
    // the background check downloads for the launch after this one.
    let Some(update) = update.filter(|u| u.version == version) else {
        log::info!("已下載的 {version} 不再是最新版，丟棄，改由背景檢查下載新的");
        return Ok(());
    };
    let bytes = bytes.map_err(|e| e.to_string())?;
    verify(app, &bytes, &update.signature).inspect_err(|e| {
        log::error!("{version} 的簽章驗證失敗，不安裝：{e}");
    })?;

    log::info!("安裝已下載的更新 {version}，完成後重新啟動");
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart()
}

/// The updater for this build's channel: a snapshot follows snapshots
/// (SNAPSHOT_MANIFEST), a release follows releases.
fn channel(app: &AppHandle) -> Result<UpdaterBuilder, String> {
    let builder = app
        .updater_builder()
        .version_comparator(|current, remote| is_newer(&remote.version, &current));
    if app.package_info().version.pre.is_empty() {
        return Ok(builder);
    }
    let url = SNAPSHOT_MANIFEST.parse().map_err(|e| format!("{e}"))?;
    builder.endpoints(vec![url]).map_err(|e| e.to_string())
}

/// The updater's "is this newer?": semver's order, except between two
/// snapshots of one train (snapshot_order).
fn is_newer<V: PartialOrd + ToString>(remote: &V, current: &V) -> bool {
    match snapshot_order(&remote.to_string(), &current.to_string()) {
        Some(order) => order == Ordering::Greater,
        None => remote > current,
    }
}

/// Two snapshots of one train, in the order they were cut. Semver compares
/// their labels as text, which goes wrong past a week's 26th: `26w40aa` sorts
/// before `26w40z`, and would never be offered. A label is read as year, week,
/// then its letters — by count, then alphabetically. None when either is not a
/// snapshot or their trains differ: semver's order is right then.
fn snapshot_order(a: &str, b: &str) -> Option<Ordering> {
    let (train_a, key_a) = snapshot_key(a)?;
    let (train_b, key_b) = snapshot_key(b)?;
    (train_a == train_b).then(|| key_a.cmp(&key_b))
}

/// A snapshot label's place in line: year, week, letter count, letters.
type LabelKey<'a> = (u32, u32, usize, &'a str);

/// `26.1.0-26w40ab` → ("26.1.0", (26, 40, 2, "ab")).
fn snapshot_key(version: &str) -> Option<(&str, LabelKey<'_>)> {
    let version = version.split('+').next()?;
    let (train, label) = version.split_once('-')?;
    let (year, rest) = label.split_once('w')?;
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    let (week, letters) = rest.split_at(digits);
    if year.len() != 2 || week.is_empty() || letters.is_empty() {
        return None;
    }
    if !letters.bytes().all(|b| b.is_ascii_lowercase()) {
        return None;
    }
    let year = year.parse().ok()?;
    let week = week.parse().ok()?;
    Some((train, (year, week, letters.len(), letters)))
}

/// Starts OTA. `reveal` shows (or keeps hidden) the main window; it runs once
/// any staged update has been dealt with, so an install never happens under a
/// window someone is looking at.
pub fn start(app: &AppHandle, reveal: impl FnOnce(&AppHandle) + Send + 'static) {
    // The legacy client never updated a development build, and neither does this.
    if cfg!(debug_assertions) {
        log::info!("開發版不自動更新");
        reveal(app);
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = apply_staged(&app).await {
            log::warn!("已下載的更新這次沒有安裝，留到下次啟動：{e}");
        }
        reveal(&app);
        loop {
            if let Err(e) = check_and_stage(&app, |_, _| {}).await {
                log::debug!("這次檢查更新沒有完成：{e}");
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// The settings page's "check now": the same check and download, with progress.
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    on_progress: Channel<Progress>,
) -> Result<CheckResult, String> {
    log::info!("使用者按下「檢查更新」");
    check_and_stage(&app, |downloaded, total| {
        let _ = on_progress.send(Progress { downloaded, total });
    })
    .await
}

#[cfg(test)]
mod channel_tests {
    use super::snapshot_order;
    use std::cmp::Ordering::{Greater, Less};

    /// `a` is the later of two snapshots, whichever way round they are asked.
    fn later(a: &str, b: &str) -> bool {
        snapshot_order(a, b) == Some(Greater) && snapshot_order(b, a) == Some(Less)
    }

    #[test]
    fn snapshots_of_a_train_follow_their_labels() {
        assert!(later("26.1.0-26w40b", "26.1.0-26w40a"));
        assert!(later("26.1.0-26w41a", "26.1.0-26w40p"));
    }

    #[test]
    fn the_27th_snapshot_of_a_week_follows_the_26th() {
        assert!(later("26.1.0-26w40aa", "26.1.0-26w40z"));
        assert!(later("26.1.0-26w40ab", "26.1.0-26w40aa"));
    }

    #[test]
    fn anything_else_is_left_to_semver() {
        assert_eq!(snapshot_order("26.2.0-26w45a", "26.1.0-26w44z"), None);
        assert_eq!(snapshot_order("26.1.0", "26.1.0-26w40a"), None);
        assert_eq!(snapshot_order("26.1.0-rc.1", "26.1.0-26w40a"), None);
    }
}

#[cfg(test)]
mod verify_tests {
    //! `verify` against a real signed release asset: a staged package is only
    //! installed if this passes, so a mistake here blocks every update.
    fn check(bytes: &[u8], sig: &str) -> Result<(), String> {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let pubkey = conf["plugins"]["updater"]["pubkey"].as_str().unwrap();
        super::verify_with(pubkey, bytes, sig)
    }

    #[test]
    fn a_published_package_verifies_and_a_tampered_one_does_not() {
        let (Ok(pkg), Ok(sig)) = (
            std::env::var("TREM_TEST_PKG"),
            std::env::var("TREM_TEST_SIG"),
        ) else {
            eprintln!("skipped: set TREM_TEST_PKG and TREM_TEST_SIG");
            return;
        };
        let mut bytes = std::fs::read(pkg).unwrap();
        let sig = std::fs::read_to_string(sig).unwrap();
        assert_eq!(check(&bytes, &sig), Ok(()));
        bytes[4096] ^= 1;
        assert!(check(&bytes, &sig).is_err(), "a flipped bit must fail");
    }
}
