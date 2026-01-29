const fs = require('fs-extra');
const yaml = require('js-yaml');
const { autoUpdater } = require('electron-updater');

let configDir = null;
let updateCheckInterval = null;

let lastOtaEnabled = null;
let lastOtaDesiredEnabled = null;
let lastSchedulerRunning = null;

// 讀取設定
function readUserConfig() {
  try {
    if (!configDir || !fs.existsSync(configDir)) {
      return null;
    }
    const raw = fs.readFileSync(configDir, 'utf8');
    return yaml.load(raw) ?? null;
  }
  catch (err) {
    console.error('Failed to read user config:', err);
    return null;
  }
}

// 取得 OTA 自動更新啟用狀態
function getOtaAutoUpdateDesiredEnabled() {
  const cfg = readUserConfig();
  const value = cfg?.['check-box']?.['ota-auto-update'];
  return typeof value === 'boolean' ? value : true;
}

// OTA 狀態
function logOtaStatus(app, reason = 'unknown') {
  const desiredEnabled = getOtaAutoUpdateDesiredEnabled();
  const effectiveEnabled = app.isPackaged ? desiredEnabled : false;
  const schedulerRunning = Boolean(updateCheckInterval);

  const changed = effectiveEnabled !== lastOtaEnabled
    || desiredEnabled !== lastOtaDesiredEnabled
    || schedulerRunning !== lastSchedulerRunning;
  if (!changed) {
    return;
  }

  lastOtaEnabled = effectiveEnabled;
  lastOtaDesiredEnabled = desiredEnabled;
  lastSchedulerRunning = schedulerRunning;

  console.log(
    `[OTA] reason=${reason} packaged=${app.isPackaged} desiredEnabled=${desiredEnabled} effectiveEnabled=${effectiveEnabled} scheduler=${schedulerRunning ? 'running' : 'stopped'}`,
  );
}

function stopAutoUpdateScheduler() {
  if (updateCheckInterval) {
    clearInterval(updateCheckInterval);
    updateCheckInterval = null;
  }
}

// 啟動檢查
function startAutoUpdateScheduler(app) {
  if (!app.isPackaged) {
    console.log('[OTA] startAutoUpdateScheduler skipped (not packaged)');
    return;
  }
  if (updateCheckInterval) {
    console.log('[OTA] startAutoUpdateScheduler skipped (already running)');
    return;
  }

  console.log('[OTA] Auto update scheduler started');
  autoUpdater.checkForUpdates().catch(() => undefined);
  updateCheckInterval = setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => undefined);
  }, 300000);
}

// 刷新自動更新
function refreshAutoUpdateScheduler(app, reason = 'refresh') {
  console.log(`[OTA] refreshAutoUpdateScheduler reason=${reason} packaged=${app.isPackaged}`);
  if (!app.isPackaged) {
    stopAutoUpdateScheduler();
    logOtaStatus(app, `${reason}:not_packaged`);
    return;
  }

  const enabled = getOtaAutoUpdateDesiredEnabled();
  if (enabled) {
    startAutoUpdateScheduler(app);
    logOtaStatus(app, `${reason}:enabled`);
  }
  else {
    stopAutoUpdateScheduler();
    logOtaStatus(app, `${reason}:disabled`);
  }
}

// 初始化
function initAutoUpdater({
  app,
  configPath,
  getMainWindow,
  getSettingWindow,
  onBeforeQuitAndInstall,
}) {
  configDir = configPath;

  const sendToWindows = (channel, payload) => {
    const mainWin = typeof getMainWindow === 'function' ? getMainWindow() : null;
    const settingWin = typeof getSettingWindow === 'function' ? getSettingWindow() : null;

    if (mainWin) {
      mainWin.webContents.send(channel, payload);
    }
    if (settingWin && !settingWin.isDestroyed()) {
      settingWin.webContents.send(channel, payload);
    }
  };

  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;

    if (app.isPackaged) {
      autoUpdater.setFeedURL({
        provider: 'github',
        owner: 'ExpTechTW',
        repo: 'TREM-Lite',
        vPrefixedTagName: false,
      });
    }

    autoUpdater.on('checking-for-update', () => {
      console.log('Checking for update...');
      sendToWindows('update-checking');
    });

    autoUpdater.on('update-available', (info) => {
      console.log('Update available:', info.version);
      sendToWindows('update-available', info);
    });

    autoUpdater.on('update-not-available', (info) => {
      console.log('Update not available:', info.version);
      sendToWindows('update-not-available', info);
    });

    autoUpdater.on('download-progress', (progressObj) => {
      console.log('Download progress:', progressObj.percent);
      sendToWindows('download-progress', progressObj);
    });

    autoUpdater.on('update-downloaded', (info) => {
      console.log('Update downloaded:', info.version);
      sendToWindows('update-downloaded', info);
      setTimeout(() => {
        try {
          if (typeof onBeforeQuitAndInstall === 'function') {
            onBeforeQuitAndInstall();
          }
        }
        catch (err) {
          console.error('onBeforeQuitAndInstall error:', err);
        }
        autoUpdater.quitAndInstall(true, true);
      }, 3000);
    });

    autoUpdater.on('error', (err) => {
      const message = err && err.message ? err.message : err;
      console.error('Update error:', message);
      sendToWindows('update-error', err?.message);
    });

    refreshAutoUpdateScheduler(app, 'init');
  }
  catch (err) {
    console.error('Auto-updater init error:', err);
  }

  return {
    refresh: (reason = 'refresh') => refreshAutoUpdateScheduler(app, reason),
    getDesiredEnabled: () => getOtaAutoUpdateDesiredEnabled(),
  };
}

module.exports = {
  initAutoUpdater,
  refreshAutoUpdateScheduler,
};
