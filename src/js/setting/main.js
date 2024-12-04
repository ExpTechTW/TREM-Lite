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
