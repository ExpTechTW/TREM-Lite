const { ipcRenderer } = require('electron');
const os = require('node:os');
const { app } = require('@electron/remote');

class Config {
  constructor() {
    this.data = null;
    this.version = document.querySelector('.app-version');
    this.os = document.querySelector('.system-os');
    this.cpu = document.querySelector('.system-cpu');
    this.resetButton = document.querySelector('.reset-button');
    this.checkBoxes = document.querySelectorAll('.switch input');
    this.resetConfirmWrapper = document.querySelector('.confirm-wrapper');
    this.resetSureButton = document.querySelector('.reset-sure');
    this.warningIntensity = document.querySelectorAll('.warning-intensity');
    this.resetCancelButton = document.querySelector('.reset-cancel');
    this.userLocation = document.querySelector('.usr-location');
    this.realtimeStation = document.querySelector('.realtime-station');
    this.init();
    this.info();
  }

  async init() {
    this.data = await this.get();
    TREM.variable.events.emit('config-ready', this.data);
    this.resetSureButton.addEventListener('click', () => this.resetSetting());
    this.resetButton.addEventListener('click', () => {
      this.resetConfirmWrapper.classList.add('reset');
      this.resetConfirmWrapper.style.bottom = '0%';
    });

    this.resetCancelButton.addEventListener('click', () => {
      this.resetConfirmWrapper.classList.remove('reset');
      this.resetConfirmWrapper.style.bottom = '-100%';
    });
  }

  async resetSetting() {
    const resetConfig = {};
    [this.userLocation, this.realtimeStation].forEach((container) => {
      const current = container.querySelector('.current');
      if (current) {
        current.textContent = '';
      }
    });
    this.warningIntensity.forEach((element) => {
      element.className = element.className
        .split(' ')
        .filter((cls) => !cls.startsWith('intensity-'))
        .join(' ');
      element.classList.add('intensity-0');
    });
    this.checkBoxes.forEach((checkbox) => {
      checkbox.checked = false;
      resetConfig[checkbox.id] = false;
    });
    const res = await this.write({
      CHECKBOX: resetConfig,
      DROPDOWN: { 'realtime-int': 0, 'estimate-int': 0, 'location': null, 'station': null },
    });
    if (res.status === true) {
      this.resetConfirmWrapper.style.bottom = '-100%';
    }
  }

  info() {
    this.version.textContent = app.getVersion();
    this.os.textContent = `${os.version()} (${os.release()})`;
    this.cpu.textContent = os.cpus()[0].model;
  }

  async get() {
    return new Promise((resolve, reject) => {
      ipcRenderer.send('get-config');
      ipcRenderer.once('get-config-res', (event, res) => {
        if (res && res.status !== false) {
          resolve(res);
        }
        else {
          reject(res?.error || 'Failed to load config');
        }
      });
    });
  }

  write(data) {
    return new Promise((resolve, reject) => {
      ipcRenderer.send('write-config', data);
      ipcRenderer.once('write-config-res', (event, res) => {
        if (res && res.status === true) {
          resolve(res);
        }
        else {
          reject(res?.error || 'Failed to save config');
        }
      });
    });
  }
}

module.exports = {
  Config,
  Instance: new Config(),
};
