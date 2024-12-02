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
    if (!this.messageContent || !this.messageBox) {
      console.error('Message elements not found');
      return;
    }
    this.messageBox.classList.add(message);
    this.messageContent.classList.add(message);
    setTimeout(() => {
      this.messageContent.classList.remove(message);
    }, duration);
  }

  info() {
    this.version.textContent = app.getVersion();
    this.os.textContent = `${os.version()} (${os.release()})`;
    this.cpu.textContent = os.cpus()[0].model;
  }
}
new Main();
module.exports = Main;
