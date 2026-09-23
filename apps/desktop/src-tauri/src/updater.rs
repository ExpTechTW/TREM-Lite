//! Over-the-air updates: downloaded in the background whenever one exists,
//! applied the next time the app starts — never while it is running.
//!
//! Installing is not the same act on every platform. For the macOS bundle it
//! swaps files under the running app, which is harmless until it needs an
//! administrator password; on Windows the plugin hands over to the installer
//! and calls `exit(0)`; the Linux .deb asks for a password through pkexec. So
//! nothing is installed mid-session anywhere: a download is staged
//! on disk and installed at the next launch, before the main window is shown.

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use tauri::async_runtime::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

/// How often to look for an update. Matches the legacy client.
const CHECK_EVERY: Duration = Duration::from_secs(300);

/// The launch-time check waits at most this long. A staged package is only
/// installed once the server confirms it is still the latest, and an offline
/// start must not keep the main window hidden waiting for that answer.
const LAUNCH_CHECK_TIMEOUT: Duration = Duration::from_secs(5);

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
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let Some(update) = update else {
        return Ok(CheckResult::UpToDate { current });
    };

    let dir = staging_dir(app)?;
    if staged_version(&dir).as_deref() == Some(update.version.as_str()) {
        return Ok(CheckResult::Staged {
            version: update.version,
        });
    }

    let mut downloaded = 0u64;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                progress(downloaded, total);
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    stage(&dir, &update.version, &bytes)?;
    log::info!("update {} staged for the next launch", update.version);

    let _ = app
        .notification()
        .builder()
        .title(format!("TREM Lite {} 已下載", update.version))
        .body("將在下次啟動時自動更新。")
        .show();

    Ok(CheckResult::Staged {
        version: update.version,
    })
}

/// Installs the package staged by an earlier session, if it is still the
/// latest. Returns only when nothing was installed: installing restarts the app
/// (or, on Windows, exits it for the installer, which relaunches it).
async fn apply_staged(app: &AppHandle) -> Result<(), String> {
    let dir = staging_dir(app)?;
    let Some(version) = staged_version(&dir) else {
        return Ok(());
    };

    // Offline, this fails and the package stays staged for the next launch.
    let update = app
        .updater_builder()
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
        return Ok(());
    };
    let bytes = bytes.map_err(|e| e.to_string())?;
    verify(app, &bytes, &update.signature)?;

    log::info!("installing staged update {version}");
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart()
}

/// Starts OTA. `reveal` shows (or keeps hidden) the main window; it runs once
/// any staged update has been dealt with, so an install never happens under a
/// window someone is looking at.
pub fn start(app: &AppHandle, reveal: impl FnOnce(&AppHandle) + Send + 'static) {
    // The legacy client never updated a development build, and neither does this.
    if cfg!(debug_assertions) {
        reveal(app);
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = apply_staged(&app).await {
            log::warn!("staged update not applied: {e}");
        }
        reveal(&app);
        loop {
            if let Err(e) = check_and_stage(&app, |_, _| {}).await {
                log::debug!("update check skipped: {e}");
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
    check_and_stage(&app, |downloaded, total| {
        let _ = on_progress.send(Progress { downloaded, total });
    })
    .await
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
