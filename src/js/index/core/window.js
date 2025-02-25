const TREM = require('../constant');

const { BrowserWindow } = require('@electron/remote');
const win = BrowserWindow.fromId(process.env.window * 1);

const { ipcRenderer } = require('electron');
const Config = require('../../core/config');

class WindowControler {
  static instance = null;

  constructor() {
    if (WindowControler.instance) {
      return WindowControler.instance;
    }
    this.config = Config.getInstance().getConfig();

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
    TREM.constant.WINDOW_FOCUS_EVENTS.forEach((event) => {
      TREM.variable.events.on(event, (ans) => this.windowFocus(event, ans));
    });
  }

  windowFocus(event, ans) {
    if (event == 'ReportRelease' && !this.config['check-box']['show-window-report']) {
      return;
    }
    if (event.startsWith('Rts') && !this.config['check-box']['show-window-detect']) {
      return;
    }
    if ((event == 'IntensityRelease' || event == 'LpgmRelease') && !this.config['check-box']['show-window-rts-intensity']) {
      return;
    }
    if (event.startsWith('Eew') && !this.config['check-box']['show-window-eew']) {
      return;
    }
    if ((win.isMinimized() || !win.isVisible()) && TREM.constant.GAME_MODE) {
      if (TREM.constant.SHOW_PIP_EVENTS.includes(event)) {
        const isEew = event.startsWith('Eew');
        const shouldShow = !isEew || ans.data.author !== 'trem' || TREM.constant.SHOW_TREM_EEW;

        if (shouldShow) {
          ipcRenderer.send('toggle-pip');
        }
      }
      return;
    }
    win.flashFrame(true);
    win.setAlwaysOnTop(true);
    if (win.isMinimized()) {
      win.restore();
    }
    else if (!win.isVisible()) {
      win.show();
    }

    if (win.isMaximized()) {
      win.maximize();
    }

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

TREM.class.WindowControler = WindowControler;

WindowControler.getInstance();
