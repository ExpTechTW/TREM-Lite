const { ipcRenderer } = require('electron');

class Config {
  get() {
    return new Promise((resolve) => {
      ipcRenderer.send('get-config');
      ipcRenderer.removeAllListeners('get-config-res');
      ipcRenderer.on('get-config-res', (event, res) => {
        resolve(res);
      });
    });
  }

  write(data) {
    return new Promise((resolve) => {
      ipcRenderer.send('write-config', data);
      ipcRenderer.removeAllListeners('write-config-res');
      ipcRenderer.on('write-config-res', (event, res) => {
        resolve(res);
      });
    });
  }
}

const config = new Config();
module.exports = config;
