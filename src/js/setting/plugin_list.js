const TREM = require('./constant');
const manager = require('../core/manager');
const PluginLoader = require('../core/plugin').default;
const { ipcRenderer } = require('electron');
const fs = require('fs-extra');
const store = require('./main');
const bubble = new store();
const fetchData = require('../core/utils/fetch');

const pluginStore = document.querySelector('.extended-store-list .extended-info');

class PluginList {
  constructor() {
    this.enablePluginList = JSON.parse(localStorage.getItem('enabled-plugins')) || [];
    this.pluginList = JSON.parse(localStorage.getItem('plugin-list')) || [];
    this.loadedPlugins = JSON.parse(localStorage.getItem('loaded-plugins')) || [];
    this.extendedInfo = document.querySelector('.extended-info');
    this.extendedConfirmWrapper = document.querySelector('.confirm-wrapper');
    this.ConfirmSure = this.extendedConfirmWrapper.querySelector('.confirm-sure');
    this.ConfirmTitle = this.extendedConfirmWrapper.querySelector('.confirm-title');
    this.extendedTopButton = document.querySelectorAll('.extended-list-button');
    this.extendedWrapper = document.querySelectorAll('.extended .setting-option');
    this.storeData = [];
    this.lastState = null;
    this.lastTarget = null;
    this.lastBox = null;
    this.countdown = null;
    this.interval = null;
    this.pluginStoreList = '';
    this.init();
    this.addToggleClick();
    this.renderElements();
    this.hotKey();
  }

  init() {
    this.extendedConfirmWrapper.addEventListener('click', (event) => {
      if (!this.extendedConfirmWrapper.classList.contains('extendedOpen')) {
        return;
      }
      const { classList } = event.target;
      if (classList.contains('confirm-sure')) {
        this.setExtendedState();
      }
      else if (classList.contains('confirm-cancel')) {
        this.checkExtendedState();
      }
    });

    this.getPluginInfo();
  }

  async getPluginInfo() {
    const last_time = localStorage.getItem('store-time') ?? 0;

    this.storeData = JSON.parse(localStorage.getItem('store-data') ?? '[]');

    if (Date.now() - last_time > 600000) {
      const ans = await fetchData('https://raw.githubusercontent.com/ExpTechTW/trem-plugins/refs/heads/main/data/repository_stats.json', TREM.constant.HTTP_TIMEOUT.PLUGIN_INFO);
      if (ans && ans.ok) {
        const res = await ans.json();

        this.storeData = res;

        localStorage.setItem('store-time', Date.now());
        localStorage.setItem('store-data', JSON.stringify(res));
      }
    }

    this.createPluginStoreList();
  }

  createPluginStoreList() {
    this.storeData.forEach((item) => {
      const local_item = this.pluginList.find((_) => _.name == item.name);
      let button = '';
      if (!item.repository.releases.releases.length) {
        button = 'none';
      }
      else if (!local_item) {
        button = 'download';
      }
      else if (item.version != local_item.version && PluginLoader.getInstance().compareVersions(item.version, local_item.version)) {
        button = 'update';
      }
      else {
        button = 'latest';
      }
      const newItem = this.renderPluginItem(item, true, button);
      this.pluginStoreList += newItem;
    });

    document.addEventListener('click', (e) => {
      if (e.target.id?.startsWith('extended-download-button.')) {
        const pluginName = e.target.id.split('.')[1];

        const new_item = this.storeData.find((_) => _.name == pluginName);

        if (new_item) {
          PluginLoader.getInstance().downloadPlugin(pluginName, `https://github.com/${new_item.repository.full_name}/releases/download/${new_item.repository.releases.releases[0].tag_name}/${pluginName}.trem`);
        }
      }
    });

    pluginStore.innerHTML = this.pluginStoreList;
  }

  hotKey() {
    document.onmousedown = (e) => {
      if (e.button === 2) {
        if (this.ConfirmSure) {
          this.ConfirmSure.classList.add('open');
        }
      }
    };

    document.onmouseup = (e) => {
      if (e.button === 2) {
        if (this.ConfirmSure) {
          this.ConfirmSure.classList.remove('open');
        }
      }
    };
  }

  getPluginLoadStatus(pluginName) {
    if (Array.isArray(this.loadedPlugins)) {
      return this.loadedPlugins.map((_) => _.name).includes(pluginName);
    }
    return this.loadedPlugins[pluginName] !== undefined;
  }

  renderElements() {
    if (!this.pluginList?.length) {
      this.extendedInfo.innerHTML = '';
      return;
    }

    const elements = this.pluginList
      .filter((item) => item)
      .map((item) => this.renderPluginItem(item, false))
      .join('');

    this.extendedInfo.innerHTML = elements;
    this.attachEventListeners();
  }

  getWaveClassName(item, isEnabled, isLoaded) {
    if (!isEnabled) {
      return '';
    }
    if (!isLoaded) {
      return 'wave-unloaded';
    }
    if (!item.verified) {
      return 'wave-unverified';
    }
    return '';
  }

  renderStatusBadges(item, isEnabled, isLoaded) {
    const badges = [];

    badges.push(!item.verified ? '<span class="unverified-badge"></span>' : '<span class="verified-badge"></span>');

    if (isEnabled) {
      badges.push(isLoaded
        ? '<span class="loaded-badge"></span>'
        : '<span class="unloaded-badge"></span>',
      );
    }

    return badges.join('');
  }

  renderPluginItem(item, type, btn) {
    const isEnabled = !type ? this.enablePluginList.includes(item.name) : '';
    const isLoaded = !type ? this.getPluginLoadStatus(item.name) : '';
    const waveClassName = !type ? this.getWaveClassName(item, isEnabled, isLoaded) : '';
    const statusBadges = !type ? this.renderStatusBadges(item, isEnabled, isLoaded) : '';

    const is_config_exist = fs.existsSync(`${item.path}/config.yml`);

    return `
        <div class="wave-container ${waveClassName}" id="plugin-${this.escapeHtml(item.name)}">
          <div class="setting-option">
            <div class="extended-list">
              <div class="extended-list-box">
                <div class="extended-list-left">
                  <div class="extended-list-title-box">
                    <span class="plugin-list-title">${this.escapeHtml(item.name)}</span>
                    <div class="status-box">${statusBadges}</div>
                  </div>
                  <div class="extended-list-author-version">
                    <div class="author">
                      <span class="author-name">${this.escapeHtml(item.author[0])}</span>
                      <span class="extended-version">${this.escapeHtml(item.version)}</span>
                    </div>
                  </div>  
                </div>
                <div class="extended-list-description-box">
                  <span class="extended-list-descriptions">${this.escapeHtml(item.description?.zh_tw || '')}</span>
                </div>
              </div>
              ${!type
                ? `<div class="extended-list-buttons">
                <label class="switch">
                  <input type="checkbox" 
                    data-name="${this.escapeHtml(item.name)}" 
                    data-author="${this.escapeHtml(item.author[0])}" 
                    data-version="${this.escapeHtml(item.version)}"
                    data-verified="${item.verified}"
                    data-loaded="${isLoaded}"
                    ${isEnabled ? 'checked' : ''}>
                  <div class="slider round"></div>
                </label>
                ${is_config_exist ? `<div id="extended-setting-button.${this.escapeHtml(item.name)}" class="extended-setting-button"></div>` : ''}
              </div>`
                : `<div class="extended-list-buttons">
                  <div id="extended-download-button.${this.escapeHtml(item.name)}" class="extended-${btn}-button"></div>
              </div>`}
            </div>
          </div>
        </div>
      `;
  }

  escapeHtml(str) {
    if (!str) {
      return '';
    }
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  attachEventListeners() {
    this.pluginList.forEach((item) => {
      if (!item) {
        return;
      }

      const settingButton = document.getElementById(`extended-setting-button.${item.name}`);
      if (settingButton) {
        settingButton.replaceWith(settingButton.cloneNode(true));

        document.getElementById(`extended-setting-button.${item.name}`)
          .addEventListener('click', () => {
            ipcRenderer.send('open-yaml-editor', `${item.path}/config.yml`);
          });
      }
    });
  }

  addToggleClick() {
    this.extendedInfo.addEventListener('click', (event) => {
      if (!event.target.classList.contains('slider')) {
        return;
      }
      const checkbox = event.target.previousElementSibling;
      if (checkbox.disabled) {
        return;
      }

      this.lastState = checkbox.checked;
      this.lastTarget = event.target;

      const isVerified = checkbox.dataset.verified === 'true';
      if (!checkbox.checked && !isVerified) {
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
    this.extendedTopButton.forEach((item) => {
      item.addEventListener('click', (event) => {
        const targetClass = event.currentTarget.getAttribute('for');
        const relatedElements = document.querySelector(`.${targetClass}`);

        this.extendedTopButton.forEach((btn) => {
          btn.classList.remove('active');
        });

        this.extendedWrapper.forEach((btn) => {
          btn.classList.remove('show');
        });

        event.currentTarget.classList.add('active');
        relatedElements.classList.add('show');
      });
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
    if (!checkbox || checkbox.disabled) {
      return;
    }
    const pluginName = checkbox.dataset.name;
    const isEnabled = this.lastState;

    if (isEnabled) {
      manager.disable(pluginName);
      this.enablePluginList = this.enablePluginList.filter((name) => name !== pluginName);
    }
    else {
      manager.enable(pluginName);
      if (!this.enablePluginList.includes(pluginName)) {
        this.enablePluginList.push(pluginName);
      }
    }
    localStorage.setItem('enabled-plugins', JSON.stringify(this.enablePluginList));
    this.hideConfirmWrapper();
    bubble.showBubble('success', 3000);
  }

  hideConfirmWrapper() {
    this.extendedConfirmWrapper.classList.remove('extendedOpen');
    this.extendedConfirmWrapper.style.bottom = '-100%';
    this.ConfirmTitle.textContent = '';
    clearInterval(this.interval);
  }
}

new PluginList();
