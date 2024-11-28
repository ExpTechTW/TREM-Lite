class PluginList {
  constructor() {
    this.extendedElement = '';
    this.enablePluginList = ['websocket'];
    this.pluginList = JSON.parse(localStorage.getItem('loaded-plugins'));
    this.extendedInfo = document.querySelector('.extended-info');
    this.init();
  }

  init() {
    this.pluginList.forEach((item) => {
      if (item) {
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
                  <span class="">${item.author[0]}</span>
                  <span class="extended-version">${item.version}</span>
                </div>
              </div>  
              </div>
              <div class="extended-list-description-box">
                <span class="extended-list-description">${item.description['zh_tw']}</span>
              </div>
            </div>
            <div class="extended-list-buttons">
              <label class="switch">
                <input type="checkbox">
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
}
new PluginList();
