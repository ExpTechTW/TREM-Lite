class PluginList {
  constructor() {
    this.pluginManagerStore = require('../core/manager');
    this.extendedElement = '';
    this.enablePluginList = JSON.parse(localStorage.getItem('enabled-plugins'));
    this.pluginList = JSON.parse(localStorage.getItem('plugin-list'));
    this.extendedInfo = document.querySelector('.extended-info');
    this.init();
    this.addToggleClick();
  }

  init() {
    if (!this.pluginList || (this.pluginList && this.pluginList.length == 0)) {
      return;
    }
    this.pluginList.forEach((item) => {
      if (item) {
        const isEnabled = this.enablePluginList.includes(item.name);

        this.extendedElement += `
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
      }
    });
    this.extendedInfo.innerHTML = this.extendedElement;
  }

  addToggleClick() {
    this.extendedInfo.addEventListener('click', (event) => {
      if (event.target.classList.contains('slider')) {
        const checkbox = event.target.previousElementSibling;
        if (checkbox) {
          this.setExtendedState(checkbox);
        }
      }
    });
  }

  setExtendedState(checkbox) {
    const pluginInfo = {
      name: checkbox.dataset.name,
      enabled: checkbox.checked,
    };
    if (pluginInfo.enabled) {
      this.pluginManagerStore.disable(pluginInfo.name);
      this.enablePluginList = this.enablePluginList.filter((name) => name !== pluginInfo.name);
    }
    else {
      this.pluginManagerStore.enable(pluginInfo.name);
      if (!this.enablePluginList.includes(pluginInfo.name)) {
        this.enablePluginList.push(pluginInfo.name);
      }
    }
    localStorage.setItem('enabled-plugins', JSON.stringify(this.enablePluginList));
  }
}

new PluginList();
