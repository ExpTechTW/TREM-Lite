const Config = require('../core/config');

class CheckBox {
  constructor() {
    this.instance = Config.getInstance();
    this.config = this.instance.getConfig();

    this.store = require('./main');
    this.bubble = new this.store();

    if (!this.config['check-box']) {
      this.config['check-box'] = {};
    }

    this.checkBoxes = document.querySelectorAll('.switch input');

    this.renderConfig();
    this.bindEvents();
  }

  renderConfig() {
    this.checkBoxes.forEach((checkbox) => {
      const id = checkbox.id;
      checkbox.checked = this.config['check-box'][id] ?? false;
    });
  }

  bindEvents() {
    this.checkBoxes.forEach((checkbox) => {
      checkbox.addEventListener('change', (event) => {
        const { checked, id } = event.target;

        this.config['check-box'][id] = checked;

        try {
          this.bubble.showBubble('success', 1500);
          this.instance.writeConfig(this.config);
        }
        catch (error) {
          console.error('Failed to save checkbox state:', error);
        }
      });
    });
  }
}

new CheckBox();
