const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  Tray,
  nativeImage,
  Menu,
} = require('electron');
const path = require('path');
const fs = require('fs-extra');
const yaml = require('js-yaml');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');

const store = new Store();
let win;
let SettingWindow;
let pipWindow = null;
let tray = null;
let forceQuit = false;
const hide = process.argv.includes('--start') ? true : false;
const pluginDir = path.join(app.getPath('userData'), 'plugins');
const replayDir = path.join(app.getPath('userData'), 'replay');
const tempDir = path.join(app.getPath('userData'), 'plugins-temp');
const configDir = path.join(app.getPath('userData'), 'user/config.yml');

const is_mac = process.platform === 'darwin';
const is_linux = process.platform === 'linux';

const iconPath = path.join(__dirname, 'TREM.png');
const appIcon = nativeImage.createFromPath(iconPath);

if (is_mac) {
  app.dock.setIcon(appIcon.resize({ width: 128, height: 128 }));
}

function updateAutoLaunchSetting(value) {
  if (process.env.NODE_ENV === 'development') {
    return;
  }

  app.setLoginItemSettings({
    openAtLogin: value ? true : false,
    name: 'TREM Lite',
    args: ['--start'],
  });
}

function createWindow() {
  store.clear();
  const winState = store.get('windowState', { width: 1280, height: 815 });

  win = new BrowserWindow({
    title: 'TREM Lite',
    minWidth: 900,
    minHeight: 680,
    width: winState.width,
    height: winState.height,
    x: winState.x,
    y: winState.y,
    maximizable: true,
    icon: appIcon,
    frame: true,
    webPreferences: {
      nodeIntegration: true,
      backgroundThrottling: false,
      contextIsolation: false,
    },
  });

  process.env.window = win.id;

  require('@electron/remote/main').initialize();
  require('@electron/remote/main').enable(win.webContents);

  updateAutoLaunchSetting(true);

  win.setMenu(null);

  win.webContents.on('did-finish-load', () => {
    if (!hide) {
      win.show();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', (event) => {
    const bounds = win.getBounds();
    store.set('windowState', bounds);

    if (forceQuit) {
      win = null;
      return;
    }

    if (is_mac) {
      event.preventDefault();
      win.hide();
    }
    else {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('blur', () => {
    win.webContents.send('blur');
  });

  win.on('focus', () => {
    win.webContents.send('focus');
  });

  win.on('resize', () => {
    const [width, height] = win.getSize();
    win.webContents.send('window-resized', { width, height });
  });

  win.on('show', () => {
    if (pipWindow) {
      pipWindow.hide();
    }
  });

  win.on('restore', () => {
    if (pipWindow) {
      pipWindow.hide();
    }
  });

  win.loadFile('./src/view/index.html');
}

function createPiPWindow() {
  if (pipWindow) {
    return;
  }

  pipWindow = new BrowserWindow({
    width: 276,
    height: 147,
    minWidth: 276,
    maxWidth: 400,
    icon: 'TREM.ico',
    frame: false,
    show: false,
    focusable: true,
    skipTaskbar: true,
    resizable: true,
    transparent: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      additionalArguments: ['--pip-window'],
    },
  });

  pipWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pipWindow.setAlwaysOnTop(true, 'screen-saver');

  pipWindow.setAspectRatio(1.87);

  pipWindow.setMaximizable(false);
  pipWindow.setPosition(0, 0);
  pipWindow.setIgnoreMouseEvents(false);

  pipWindow.on('closed', () => pipWindow = null);

  pipWindow.loadFile('./src/view/pip.html');
  require('@electron/remote/main').enable(pipWindow.webContents);
}

function createSettingWindow() {
  if (SettingWindow instanceof BrowserWindow) {
    SettingWindow.show();
    return SettingWindow.focus();
  }

  SettingWindow = new BrowserWindow({
    title: 'TREM-Lite Setting',
    width: 970,
    height: 590,
    show: false,
    frame: false,
    transparent: is_mac ? false : true,
    backgroundMaterial: 'acrylic',
    vibrancy: 'sidebar',
    resizable: false,
    ...(is_mac && {
      vibrancy: 'ultra-dark',
    }),
    icon: 'TREM.ico',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
      backgroundThrottling: false,
      nativeWindowOpen: true,
    },
  });
  require('@electron/remote/main').enable(SettingWindow.webContents);
  SettingWindow.loadFile('./src/view/setting.html');
  SettingWindow.setMenu(null);
  SettingWindow.webContents.on('did-finish-load', () => SettingWindow.show());
  SettingWindow.on('close', () => {
    SettingWindow = null;
    if (!forceQuit) {
      win.webContents.reload();
    }
  });
}

const shouldQuit = app.requestSingleInstanceLock();

if (process.platform === 'win32') {
  app.setAppUserModelId('TREM Lite | 臺灣即時地震監測');
}

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('trem-lite', process.execPath, [path.resolve(process.argv[1])]);
  }
}
else {
  app.setAsDefaultProtocolClient('trem-lite');
}

app.on('second-instance', (event, commandLine) => {
  const url = commandLine.find((arg) => arg.startsWith('trem-lite://'));

  if (url) {
    try {
      const urlObj = new URL(url);
      if (urlObj.protocol == 'trem-lite:' && urlObj.pathname.startsWith('/install:')) {
        if (win) {
          win.webContents.executeJavaScript(`
            localStorage.setItem('pendingInstallPlugin', '${urlObj.pathname.replace('/install:', '')}');
          `)
            .then(() => win.webContents.send('auto-download'))
            .catch((err) => console.error('executeJavaScript error:', err));
        }
      }
    }
    catch (error) {
      console.error('Error processing URL:', error);
    }
  }

  if (win) {
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
  }
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  try {
    const urlObj = new URL(url);
    if (urlObj.protocol == 'trem-lite:' && urlObj.pathname.startsWith('/install:')) {
      if (win) {
        win.webContents.executeJavaScript(`
          localStorage.setItem('pendingInstallPlugin', '${urlObj.pathname.replace('/install:', '')}');
        `)
          .then(() => win.webContents.send('auto-download'))
          .catch((err) => console.error('executeJavaScript error:', err));
      }
    }
  }
  catch (error) {
    console.error('Error processing URL:', error);
  }
});

if (!shouldQuit) {
  app.quit();
}
else {
  app.on('second-instance', () => {
    if (win != null) {
      win.show();
    }
  });
  app.whenReady().then(() => {
    trayIcon();
    createWindow();
    createPiPWindow();

    // Auto-updater configuration
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
        if (win) {
          win.webContents.send('update-checking');
        }
        if (SettingWindow && !SettingWindow.isDestroyed()) {
          SettingWindow.webContents.send('update-checking');
        }
      });

      autoUpdater.on('update-available', (info) => {
        console.log('Update available:', info.version);
        if (win) {
          win.webContents.send('update-available', info);
        }
        if (SettingWindow && !SettingWindow.isDestroyed()) {
          SettingWindow.webContents.send('update-available', info);
        }
      });

      autoUpdater.on('update-not-available', (info) => {
        console.log('Update not available:', info.version);
        if (win) {
          win.webContents.send('update-not-available', info);
        }
        if (SettingWindow && !SettingWindow.isDestroyed()) {
          SettingWindow.webContents.send('update-not-available', info);
        }
      });

      autoUpdater.on('download-progress', (progressObj) => {
        console.log('Download progress:', progressObj.percent);
        if (win) {
          win.webContents.send('download-progress', progressObj);
        }
        if (SettingWindow && !SettingWindow.isDestroyed()) {
          SettingWindow.webContents.send('download-progress', progressObj);
        }
      });

      autoUpdater.on('update-downloaded', (info) => {
        console.log('Update downloaded:', info.version);
        if (win) {
          win.webContents.send('update-downloaded', info);
        }
        if (SettingWindow && !SettingWindow.isDestroyed()) {
          SettingWindow.webContents.send('update-downloaded', info);
        }
        isQuitting = true;
        setTimeout(() => {
          autoUpdater.quitAndInstall(true, true);
        }, 3000);
      });

      autoUpdater.on('error', (err) => {
        console.error('Update error:', err && err.message ? err.message : err);
        if (win) {
          win.webContents.send('update-error', err.message);
        }
        if (SettingWindow && !SettingWindow.isDestroyed()) {
          SettingWindow.webContents.send('update-error', err.message);
        }
      });

      if (app.isPackaged) {
        autoUpdater.checkForUpdates().catch(() => undefined);
        setInterval(() => {
          autoUpdater.checkForUpdates().catch(() => undefined);
        }, 300000); // Check every 5 minutes
      }
    }
    catch (err) {
      console.error('Auto-updater init error:', err);
    }
  });
}

app.on('window-all-closed', (event) => {
  event.preventDefault();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  forceQuit = true;
});

app.on('activate', () => {
  if (win === null) {
    createWindow();
  }
  else {
    win.show();
  }
});

app.on('browser-window-created', (e, window) => {
  window.removeMenu();
});

ipcMain.on('update-pip', (event, data) => {
  if (data.noEew) {
    if (pipWindow) {
      pipWindow.hide();
    }
    return;
  }
  if (pipWindow) {
    pipWindow.webContents.send('update-pip-content', data);
  }
});

ipcMain.on('openSettingWindow', () => createSettingWindow());

ipcMain.on('openUrl', (_, url) => {
  shell.openExternal(url);
});

ipcMain.on('openDevtool', () => {
  const currentWindow = BrowserWindow.getFocusedWindow();
  if (currentWindow) {
    currentWindow.webContents.openDevTools({ mode: 'detach' });
  }
});

ipcMain.on('reload', () => {
  const currentWindow = BrowserWindow.getFocusedWindow();
  if (currentWindow) {
    currentWindow.webContents.reload();
  }
});

ipcMain.on('all-reload', () => {
  const allWindows = BrowserWindow.getAllWindows();
  allWindows.forEach((window) => {
    window.webContents.reload();
  });
});

ipcMain.on('hide', () => {
  const currentWindow = BrowserWindow.getFocusedWindow();
  if (currentWindow) {
    currentWindow.hide();
  }
});

ipcMain.on('toggleFullscreen', () => {
  if (win) {
    win.setFullScreen(!win.isFullScreen());
  }
});

ipcMain.on('toggle-pip', () => {
  if (pipWindow) {
    pipWindow.show();
  }
});

ipcMain.on('openReplayFolder', () => {
  if (!fs.existsSync(replayDir)) {
    fs.mkdirSync(replayDir, { recursive: true });
  }

  shell.openPath(replayDir)
    .catch((error) => {
      console.error(error);
    });
});

ipcMain.on('openPluginFolder', () => {
  if (!fs.existsSync(pluginDir)) {
    fs.mkdirSync(pluginDir, { recursive: true });
  }

  shell.openPath(pluginDir)
    .catch((error) => {
      console.error(error);
    });
});

ipcMain.on('openTempFolder', () => {
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  shell.openPath(tempDir)
    .catch((error) => {
      console.error(error);
    });
});

ipcMain.on('openConfigFolder', () => {
  shell.openPath(path.dirname(configDir))
    .catch((error) => {
      console.error(error);
    });
});

ipcMain.on('minimize-window', () => {
  const currentWindow = BrowserWindow.getFocusedWindow();
  if (currentWindow) {
    currentWindow.minimize();
  }
});

ipcMain.on('maximize-window', () => {
  const currentWindow = BrowserWindow.getFocusedWindow();
  if (currentWindow) {
    if (!currentWindow.isMaximized()) {
      currentWindow.maximize();
    }
    currentWindow.setResizable(false);
  }
});

ipcMain.on('restore-window', () => {
  const currentWindow = BrowserWindow.getFocusedWindow();
  if (currentWindow) {
    if (currentWindow.isMaximized()) {
      currentWindow.unmaximize();
    }
    currentWindow.setResizable(true);
  }
});

function trayIcon() {
  if (tray) {
    tray.destroy();
    tray = null;
  }

  let icon;
  if (is_mac || is_linux) {
    const iconPath = path.join(__dirname, 'TREM.png');
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      console.error('Failed to load tray icon');
      return;
    }

    icon = icon.resize({ width: 16, height: 16 });

    icon.setTemplateImage(false);
  }
  else {
    icon = nativeImage.createFromPath(path.join(__dirname, 'TREM.ico'));
  }

  try {
    tray = new Tray(icon);
  }
  catch (error) {
    console.error('Failed to create tray:', error);
    return;
  }

  tray.setIgnoreDoubleClickEvents(true);
  tray.on('click', () => {
    if (win != null) {
      if (win.isVisible()) {
        win.hide();
      }
      else {
        win.show();
      }
    }
  });

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `TREM Lite v${app.getVersion()}`,
      type: 'normal',
      click: () => void 0,
    },
    {
      type: 'separator',
    },
    {
      label: '重新啟動',
      type: 'normal',
      click: () => restart(),
    },
    {
      label: '結束程式',
      type: 'normal',
      click: () => {
        forceQuit = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip(`TREM Lite v${app.getVersion()}`);
  tray.setContextMenu(contextMenu);

  if (is_mac) {
    tray.on('right-click', () => {
      tray.popUpContextMenu(contextMenu);
    });
  }
}

function restart() {
  if (pipWindow) {
    pipWindow.close();
  }
  app.relaunch();
  forceQuit = true;
  app.quit();
}

const pluginWindows = new Map();

function createPluginWindow(pluginId, htmlPath, options = {}) {
  const defaultOptions = {
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      enableRemoteModule: true,
    },
  };

  const windowOptions = { ...defaultOptions, ...options };
  const pluginWindow = new BrowserWindow(windowOptions);

  require('@electron/remote/main').enable(pluginWindow.webContents);

  pluginWindow.loadFile(htmlPath);

  pluginWindow.setMenu(null);

  const windowInfo = {
    window: pluginWindow,
    pluginId,
    htmlPath,
    options,
  };

  pluginWindows.set(pluginWindow.id, windowInfo);

  pluginWindow.on('closed', () => {
    pluginWindows.delete(pluginWindow.id);
    if (win) {
      win.webContents.send('plugin-window-closed', {
        windowId: pluginWindow.id,
        pluginId,
      });
    }
  });

  return pluginWindow;
}

ipcMain.on('open-plugin-window', (event, data) => {
  const { pluginId, htmlPath, options } = data;

  const existingWindowInfo = Array.from(pluginWindows.entries())
    .find(([, info]) => info.pluginId === pluginId);

  if (existingWindowInfo) {
    const [windowId, info] = existingWindowInfo;
    if (!info.window.isDestroyed()) {
      info.window.close();
    }
    pluginWindows.delete(windowId);
  }

  try {
    const pluginWindow = createPluginWindow(pluginId, htmlPath, options);
    pluginWindows.set(pluginId, {
      window: pluginWindow,
      pluginId,
    });

    event.reply('plugin-window-opened', {
      success: true,
      windowId: pluginWindow.id,
      pluginId,
    });
  }
  catch (error) {
    console.error('Error opening plugin window:', error);
    event.reply('plugin-window-opened', {
      success: false,
      error: error.message,
      pluginId,
    });
  }
});

ipcMain.on('close-plugin-window', (event, windowId) => {
  const windowInfo = pluginWindows.get(windowId);
  if (windowInfo) {
    windowInfo.window.close();
    event.reply('plugin-window-closed', {
      success: true,
      windowId,
      pluginId: windowInfo.pluginId,
    });
  }
});

ipcMain.on('close-plugin-windows', (event, pluginId) => {
  for (const [windowInfo] of pluginWindows.entries()) {
    if (windowInfo.pluginId === pluginId) {
      windowInfo.window.close();
    }
  }
  event.reply('plugin-windows-closed', {
    success: true,
    pluginId,
  });
});

ipcMain.on('get-plugin-windows', (event, pluginId) => {
  const windows = Array.from(pluginWindows.entries())
    .filter(([info]) => info.pluginId === pluginId)
    .map(([windowId, info]) => ({
      windowId,
      htmlPath: info.htmlPath,
      options: info.options,
    }));

  event.reply('plugin-windows-list', {
    pluginId,
    windows,
  });
});

ipcMain.on('send-to-plugin-window', (event, data) => {
  const { windowId, channel, payload } = data;
  const windowInfo = pluginWindows.get(windowId);
  if (windowInfo && !windowInfo.window.isDestroyed()) {
    windowInfo.window.webContents.send(channel, payload);
  }
});

ipcMain.on('broadcast-to-plugin-windows', (event, data) => {
  const { pluginId, channel, payload } = data;
  for (const windowInfo of pluginWindows.values()) {
    if (windowInfo.pluginId === pluginId) {
      windowInfo.window.webContents.send(channel, payload);
    }
  }
});

let yamlEditorWindow = null;

ipcMain.handle('read-yaml', async (event, filePath) => {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content;
  }
  catch (error) {
    throw new Error(`無法讀取檔案: ${error.message}`);
  }
});

ipcMain.handle('write-yaml', async (event, filePath, content) => {
  try {
    yaml.load(content);
    await fs.writeFile(filePath, content, 'utf8');
    return true;
  }
  catch (error) {
    throw new Error(`無法寫入檔案: ${error.message}`);
  }
});

ipcMain.on('open-yaml-editor', (event, filePath) => {
  if (yamlEditorWindow instanceof BrowserWindow) {
    yamlEditorWindow.focus();
    yamlEditorWindow.webContents.send('load-path', filePath);
    return;
  }

  yamlEditorWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    title: 'YAML 編輯器',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  require('@electron/remote/main').enable(yamlEditorWindow.webContents);
  yamlEditorWindow.loadFile('./src/view/yaml.html');
  yamlEditorWindow.setMenu(null);

  yamlEditorWindow.webContents.on('did-finish-load', () => {
    yamlEditorWindow.webContents.send('load-path', filePath);
  });

  yamlEditorWindow.on('close', () => {
    yamlEditorWindow = null;
  });
});