const { ipcRenderer } = require('electron');

class Config {
  constructor() {
    this.data = null;
    this.init();
  }

  async init() {
    this.data = await this.get();
    TREM.variable.events.emit('config-ready', this.data);
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
