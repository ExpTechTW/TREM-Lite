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

let win;
let SettingWindow;
let pipWindow = null;
let tray = null;
let forceQuit = false;
const hide = process.argv.includes('--start') ? true : false;
const pluginDir = path.join(app.getPath('userData'), 'plugins');
const configDir = path.join(app.getPath('userData'), 'user/config.yml');

const is_mac = process.platform === 'darwin';

function updateAutoLaunchSetting(value) {
  app.setLoginItemSettings({
    openAtLogin: value ? true : false,
    name: 'TREM Lite',
    args: ['--start'],
  });
}

function createWindow() {
  win = new BrowserWindow({
    title: `TREM Lite v${app.getVersion()}`,
    minWidth: 900,
    minHeight: 680,
    width: 1280,
    height: 815,
    maximizable: true,
    icon: 'TREM.ico',
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
    win.webContents.reload();
  });
  ipcMain.on('minimize-window', () => {
    if (SettingWindow) {
      SettingWindow.minimize();
    }
  });
}

const shouldQuit = app.requestSingleInstanceLock();

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

    if (is_mac) {
      const iconPath = path.join(__dirname, 'TREM.png');
      app.dock.setIcon(nativeImage.createFromPath(iconPath));
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

ipcMain.on('minimize', () => {
  if (win) {
    win.minimize();
  }
});

ipcMain.on('hide', () => {
  if (win) {
    win.hide();
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

ipcMain.on('openPluginFolder', () => {
  if (!fs.existsSync(pluginDir)) {
    fs.mkdirSync(pluginDir, { recursive: true });
  }

  shell.openPath(pluginDir)
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

function trayIcon() {
  if (tray) {
    tray.destroy();
    tray = null;
  }

  const iconPath = path.join(__dirname, 'TREM.ico');
  tray = new Tray(nativeImage.createFromPath(iconPath));
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
    },
  };

  const windowOptions = { ...defaultOptions, ...options };
  const pluginWindow = new BrowserWindow(windowOptions);

  require('@electron/remote/main').enable(pluginWindow.webContents);

  if (path.isAbsolute(htmlPath)) {
    pluginWindow.loadFile(htmlPath);
  }
  else {
    const absolutePath = path.join(pluginDir, htmlPath);
    pluginWindow.loadFile(absolutePath);
  }

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

  for (const [windowId, windowInfo] of pluginWindows.entries()) {
    if (windowInfo.pluginId === pluginId) {
      if (!windowInfo.window.isDestroyed()) {
        windowInfo.window.close();
      }
      pluginWindows.delete(windowId);
    }
  }

  try {
    const pluginWindow = createPluginWindow(pluginId, htmlPath, options);

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
  for (const [windowId, windowInfo] of pluginWindows.entries()) {
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
    .filter(([_, info]) => info.pluginId === pluginId)
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
  if (windowInfo) {
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
