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
const fs = require('fs');

let win;
let SettingWindow;
let tray = null;
let forceQuit = false;
const hide = process.argv.includes('--start') ? true : false;
const test = process.argv.includes('--raw') ? 0 : 1;
const pluginDir = path.join(app.getPath('userData'), 'plugins');

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
    if (!hide) win.show();
  });

  win.on('close', (event) => {
    if (forceQuit) {
      win = null;
      return;
    }

    if (process.platform === 'darwin') {
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

  win.loadFile('./src/view/index.html');
}

function createSettingWindow() {
  if (SettingWindow instanceof BrowserWindow)
    return SettingWindow.focus();

  SettingWindow = new BrowserWindow({
    title: 'TREM-Lite Setting',
    width: 970,
    height: 590,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    vibrancy: 'ultra-dark',
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
  });
  ipcMain.on('minimize-window', () => {
    if (SettingWindow) SettingWindow.minimize();
  });
}

const shouldQuit = app.requestSingleInstanceLock();

if (!shouldQuit) app.quit();
else {
  app.on('second-instance', () => {
    if (win != null) win.show();
  });
  app.whenReady().then(() => {
    trayIcon();
    createWindow();
  });
}

app.on('window-all-closed', (event) => {
  event.preventDefault();
  if (process.platform !== 'darwin')
    app.quit();
});

app.on('before-quit', () => {
  forceQuit = true;
});

app.on('activate', () => {
  if (win === null)
    createWindow();
  else
    win.show();
});

app.on('browser-window-created', (e, window) => {
  window.removeMenu();
});

ipcMain.on('openSettingWindow', () => createSettingWindow());

ipcMain.on('israw', () => {
  win.webContents.send('israwok', test);
});

ipcMain.on('openUrl', (_, url) => {
  shell.openExternal(url);
});

ipcMain.on('openDevtool', () => {
  const currentWindow = BrowserWindow.getFocusedWindow();
  if (currentWindow) currentWindow.webContents.openDevTools({ mode: 'detach' });
});

ipcMain.on('reload', () => {
  const currentWindow = BrowserWindow.getFocusedWindow();
  if (currentWindow) currentWindow.webContents.reload();
});

ipcMain.on('minimize', () => {
  if (win) win.minimize();
});

ipcMain.on('hide', () => {
  if (win) win.hide();
});

ipcMain.on('toggleFullscreen', () => {
  if (win) win.setFullScreen(!win.isFullScreen());
});

ipcMain.on('openPluginFolder', () => {
  if (!fs.existsSync(pluginDir))
    fs.mkdirSync(pluginDir, { recursive: true });

  shell.openPath(pluginDir)
    .catch((error) => {
      console.error(error);
    });
});

function trayIcon() {
  if (tray) {
    tray.destroy();
    tray = null;
  }

  tray = new Tray(nativeImage.createFromPath('TREM.ico'));
  tray.setIgnoreDoubleClickEvents(true);
  tray.on('click', () => {
    if (win != null)
      if (win.isVisible())
        win.hide();
      else
        win.show();
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
  app.relaunch();
  forceQuit = true;
  app.quit();
}
