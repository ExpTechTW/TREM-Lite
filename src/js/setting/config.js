const { ipcRenderer } = require('electron');
const os = require('node:os');
const { app } = require('@electron/remote');

class Config {
  constructor() {
    this.version = document.querySelector('.app_ver');
    this.os = document.querySelector('.system_os');
    this.cpu = document.querySelector('.system_cpu');
    this.init();
    this.info();
    this.data = null;
  }

  async init() {
    this.data = await this.get();
    TREM.variable.events.emit('config-ready', this.data);
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
