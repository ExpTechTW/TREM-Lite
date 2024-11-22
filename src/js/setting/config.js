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

// 使用範例
const config = new Config();

// 寫入設定
config.write({
  INFO: { langid: 'en-us', version: '3.0.1' },
  STRING: { 'trem-eew': 'false' },
});
