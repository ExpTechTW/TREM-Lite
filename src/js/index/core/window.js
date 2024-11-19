const TREM = require('../constant');

const { BrowserWindow } = require('@electron/remote');
const win = BrowserWindow.fromId(process.env.window * 1);

const { ipcRenderer } = require('electron');

class WindowControler {
  static instance = null;

  constructor() {
    if (WindowControler.instance) {
      return WindowControler.instance;
    }
    this.bindEvents();
    WindowControler.instance = this;
  }

  static getInstance() {
    if (!WindowControler.instance) {
      new WindowControler();
    }
    return WindowControler.instance;
  }

  bindEvents() {
    TREM.variable.events.on('EewRelease', () => this.windowFocus());
    TREM.variable.events.on('EewAlert', () => this.windowFocus());
    TREM.variable.events.on('RtsPga2', () => this.windowFocus());
    TREM.variable.events.on('RtsPga1', () => this.windowFocus());
    TREM.variable.events.on('RtsShindo2', () => this.windowFocus());
    TREM.variable.events.on('RtsShindo1', () => this.windowFocus());
    TREM.variable.events.on('RtsShindo0', () => this.windowFocus());
    TREM.variable.events.on('ReportRelease', () => this.windowFocus());
    TREM.variable.events.on('IntensityRelease', () => this.windowFocus());
    TREM.variable.events.on('TsunamiRelease', () => this.windowFocus());
    TREM.variable.events.on('EewNewAreaAlert', () => this.windowFocus());
  }

  windowFocus() {
    if ((win.isMinimized() || !win.isVisible()) && TREM.constant.GAME_MODE) {
      ipcRenderer.send('toggle-pip');
      return;
    }
    win.flashFrame(true);
    win.setAlwaysOnTop(true);
    win.show();
    win.setAlwaysOnTop(false);
  }
}

win.on('minimize', () => {
  if (TREM.constant.GAME_MODE && status_alert()) {
    ipcRenderer.send('toggle-pip');
  }
});

win.on('close', () => {
  if (TREM.constant.GAME_MODE && status_alert()) {
    ipcRenderer.send('toggle-pip');
  }
});

function status_alert() {
  return TREM.variable.cache.rts_trigger.loc.length || TREM.variable.cache.show_eew_box;
}

ipcRenderer.send('toggle-pip');

TREM.class.WindowControler = WindowControler;

WindowControler.getInstance();
