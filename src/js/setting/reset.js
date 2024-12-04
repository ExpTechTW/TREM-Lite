const Config = require('../core/config');
const { ipcRenderer } = require('electron');

class Reset {
  constructor() {
    this.data = null;
    this.store = require('./main');
    this.bubble = new this.store();
    this.resetButton = document.querySelector('.reset-button');
    this.checkBoxes = document.querySelectorAll('.switch input');
    this.resetConfirmWrapper = document.querySelector('.confirm-wrapper');
    this.countdown = null;
    this.interval = null;
    this.init();
  }

  async init() {
    this.resetButton.addEventListener('click', () => {
      this.resetConfirmWrapper.classList.add('reset');
      this.resetConfirmWrapper.style.bottom = '0%';
      const confirmSureBtn = this.resetConfirmWrapper.querySelector('.confirm-sure');
      this.addCountDown(confirmSureBtn);
    });
    this.resetConfirmWrapper.addEventListener('click', (event) => {
      if (!this.resetConfirmWrapper.classList.contains('reset')) {
        return;
      }
      const { classList } = event.target;
      if (classList[0] == 'confirm-sure') {
        this.resetConfirmWrapper.style.bottom = '-100%';
        this.bubble.showBubble('success', 1500);
        Config.getInstance().resetConfig();
        setTimeout(() => {
          ipcRenderer.send('all-reload');
        }, 4000);
      }
      else if (classList[0] == 'confirm-cancel') {
        this.hideConfirmWrapper();
      }
    });
  }

  async resetSetting() {
    const resetConfig = {};
    [this.userLocation, this.realtimeStation].forEach((container) => {
      const current = container.querySelector('.current');
      if (current) {
        current.textContent = '';
      }
    });
    this.warningIntensity.forEach((element) => {
      element.className = element.className
        .split(' ')
        .filter((cls) => !cls.startsWith('intensity-'))
        .join(' ');
      element.classList.add('intensity-0');
    });
    this.checkBoxes.forEach((checkbox) => {
      checkbox.checked = false;
      resetConfig[checkbox.id] = false;
    });
    const res = await this.write({
      CHECKBOX: resetConfig,
      DROPDOWN: { 'realtime-int': 0, 'estimate-int': 0, 'location': null, 'station': null },
    });
    if (res.status === true) {
      this.resetConfirmWrapper.style.bottom = '-100%';
    }
  }

  addCountDown(confirmSureBtn) {
    this.countdown = 5;
    clearInterval(this.interval);
    confirmSureBtn.classList.add('disabled');
    confirmSureBtn.textContent = this.countdown;
    this.interval = setInterval(() => {
      this.countdown--;
      if (this.countdown > 0) {
        confirmSureBtn.textContent = this.countdown;
      }
      else {
        confirmSureBtn.textContent = '';
        confirmSureBtn.classList.remove('disabled');
        clearInterval(this.interval);
      }
    }, 1000);
  }

  hideConfirmWrapper() {
    this.resetConfirmWrapper.classList.remove('reset');
    this.resetConfirmWrapper.style.bottom = '-100%';
    clearInterval(this.interval);
  }
}
new Reset();
