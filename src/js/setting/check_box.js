class CheckBox {
  constructor() {
    this.checkBoxes = document.querySelectorAll('.switch input');
    this.config = require('./config');
    this.Instance = this.config.Instance;
    this.renderConfig();
    this.getSelected();
  }

  async renderConfig() {
    await this.Instance.init();
    const data = this.Instance.data.CHECKBOX;
    if (data) {
      Object.entries(data).forEach(([id, checked]) => {
        const checkbox = document.getElementById(id);
        if (checkbox) {
          checkbox.checked = checked;
        }
      });
    }
  }

  getSelected() {
    this.checkBoxes.forEach((checkbox) => {
      checkbox.addEventListener('change', (event) => {
        const { checked, id } = event.target;
        this.Instance.write({ CHECKBOX: { [id]: checked } })
          .catch((error) => console.error(error));
      });
    });
  }
}

new CheckBox();
