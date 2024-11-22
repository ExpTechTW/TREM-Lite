const { ipcRenderer } = require('electron');

class Config {
  constructor() {
    this.get();
  }

  get() {
    ipcRenderer.send('get-config');
    ipcRenderer.removeAllListeners('get-config-res');
    ipcRenderer.on('get-config-res', (event, res) => {
      console.log(res);
    });
  }

  write(data) {
    ipcRenderer.send('write-config', data);
    ipcRenderer.removeAllListeners('write-config-res');
    ipcRenderer.on('write-config-res', (event, res) => {
      console.log(res);
    });
  }
}
const config = new Config();
module.exports = config;
