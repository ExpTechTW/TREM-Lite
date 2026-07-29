const os = require('node:os');
const { app } = require('@electron/remote');
const { ipcRenderer } = require('electron');
const Config = require('../core/config');
const { RELAY_URL } = require('../core/phoneRelayConfig');
const QRCode = require('qrcode');

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

    const simulateEewBtn = document.getElementById('simulate-eew-button');
    if (simulateEewBtn) {
      simulateEewBtn.addEventListener('click', () => {
        ipcRenderer.send('simulate-eew');
        this.showBubble('success', 1500);
      });
    }

    this.initPhoneSeismometer();
    this.initPhoneRelay();

    this.setupUpdateListeners();
    this.initapiProxyDomain();
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

  initapiProxyDomain() {
    const input = document.getElementById('api-proxy-domain-input');
    const resetBtn = document.getElementById('api-proxy-domain-reset');
    const DEFAULT_DOMAIN = 'api.lb.exptech.dev';

    if (input && resetBtn) {
      const configInstance = Config.getInstance();
      const updateValue = () => {
        const config = configInstance.getConfig();
        input.value = config.apiProxyDomain || DEFAULT_DOMAIN;
      };
      updateValue();

      input.addEventListener('change', () => {
        const config = configInstance.getConfig();
        // 若使用者清空輸入框，則自動填回預設值
        config.apiProxyDomain = input.value.trim() || DEFAULT_DOMAIN;
        input.value = config.apiProxyDomain;
        configInstance.writeConfig(config);
        this.showBubble('success', 1500);
      });

      resetBtn.addEventListener('click', () => {
        const config = configInstance.getConfig();
        config.apiProxyDomain = DEFAULT_DOMAIN;
        configInstance.writeConfig(config);
        input.value = DEFAULT_DOMAIN;
        this.showBubble('success', 1500);
      });
    }
  }

  initPhoneSeismometer() {
    const checkbox = document.getElementById('phone-seismometer-enabled');
    const remoteCheckbox = document.getElementById('phone-seismometer-remote-enabled');
    const regenerateBtn = document.getElementById('phone-seismometer-regenerate-button');
    const status = document.getElementById('phone-seismometer-status');
    const qrImg = document.getElementById('phone-seismometer-qr');
    const qrHint = document.getElementById('phone-seismometer-qr-hint');
    if (!checkbox || !status) {
      return;
    }

    const TUNNEL_STATUS_TEXT = {
      connecting: '穿透連線中…',
      error: '穿透連線失敗',
    };

    // 跨網路穿透（cloudflared Quick Tunnel）沒有帳號/網域就沒辦法固定網址，每次
    // 重新連線都會換一個新的隨機網址，手動打字很麻煩，所以用 QR Code 讓手機直接
    // 掃碼開啟，掃碼比每次找新網址重打方便。優先顯示跨網路網址（比較常變動、
    // 掃碼的意義比較大），沒開跨網路連線的話就顯示區網網址。
    const updateQrCode = async (result) => {
      if (!qrImg || !qrHint) {
        return;
      }
      const targetUrl = (remoteCheckbox?.checked && result.tunnel.status === 'connected' && result.tunnel.url)
        ? result.tunnel.url
        : result.urls[0];

      if (!targetUrl) {
        qrImg.style.display = 'none';
        qrHint.style.display = 'none';
        return;
      }

      try {
        qrImg.src = await QRCode.toDataURL(targetUrl, { margin: 1, width: 160 });
        qrImg.style.display = 'block';
        qrHint.style.display = 'block';
      }
      catch (error) {
        console.error('Failed to generate QR code:', error);
      }
    };

    const refreshStatus = async () => {
      const result = await ipcRenderer.invoke('phone-server:get-status');
      if (!result || !result.running) {
        status.textContent = '';
        if (qrImg) {
          qrImg.style.display = 'none';
        }
        if (qrHint) {
          qrHint.style.display = 'none';
        }
        return result;
      }

      const urls = result.urls.length ? result.urls.join('\n') : '尚未偵測到區網 IP，請確認已連上 Wi-Fi';
      let text = `手機用瀏覽器連到以下網址（同一個 Wi-Fi）：\n${urls}`;

      if (remoteCheckbox && remoteCheckbox.checked) {
        if (result.tunnel.status === 'connected' && result.tunnel.url) {
          text += `\n\n跨網路（行動網路也可以）連到：\n${result.tunnel.url}`;
        }
        else if (result.tunnel.status === 'error') {
          text += `\n\n${TUNNEL_STATUS_TEXT.error}${result.tunnel.error ? `：${result.tunnel.error}` : ''}`;
        }
        else {
          text += `\n\n${TUNNEL_STATUS_TEXT.connecting}`;
        }
      }

      text += '\n（首次連線瀏覽器會顯示「不安全」警告，點選繼續前往即可）';
      status.textContent = text;
      await updateQrCode(result);
      return result;
    };

    // 起 tunnel 是非同步的（要連外部的穿透伺服器），不會在勾選當下就有網址，
    // 這裡短時間內多輪詢幾次，看到 connected/error（不再是 connecting）就停手，
    // 不要無限一直打 IPC。
    const pollStatus = async (times = 8, delay = 1000) => {
      for (let i = 0; i < times; i++) {
        const result = await refreshStatus();
        if (!result?.running || !remoteCheckbox?.checked || result.tunnel.status !== 'connecting') {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    };

    checkbox.addEventListener('change', () => {
      setTimeout(() => pollStatus(), 500);
    });

    if (remoteCheckbox) {
      remoteCheckbox.addEventListener('change', () => {
        setTimeout(() => pollStatus(), 500);
      });
    }

    if (regenerateBtn) {
      regenerateBtn.addEventListener('click', async () => {
        await ipcRenderer.invoke('phone-server:regenerate-token');
        await refreshStatus();
        this.showBubble('success', 1500);
      });
    }

    if (checkbox.checked) {
      pollStatus();
    }
  }

  // 全球手機測站中繼網路：跟本機手機伺服器（LAN/穿透）是不同的東西，開了這個開關
  // 不需要自己也有手機連著，單純只是「要不要接上、看別人回報的測站」，所以這裡
  // 獨立輪詢中繼網址顯示目前連線狀態/測站數，不依賴 initPhoneSeismometer() 那邊的邏輯。
  initPhoneRelay() {
    const checkbox = document.getElementById('phone-relay-enabled');
    const status = document.getElementById('phone-relay-status');
    if (!checkbox || !status) {
      return;
    }

    let pollTimer = null;

    const refreshStatus = async () => {
      if (!checkbox.checked) {
        status.textContent = '';
        return;
      }
      try {
        const res = await fetch(RELAY_URL);
        const body = await res.json();
        const count = body?.stations?.length ?? 0;
        status.textContent = `已連上全球手機測站網路（原型功能），目前共 ${count} 個測站在回報\n（這是公開分享的資料，任何 TREM-Lite 使用者都看得到）`;
      }
      catch {
        status.textContent = '連線中繼伺服器失敗，稍後會自動重試';
      }
    };

    const startPolling = () => {
      stopPolling();
      refreshStatus();
      pollTimer = setInterval(refreshStatus, 5000);
    };

    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        startPolling();
      }
      else {
        stopPolling();
        status.textContent = '';
      }
    });

    if (checkbox.checked) {
      startPolling();
    }
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
