const { ipcRenderer } = require('electron');

class PluginList {
  constructor() {
    this.pluginManagerStore = require('../core/manager');
    this.enablePluginList = JSON.parse(localStorage.getItem('enabled-plugins')) || [];
    this.pluginList = JSON.parse(localStorage.getItem('plugin-list')) || [];
    this.extendedInfo = document.querySelector('.extended-info');
    this.extendedConfirmWrapper = document.querySelector('.confirm-wrapper');
    this.ConfirmSure = this.extendedConfirmWrapper.querySelector('.confirm-sure');
    this.ConfirmTitle = this.extendedConfirmWrapper.querySelector('.confirm-title');
    this.lastState = null;
    this.lastTarget = null;
    this.lastBox = null;
    this.countdown = null;
    this.interval = null;
    this.init();
    this.addToggleClick();
    this.renderElements();
  }

  init() {
    this.extendedConfirmWrapper.addEventListener('click', (event) => {
      const { classList } = event.target;
      if (classList.contains('confirm-sure')) {
        this.setExtendedState();
      }
      else if (classList.contains('confirm-cancel')) {
        this.checkExtendedState();
      }
    });
  }

  renderElements() {
    if (!this.pluginList.length) {
      return;
    }
    const elements = this.pluginList.map((item) => {
      if (!item) {
        return;
      }
      const isEnabled = this.enablePluginList.includes(item.name);
      return `
        <div class="setting-option">
          <div class="extended-list">
            <div class="extended-list-box">
            <div class="extended-list-left">
              <div class="extended-list-title-box">
                <span class="extended-list-title">${item.name}</span>
              </div>
              <div class="extended-list-author-version">
                <div class="author">
                  <span class="author-name">${item.author[0]}</span>
                  <span class="extended-version">${item.version}</span>
                </div>
              </div>  
              </div>
              <div class="extended-list-description-box">
                <span class="extended-list-descriptions">${item.description['zh_tw']}</span>
              </div>
            </div>
            <div class="extended-list-buttons">
              <label class="switch">
                <input type="checkbox" data-name="${item.name}" data-author="${item.author[0]}" data-version="${item.version}" ${isEnabled ? 'checked' : ''}>
                <div class="slider round"></div>
              </label>
              <div class="extended-setting-button"></div>
            </div>
          </div>
        </div>
        `;
    }).join('');
    this.extendedInfo.innerHTML = elements;
  }

  addToggleClick() {
    this.extendedInfo.addEventListener('click', (event) => {
      if (!event.target.classList.contains('slider')) {
        return;
      }
      const checkbox = event.target.previousElementSibling;
      this.lastState = checkbox.checked;
      this.lastTarget = event.target;
      if (!checkbox.checked) {
        setTimeout(() => {
          this.extendedConfirmWrapper.classList.add('extendedOpen');
          this.extendedConfirmWrapper.style.bottom = '0%';
          this.lastBox = checkbox;
          this.addCountDown(checkbox.dataset);
        }, 0);
      }
      else {
        this.setExtendedState();
      }
    });
  }

  checkExtendedState() {
    if (this.lastBox) {
      this.lastBox.checked = this.lastState;
    }
    this.hideConfirmWrapper();
  }

  addCountDown(dataset) {
    this.countdown = 10;
    clearInterval(this.interval);
    this.ConfirmSure.classList.add('disabled');
    this.ConfirmSure.textContent = this.countdown;
    this.ConfirmTitle.textContent = `${dataset.name}`;
    this.interval = setInterval(() => {
      this.countdown--;
      if (this.countdown > 0) {
        this.ConfirmSure.textContent = this.countdown;
      }
      else {
        this.ConfirmSure.textContent = '';
        this.ConfirmSure.classList.remove('disabled');
        clearInterval(this.interval);
      }
    }, 1000);
  }

  setExtendedState() {
    const checkbox = this.lastTarget?.previousElementSibling;
    if (!checkbox) {
      return;
    }
    const pluginName = checkbox.dataset.name;
    const isEnabled = this.lastState;
    if (isEnabled) {
      this.pluginManagerStore.disable(pluginName);
      this.enablePluginList = this.enablePluginList.filter((name) => name !== pluginName);
    }
    else {
      this.pluginManagerStore.enable(pluginName);
      if (!this.enablePluginList.includes(pluginName)) {
        this.enablePluginList.push(pluginName);
      }
    }
    localStorage.setItem('enabled-plugins', JSON.stringify(this.enablePluginList));
    ipcRenderer.send('all-reload');
    this.hideConfirmWrapper();
  }

  hideConfirmWrapper() {
    this.extendedConfirmWrapper.classList.remove('extendedOpen');
    this.extendedConfirmWrapper.style.bottom = '-100%';
    this.ConfirmTitle.textContent = '';
  }
}

new PluginList();
