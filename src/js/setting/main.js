const os = require('node:os');
const { app } = require('@electron/remote');
const { ipcRenderer } = require('electron');

class Main {
  constructor() {
    this.version = document.querySelector('.app-version');
    this.os = document.querySelector('.system-os');
    this.cpu = document.querySelector('.system-cpu');
    this.settingLeftBtns = document.querySelector('.setting-buttons');
    this.settingContent = document.querySelector('.setting-content');
    this.windowsWrapper = document.querySelector('.windows-wrapper');
    this.messageContent = document.querySelector('.message-content');
    this.messageBox = document.querySelector('.message-box');
    this.copyDebugLog = document.querySelector('.copy-debug-log');
    this.settingTab = localStorage.getItem('setting-tab') || null;
    this.init();
    this.info();
    this.renderLastPage();
  }

  async init() {
    this.settingLeftBtns.querySelectorAll('.button').forEach((button) =>
      button.addEventListener('click', (event) => {
        if (event.target.getAttribute('for')) {
          document.querySelector('.setting-options-page.active')?.classList.remove('active');
          document.querySelector('.button.on')?.classList.remove('on');
          event.target.classList.add('on');
          localStorage.setItem('setting-tab', event.target.getAttribute('for'));
          document.querySelector(`.${event.target.getAttribute('for')}`)?.classList.add('active');
        }
      }),
    );

    this.windowsWrapper.addEventListener('click', ({ target }) => {
      if (target.classList.contains('close')) {
        window.close();
      }
      else if (target.classList.contains('minimize')) {
        ipcRenderer.send('minimize-window');
      }
    });

    this.copyDebugLog.addEventListener('click', () => this.copySettingInfo());

    const checkUpdateBtn = document.getElementById('check-update-button');
    if (checkUpdateBtn) {
      checkUpdateBtn.addEventListener('click', () => this.checkForUpdates());
    }

    this.setupUpdateListeners();
  }

  setupUpdateListeners() {
    const updateStatus = document.getElementById('update-status');

    ipcRenderer.on('update-checking', () => {
      console.log('正在檢查更新...');
      if (updateStatus) {
        updateStatus.textContent = '正在檢查更新...';
        updateStatus.className = 'update-status checking';
      }
    });

    ipcRenderer.on('update-available', (_event, info) => {
      const currentVersion = app.getVersion();
      console.log('發現新版本:', info.version, '目前版本:', currentVersion);
      if (updateStatus) {
        updateStatus.textContent = `發現新版本 ${info.version}！正在下載更新...`;
        updateStatus.className = 'update-status available';
      }
    });

    ipcRenderer.on('update-not-available', (_event, info) => {
      console.log('已是最新版本:', info.version);
      if (updateStatus) {
        updateStatus.textContent = `目前已是最新版本 (${info.version})`;
        updateStatus.className = 'update-status not-available';
      }
    });

    ipcRenderer.on('download-progress', (_event, progressObj) => {
      const percent = progressObj.percent.toFixed(1);
      console.log(`下載進度: ${percent}%`);
      if (updateStatus) {
        updateStatus.textContent = `下載進度: ${percent}%`;
        updateStatus.className = 'update-status downloading';
      }
    });

    ipcRenderer.on('update-downloaded', (_event, info) => {
      console.log('更新已下載:', info.version, '準備安裝');
      if (updateStatus) {
        let countdown = 3;
        updateStatus.textContent = `更新已下載完成！應用程式將在 ${countdown} 秒後重啟安裝更新...`;
        updateStatus.className = 'update-status downloaded';

        const countdownInterval = setInterval(() => {
          countdown--;
          if (countdown > 0) {
            updateStatus.textContent = `更新已下載完成！應用程式將在 ${countdown} 秒後重啟安裝更新...`;
          }
          else {
            updateStatus.textContent = '正在重啟應用程式...';
            clearInterval(countdownInterval);
          }
        }, 1000);
      }
    });

    ipcRenderer.on('update-error', (_event, error) => {
      console.error('更新錯誤:', error);
      if (updateStatus) {
        let message = '檢查更新時發生錯誤';
        if (error && error.includes('Cannot find latest.yml')) {
          message = '無法連接到更新伺服器，請稍後再試';
        }
        updateStatus.textContent = message;
        updateStatus.className = 'update-status error';
      }
    });
  }

  async checkForUpdates() {
    const updateStatus = document.getElementById('update-status');

    if (updateStatus) {
      updateStatus.textContent = '正在檢查更新...';
      updateStatus.className = 'update-status checking';
    }

    const result = await ipcRenderer.invoke('check-for-updates');

    if (!result.success) {
      console.error('檢查更新失敗:', result.error);
      if (updateStatus) {
        updateStatus.textContent = `檢查更新失敗：${result.error}`;
        updateStatus.className = 'update-status error';
      }
    }
  }

  renderLastPage() {
    if (this.settingTab) {
      this.settingLeftBtns.querySelectorAll('.button').forEach((button) => {
        button.classList.remove('on');
        document.querySelector(`.setting-${this.settingTab}`).classList.add('on');
      });

      this.settingContent.querySelectorAll('.setting-options-page').forEach((page) => {
        page.classList.remove('active');
        document.querySelector(`.${this.settingTab}`).classList.add('active');
      });
    }
  }

  showBubble(message, duration = 3000) {
    if (!this.messageContent || !this.messageBox || this.messageContent.classList.contains(message) || this.messageBox.classList.contains(message)) {
      return;
    }
    this.messageContent.classList.add(message);
    this.messageBox.classList.add(message);
    setTimeout(() => {
      this.messageContent.classList.remove(message);
      setTimeout(() => {
        this.messageBox.classList.remove(message);
      }, 200);
    }, duration);
  }

  info() {
    this.version.textContent = app.getVersion();
    this.os.textContent = `${os.version()} (${os.release()})`;
    this.cpu.textContent = os.cpus()[0].model;
  }

  copySettingInfo() {
    let loadedList = [];
    let pluginList = '';
    const loaded = JSON.parse(localStorage.getItem('loaded-plugins'));
    const list = JSON.parse(localStorage.getItem('plugin-list'));

    loaded.forEach((item) => {
      loadedList += `${item.name} # ${item.version}\n      `;
    });

    list.forEach((item) => {
      pluginList += `${item.name} # ${item.version}\n      `;
    });

    const message = '```'
      + `
      - - - System Info - - -
      system: ${this.os.textContent}
      cpu: ${this.cpu.textContent}

      - - - TREM Info - - -
      version: ${this.version.textContent}

      - - - Plugin Info - - -
      ${pluginList}
      - - - Loaded Plugin Info - - -
      ${loadedList}
      `
      + '```';
    navigator.clipboard.writeText(message).then(() => {
      this.showBubble('success-copy', 1500);
    }).catch((e) => {
      this.showBubble('error-copy', 1500);
      console.error('error:', e);
    });
  }
}
new Main();
module.exports = Main;
