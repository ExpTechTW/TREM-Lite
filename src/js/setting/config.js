const { ipcRenderer } = require('electron');

class Config {
  constructor() {
    this.get();
  }

  get() {
    console.log(true);
    ipcRenderer.send('get-config');
    ipcRenderer.removeAllListeners('config-res');
    ipcRenderer.on('get-config-res', (event, res) => {
      console.log(res);
    });
  }

  write(data) {
    console.log(true);
    ipcRenderer.send('write-config', data);
    ipcRenderer.removeAllListeners('write-config');
    ipcRenderer.on('write-config-res', (event, res) => {
      console.log(res);
    });
  }
}

// 使用範例
const config = new Config();

// 讀取設定
config.get();

// 寫入設定
config.write({
  INFO: { langid: 'en-us', version: '3.0.1' },
  STRING: { 'trem-eew': 'false' },
});
